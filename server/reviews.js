import { canonicalGithubUrl, githubUrl, run } from './core.js';

export function linkedIssueUrls(pr, repository, discussion = []) {
  const urls = new Set();
  for (const issue of pr.closingIssuesReferences || []) {
    try {
      if (githubUrl(issue.url).kind === 'issues')
        urls.add(canonicalGithubUrl(issue.url));
    } catch {}
  }
  const text = [pr.body || '', ...discussion.map((c) => c.body || '')].join(
    '\n',
  );
  for (const match of text.matchAll(
    /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/gi,
  )) {
    urls.add(canonicalGithubUrl(match[0]));
  }
  for (const match of text.matchAll(
    /(?:^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g,
  )) {
    urls.add(
      `https://github.com/${match[1] || repository}/issues/${Number(match[2])}`,
    );
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
  const issueUrls = linkedIssueUrls(pr, repo, [
    ...comments,
    ...reviews,
    ...inlineComments,
  ]);
  const issues = [];
  const unavailableIssues = [];
  // Bound concurrency without silently dropping linked issues.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, issueUrls.length) }, async () => {
      while (cursor < issueUrls.length) {
        const issueUrl = issueUrls[cursor++];
        const target = githubUrl(issueUrl);
        try {
          const issue = await json([
            'api',
            `repos/${target.repo}/issues/${target.number}`,
          ]);
          if (issue.pull_request) continue;
          const discussion = await pages(
            `repos/${target.repo}/issues/${target.number}/comments`,
          );
          issues.push({
            url: issueUrl,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            comments: discussion.map(comment),
          });
        } catch {
          unavailableIssues.push(issueUrl);
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
    unavailableIssues,
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
