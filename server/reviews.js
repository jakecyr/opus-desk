import { canonicalGithubUrl, githubUrl, run, getGithubHost } from './core.js';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

const referenceText = (pr, discussion) =>
  [pr.body || '', ...discussion.map((comment) => comment.body || '')].join(
    '\n',
  );

export function linkedIssueUrls(pr, repository, discussion = []) {
  const urls = new Set();
  for (const issue of pr.closingIssuesReferences || []) {
    try {
      if (githubUrl(issue.url).kind === 'issues')
        urls.add(canonicalGithubUrl(issue.url));
    } catch {}
  }
  const text = referenceText(pr, discussion);
  for (const match of text.matchAll(
    /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/issues\/\d+/gi,
  )) {
    try {
      urls.add(canonicalGithubUrl(match[0]));
    } catch {}
  }
  for (const match of text.matchAll(
    /(?:^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g,
  )) {
    urls.add(
      `https://${getGithubHost()}/${match[1] || repository}/issues/${Number(match[2])}`,
    );
  }
  return [...urls];
}

function linkedPullUrls(pr, discussion) {
  const urls = new Set();
  for (const match of referenceText(pr, discussion).matchAll(
    /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi,
  )) {
    try {
      urls.add(canonicalGithubUrl(match[0]));
    } catch {}
  }
  return [...urls];
}

export function hasSubmittedReview(reviews, login) {
  return (
    !!login &&
    reviews.some(
      (r) =>
        (r.user?.login || r.author?.login)?.toLowerCase() ===
          login.toLowerCase() &&
        ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(
          r.state,
        ),
    )
  );
}

export async function loadReviewContext(url, execute = run) {
  const { repo, number, kind } = githubUrl(url);
  if (kind !== 'pull') throw new Error('Expected a pull request URL');
  const json = async (args) => JSON.parse(await execute('gh', args));
  const pages = async (endpoint) =>
    (await json(['api', '--paginate', '--slurp', endpoint])).flat();
  const [pr, comments, reviews, inlineComments, viewer] = await Promise.all([
    json([
      'pr',
      'view',
      String(number),
      '-R',
      repo,
      '--json',
      'number,title,body,url,author,headRefOid,baseRefOid,headRefName,baseRefName,closingIssuesReferences',
    ]),
    pages(`repos/${repo}/issues/${number}/comments`),
    pages(`repos/${repo}/pulls/${number}/reviews`),
    pages(`repos/${repo}/pulls/${number}/comments`),
    json(['api', 'user']),
  ]);
  const discussion = [...comments, ...reviews, ...inlineComments];
  const linked = new Map();
  for (const issueUrl of linkedIssueUrls(pr, repo, discussion)) {
    const target = githubUrl(issueUrl);
    linked.set(`${target.repo.toLowerCase()}#${target.number}`, issueUrl);
  }
  for (const pullUrl of linkedPullUrls(pr, discussion)) {
    const target = githubUrl(pullUrl);
    linked.set(`${target.repo.toLowerCase()}#${target.number}`, pullUrl);
  }
  linked.delete(`${repo.toLowerCase()}#${number}`);
  const references = [...linked.values()];
  linked.set(`${repo.toLowerCase()}#${number}`, url);
  const issues = [];
  const unavailableIssues = [];
  const relatedPullRequests = [];
  const unavailablePullRequests = [];
  async function loadRelatedPullRequest(target, pullUrl) {
    try {
      const pull = await json([
        'api',
        `repos/${target.repo}/pulls/${target.number}`,
      ]);
      relatedPullRequests.push({
        url: pullUrl,
        title: pull.title,
        body: pull.body,
        state: pull.merged_at ? 'merged' : pull.state,
        mergedAt: pull.merged_at,
        mergeCommit: pull.merge_commit_sha,
        baseRef: pull.base?.ref,
        headCommit: pull.head?.sha,
      });
    } catch {
      unavailablePullRequests.push(pullUrl);
    }
  }
  // Bound concurrency without silently dropping linked issues.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, references.length) }, async () => {
      while (cursor < references.length) {
        const reference = references[cursor++];
        const target = githubUrl(reference);
        if (target.kind === 'pull') {
          await loadRelatedPullRequest(target, reference);
          continue;
        }
        try {
          const issue = await json([
            'api',
            `repos/${target.repo}/issues/${target.number}`,
          ]);
          if (issue.pull_request) {
            await loadRelatedPullRequest(
              target,
              `https://${getGithubHost()}/${target.repo}/pull/${target.number}`,
            );
            continue;
          }
          const discussion = await pages(
            `repos/${target.repo}/issues/${target.number}/comments`,
          );
          for (const relatedUrl of linkedPullUrls(issue, discussion)) {
            const related = githubUrl(relatedUrl);
            const key = `${related.repo.toLowerCase()}#${related.number}`;
            if (linked.has(key)) continue;
            linked.set(key, relatedUrl);
            references.push(relatedUrl);
          }
          issues.push({
            url: reference,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            comments: discussion.map(comment),
          });
        } catch {
          unavailableIssues.push(reference);
        }
      }
    }),
  );
  return {
    pullRequest: pr,
    comments: comments.map(comment),
    inlineComments: inlineComments.map((c) => ({
      ...comment(c),
      path: c.path,
      line: c.line,
      originalLine: c.original_line,
      diffHunk: c.diff_hunk,
      replyTo: c.in_reply_to_id,
    })),
    reviews: reviews.map((r) => ({
      id: r.id,
      author: r.user?.login,
      state: r.state,
      body: r.body,
      commit: r.commit_id,
      submittedAt: r.submitted_at,
    })),
    issues: issues.sort((a, b) => a.url.localeCompare(b.url)),
    unavailableIssues: unavailableIssues.sort(),
    relatedPullRequests: relatedPullRequests.sort((a, b) =>
      a.url.localeCompare(b.url),
    ),
    unavailablePullRequests: unavailablePullRequests.sort(),
    reviewedByMe: hasSubmittedReview(reviews, viewer.login),
  };
}

