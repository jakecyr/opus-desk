import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectPublication, publishPrepared } from '../server/publications.js';
import { jobPrompt } from '../server/core.js';
test('all agent workflows stop at preparation and never instruct automatic publication', () => {
  for (const kind of [
    'review',
    'conflicts',
    'ci',
    'comments',
    'issue',
    'describe',
  ]) {
    const prompt = jobPrompt(kind, 'https://github.com/a/b/issues/1', {
      auto: true,
      publish: true,
      outcome: 'implement, commit, push and create a pull request',
      artifact: '/tmp/proposal',
    });
    assert.match(prompt, /Do not (submit or publish|push)/);
    assert.doesNotMatch(prompt, /automatically publish/);
  }
});
test('pending review collection performs no writes; publishing checks for unseen draft edits and new PR commits', async () => {
  let text = 'Fix the edge case.',
    head = 'abc';
  const writes = [];
  const execute = async (_cmd, args) => {
    if (args.includes('--method')) {
      writes.push(args);
      return '{}';
    }
    if (args.at(-1) === 'user') return JSON.stringify({ login: 'me' });
    if (args[0] === 'pr') return JSON.stringify({ headRefOid: head });
    if (args.at(-1).includes('/comments?'))
      return JSON.stringify([[{ id: 2, path: 'a.js', line: 3, body: text }]]);
    return JSON.stringify([
      [
        {
          id: 1,
          state: 'PENDING',
          commit_id: 'abc',
          body: '',
          user: { login: 'me' },
        },
      ],
    ]);
  };
  const task = { kind: 'review', url: 'https://github.com/a/b/pull/1' };
  Object.assign(task, await collectPublication(task, execute));
  assert.equal(task.status, 'pending');
  assert.equal(writes.length, 0);
  text = 'Changed after preview';
  await assert.rejects(publishPrepared(task, execute), /changed/);
  assert.equal(writes.length, 0);
  Object.assign(task, await collectPublication(task, execute));
  head = 'new';
  await assert.rejects(publishPrepared(task, execute), /changed/);
  assert.equal(writes.length, 0);
  head = 'abc';
  await publishPrepared(task, execute);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes('event=COMMENT'));
});
test('code stays local until approval and refuses changed local commits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opusdesk-publish-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'work'),
    remote = path.join(dir, 'remote.git');
  const git = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--bare', '-q', remote);
  git('init', '-q', cwd);
  git('-C', cwd, 'config', 'user.name', 'Test');
  git('-C', cwd, 'config', 'user.email', 'test@example.com');
  git('-C', cwd, 'config', 'commit.gpgsign', 'false');
  git('-C', cwd, 'checkout', '-b', 'fix-issue');
  git('-C', cwd, 'remote', 'add', 'origin', remote);
  await fs.writeFile(path.join(cwd, 'file.txt'), 'before');
  git('-C', cwd, 'add', '.');
  git('-C', cwd, 'commit', '-qm', 'Baseline');
  const initialHead = git('-C', cwd, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(cwd, 'file.txt'), 'after');
  git('-C', cwd, 'commit', '-qam', 'Fix issue');
  const task = {
    kind: 'issue',
    url: 'https://github.com/a/b/issues/1',
    outcome: 'implement, commit and push',
    cwd,
    initialHead,
  };
  Object.assign(task, await collectPublication(task));
  assert.equal(task.status, 'pending');
  assert.equal(git('--git-dir', remote, 'rev-list', '--all', '--count'), '0');
  assert.match(task.diff, /after/);
  await publishPrepared(task);
  assert.equal(
    git('--git-dir', remote, 'rev-parse', 'refs/heads/fix-issue'),
    task.head,
  );
  await fs.writeFile(path.join(cwd, 'file.txt'), 'unseen');
  await assert.rejects(publishPrepared(task), /changed/);
});
test('description publishing never overwrites an existing body', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opusdesk-description-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const artifact = path.join(dir, 'description.md');
  await fs.writeFile(artifact, 'Proposed description');
  const task = {
    kind: 'describe',
    url: 'https://github.com/a/b/issues/1',
    artifact,
  };
  Object.assign(task, await collectPublication(task));
  let written = false;
  await assert.rejects(
    publishPrepared(task, async () =>
      JSON.stringify({ body: 'Someone already wrote this' }),
    ),
    /not overwritten/,
  );
  await publishPrepared(task, async (_cmd, args) => {
    if (args[1] === 'view') return '{"body":""}';
    written = true;
    assert.equal(
      await fs.readFile(args.at(-1), 'utf8'),
      'Proposed description',
    );
    return '';
  });
  assert.equal(written, true);
});
