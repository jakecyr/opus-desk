import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { run, githubUrl } from './core.js';
const json = async (execute, args) => JSON.parse(await execute('gh', args));
const git = (task, args, execute) => execute('git', ['-C', task.cwd, ...args]);
async function pendingReview(task, execute) {
  const target = githubUrl(task.url);
  const viewer = await json(execute, ['api', 'user']);
  if (!viewer.login) throw Error('Could not identify the GitHub user');
  const pages = await json(execute, [
    'api',
    '--paginate',
    '--slurp',
    'repos/' +
      target.repo +
      '/pulls/' +
      target.number +
      '/reviews?per_page=100',
  ]);
  return pages
    .flat()
    .find(
      (r) =>
        r.state === 'PENDING' &&
        r.user?.login?.toLowerCase() === viewer.login?.toLowerCase(),
    );
}
export async function collectPublication(task, execute = run) {
  const target = githubUrl(task.url);
  if (task.kind === 'review') {
    const review = await pendingReview(task, execute);
    if (!review)
      return { status: 'complete', note: 'No pending review to publish' };
    const comments = (
      await json(execute, [
        'api',
        '--paginate',
        '--slurp',
        'repos/' +
          target.repo +
          '/pulls/' +
          target.number +
          '/reviews/' +
          review.id +
          '/comments?per_page=100',
      ])
    ).flat();
    return {
      status: 'pending',
      type: 'review',
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            body: review.body,
            head: review.commit_id,
            comments,
          }),
        )
        .digest('hex'),
      reviewId: review.id,
      head: review.commit_id,
      body: review.body || '',
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line || c.original_line,
        body: c.body,
        url: c.html_url,
      })),
      title: 'Publish draft review',
      summary: comments.length + ' draft comments',
    };
  }
  if (task.kind === 'describe') {
    const body = (await fs.readFile(task.artifact, 'utf8')).trim();
    if (!body || body.length > 60000)
      throw Error('The agent did not prepare a valid description');
    return {
      status: 'pending',
      type: 'description',
      title: 'Update issue description',
      summary: 'Review the generated description',
      body,
    };
  }
  const head = (await git(task, ['rev-parse', 'HEAD'], execute)).trim();
  const dirty = (await git(task, ['status', '--porcelain'], execute)).trim();
  if (dirty)
    throw Error(
      'There are uncommitted changes. Ask the agent to commit them locally before publishing.',
    );
  if (head === task.initialHead)
    return { status: 'complete', note: 'No new commit to publish' };
  if (task.kind === 'issue' && !/push|pull request/.test(task.outcome || ''))
    return { status: 'complete', note: 'Local work completed' };
  const summary = (
    await git(
      task,
      ['log', '--format=%h %s', task.initialHead + '..' + head],
      execute,
    )
  ).trim();
  const diff = await git(
    task,
    ['diff', '--no-ext-diff', '--no-textconv', task.initialHead + '..' + head],
    execute,
  );
  const branch = (
    await git(task, ['branch', '--show-current'], execute)
  ).trim();
  let pr = null,
    metadata = null;
  if (target.kind === 'pull') {
    pr = await json(execute, [
      'pr',
      'view',
      task.url,
      '--json',
      'headRefName,headRefOid,headRepository,headRepositoryOwner,title',
    ]);
    await git(
      task,
      ['merge-base', '--is-ancestor', pr.headRefOid, head],
      execute,
    );
  } else {
    await git(task, ['check-ref-format', '--branch', branch], execute);
    if (['main', 'master', 'develop'].includes(branch))
      throw Error('Prepare a feature branch before publishing this issue');
    if (task.outcome?.includes('pull request')) {
      metadata = JSON.parse(await fs.readFile(task.artifact, 'utf8'));
      if (
        typeof metadata.title !== 'string' ||
        !metadata.title.trim() ||
        typeof metadata.body !== 'string' ||
        !metadata.body.trim()
      )
        throw Error('The agent did not prepare a PR title and description');
      if (metadata.base)
        await git(
          task,
          ['check-ref-format', '--branch', metadata.base],
          execute,
        );
    }
  }
  return {
    status: 'pending',
    type: 'code',
    title: metadata ? 'Push changes and open PR' : 'Push local commits',
    summary,
    head,
    branch,
    pr,
    metadata,
    diff: diff.slice(0, 200000),
    diffTruncated: diff.length > 200000,
  };
}
export async function publishPrepared(task, execute = run) {
  const target = githubUrl(task.url);
  if (task.status !== 'pending')
    throw Error('This task is not waiting for publishing approval');
  if (task.type === 'review') {
    const review = await pendingReview(task, execute);
    const fresh = await collectPublication(task, execute);
    const pr = await json(execute, [
      'pr',
      'view',
      task.url,
      '--json',
      'headRefOid',
    ]);
    if (
      !review ||
      review.id !== task.reviewId ||
      review.commit_id !== task.head ||
      pr.headRefOid !== task.head ||
      fresh.fingerprint !== task.fingerprint
    )
      throw Error(
        'The PR or draft review changed. Refresh the prepared review before publishing.',
      );
    // The user has now explicitly approved submitting this particular pending review.
    await execute('gh', [
      'api',
      '--method',
      'POST',
      'repos/' +
        target.repo +
        '/pulls/' +
        target.number +
        '/reviews/' +
        task.reviewId +
        '/events',
      '-f',
      'event=COMMENT',
    ]);
    return { url: task.url };
  }
  if (task.type === 'description') {
    const issue = await json(execute, [
      'issue',
      'view',
      task.url,
      '--json',
      'body',
    ]);
    if (issue.body?.trim())
      throw Error(
        'The issue already has a description. It was not overwritten.',
      );
    await fs.writeFile(task.artifact, task.body, { mode: 0o600 });
    await execute('gh', [
      'issue',
      'edit',
      task.url,
      '--body-file',
      task.artifact,
    ]);
    return { url: task.url };
  }
  if (task.type !== 'code') throw Error('Unknown publishing action');
  const head = (await git(task, ['rev-parse', 'HEAD'], execute)).trim();
  if (
    head !== task.head ||
    (await git(task, ['status', '--porcelain'], execute)).trim()
  )
    throw Error(
      'Local changes changed since preparation. Refresh before publishing.',
    );
  let remote = 'origin',
    branch = task.branch;
  if (task.pr) {
    const current = await json(execute, [
      'pr',
      'view',
      task.url,
      '--json',
      'headRefOid',
    ]);
    if (current.headRefOid !== task.pr.headRefOid)
      throw Error(
        'The PR has new commits. Re-run the agent before publishing.',
      );
    await git(
      task,
      ['merge-base', '--is-ancestor', task.pr.headRefOid, head],
      execute,
    );
    branch = task.pr.headRefName;
    const repository =
      task.pr.headRepositoryOwner?.login + '/' + task.pr.headRepository?.name;
    if (!/^[-\w.]+\/[-\w.]+$/.test(repository))
      throw Error('The PR source repository is unavailable');
    remote = 'git@github.com:' + repository + '.git';
  }
  await git(task, ['check-ref-format', '--branch', branch], execute);
  await git(task, ['push', remote, head + ':refs/heads/' + branch], execute);
  if (!task.metadata) return { url: task.url };
  const existing = await json(execute, [
    'pr',
    'list',
    '-R',
    target.repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'url',
  ]);
  if (existing[0]?.url) return { url: existing[0].url };
  const bodyFile = path.join(path.dirname(task.artifact), 'pr-body.md');
  await fs.writeFile(bodyFile, task.metadata.body, { mode: 0o600 });
  const args = [
    'pr',
    'create',
    '-R',
    target.repo,
    '--head',
    branch,
    '--title',
    task.metadata.title,
    '--body-file',
    bodyFile,
  ];
  if (task.metadata.base) args.push('--base', task.metadata.base);
  return { url: (await execute('gh', args)).trim() };
}