function comment(c) {
  return {
    id: c.id,
    author: c.user?.login,
    body: c.body,
    url: c.html_url,
    createdAt: c.created_at,
  };
}

export async function loadReviewState(url, execute = run) {
  const { repo, number, kind } = githubUrl(url);
  if (kind !== 'pull') throw new Error('Expected a pull request URL');
  const [pages, viewer] = await Promise.all([
    execute('gh', [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/pulls/${number}/reviews`,
    ]).then(JSON.parse),
    execute('gh', ['api', 'user']).then(JSON.parse),
  ]);
  return { reviewedByMe: hasSubmittedReview(pages.flat(), viewer.login) };
}

const maxArtifactBytes = 1024 * 1024;

export async function readReviewArtifact(file) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let artifact;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxArtifactBytes)
      throw Error('The review artifact must be a file smaller than 1 MB');
    const buffer = Buffer.alloc(stat.size + 1);
    const result = await handle.read({ buffer });
    if (result.bytesRead !== stat.size)
      throw Error('The review artifact changed while being read');
    artifact = JSON.parse(buffer.toString('utf8', 0, result.bytesRead));
  } finally {
    await handle.close();
  }
  if (
    !Array.isArray(artifact?.comments) ||
    artifact.comments.length > 30 ||
    (artifact.body !== undefined && !validBody(artifact.body, 8000))
  )
    throw Error('Invalid review artifact');

  const seen = new Set();
  const comments = artifact.comments.map((finding) => {
    if (!finding || typeof finding !== 'object')
      throw Error('Invalid inline review comment');
    const { path, line, start_line, body } = finding;
    if (
      typeof path !== 'string' ||
      path.length > 4096 ||
      // GitHub expects a printable repository-relative path.
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !validLine(line) ||
      (start_line !== undefined &&
        (!validLine(start_line) || start_line >= line)) ||
      !validBody(body, 12000) ||
      !body.trim()
    )
      throw Error('Invalid inline review comment');
    const key = JSON.stringify([path, line]);
    if (seen.has(key))
      throw Error('Review artifact contains duplicate comment locations');
    seen.add(key);
    return {
      path,
      line,
      side: 'RIGHT',
      ...(start_line !== undefined && { start_line, start_side: 'RIGHT' }),
      body: body.trim(),
    };
  });
  return { body: artifact.body?.trim() || '', comments };
}

function validLine(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

function validBody(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    !value.includes('\0')
  );
}
