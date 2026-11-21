import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('review turns use full context and enforce draft and live GitHub effects', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opusdesk-review-'));
  const bin = path.join(tmp, 'bin'),
    root = path.join(tmp, 'projects'),
    project = path.join(root, 'app');
  const dataDir = path.join(tmp, 'data'),
    staticRoot = path.join(tmp, 'static');
  for (const dir of [bin, project, dataDir, staticRoot])
    await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(staticRoot, 'index.html'), '<html></html>');
  await fs.writeFile(path.join(project, 'file.txt'), 'baseline');
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', [
    '-C',
    project,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'initial',
  ]);
  const localHead = () =>
    execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  const baseCommit = localHead();
  async function commitLine(line) {
    await fs.writeFile(path.join(project, 'file.txt'), line + '\n');
    execFileSync('git', [
      '-C',
      project,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qam',
      line,
    ]);
    return localHead();
  }
  const reviewCommit = await commitLine('changed line');
  const newCommit = await commitLine('new revision');
  execFileSync('git', [
    '-C',
    project,
    'remote',
    'add',
    'origin',
    'git@github.com:a/b.git',
  ]);
  await fs.writeFile(
    path.join(dataDir, 'state.json'),
    JSON.stringify({
      settings: {
        root,
        interval: 300,
        permission: 'sandbox',
        permissionMigrated: true,
      },
      links: {},
      archived: [],
    }),
  );
  const fixtureFile = path.join(tmp, 'fixture.json');
  const fixture = {
    auto: false,
    head: reviewCommit,
    base: baseCommit,
    fail: false,
    previouslyReviewed: true,
  };
  const updateFixture = () =>
    fs.writeFile(fixtureFile, JSON.stringify(fixture));
  await updateFixture();
  for (const tool of ['gh', 'codex', 'git']) {
    const target = path.join(bin, tool);
    await fs.copyFile(
      new URL('./fixtures/review-workflow-cli.js', import.meta.url),
      target,
    );
    await fs.chmod(target, 0o755);
  }
  const promptsFile = path.join(tmp, 'prompts.jsonl');
  const port = 46000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tmp,
      PATH: `${bin}:${process.env.PATH}`,
      OPUSDESK_DATA_DIR: dataDir,
      OPUSDESK_STATIC_ROOT: staticRoot,
      OPUSDESK_HOSTNAME: '127.0.0.1',
      PORT: String(port),
      REVIEW_FIXTURE: fixtureFile,
      REVIEW_PROMPTS: promptsFile,
      REVIEW_PROJECT: project,
      REVIEW_CALLS: path.join(tmp, 'calls.jsonl'),
      REVIEW_PUSHES: path.join(tmp, 'pushes.jsonl'),
      REVIEW_WRITES: path.join(tmp, 'writes.log'),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill();
    try {
      const host = JSON.parse(
        await fs.readFile(path.join(dataDir, 'agents/host.json'), 'utf8'),
      );
      process.kill(-host.pid, 'SIGTERM');
    } catch {
      /* No host started. */
    }
    await Promise.race([once(child, 'exit'), delay(3500)]);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/api`,
    headers = { 'Content-Type': 'application/json', 'X-PRQuay': 'local' };
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/health')).ok) break;
    } catch {}
    await delay(100);
  }
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const result = { status: r.status, body: await r.json() };
    if (p === '/job' && r.ok) {
      for (let i = 0; i < 100; i++) {
        const saved = JSON.parse(
          await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'),
        );
        const tasks = Object.values(saved.preparations || {});
        if (
          !tasks.some(
            (task) =>
              task.id === result.body.id &&
              ['running', 'collecting', 'publishing'].includes(task.status),
          )
        )
          break;
        await delay(20);
      }
    }
    return result;
  };
  const readLines = async (file) => {
    try {
      return (await fs.readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  };
  const prompts = () => readLines(promptsFile);
  const writes = () => readLines(path.join(tmp, 'writes.log'));
  const autoTasks = async () => {
    const state = JSON.parse(
      await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'),
    );
    return Object.values(state.preparations || {}).filter((task) => task.auto);
  };
  async function waitForAutoTask(
    index,
    status,
    requireError = status === 'pending',
  ) {
    let task;
    for (let i = 0; i < 150; i++) {
      task = (await autoTasks())[index];
      if (task?.status === status && (!requireError || task.error)) return task;
      await delay(40);
    }
    const details = await (await fetch(base + '/status')).json();
    assert.fail(
      `Expected Auto task ${index} to reach ${status}. Latest: ${JSON.stringify(task || details.autoRuns)}`,
    );
  }
  const status = await (await fetch(base + '/status')).json();
  assert.equal(status.settings.publishReviews, false);
  let r = await post('/job', {
    url: 'https://github.com/a/b/pull/7',
    kind: 'review',
    forceNew: true,
  });
  assert.equal(r.status, 200);
  let texts = await prompts();
  assert.match(texts[0], /^Re-review/);
  for (const expected of [
    'PR intent',
    'PR discussion',
    'Inline discussion',
    'Earlier feedback',
    'Acceptance criteria',
    'Issue discussion',
    'Do not submit or publish',
  ])
    assert.ok(texts[0].includes(expected), expected);
  assert.equal(
    (await post('/settings', { publishReviews: 'true' })).status,
    400,
  );
  await post('/settings', {
    publishReviews: false,
    reviewTone: 'direct',
    reviewScope: 'blocking',
    reviewPreferences: 'Check migrations.',
  });
  r = await post('/job', {
    url: 'https://github.com/a/b/pull/7',
    kind: 'review',
    forceNew: true,
  });
  assert.equal(r.status, 200);
  texts = await prompts();
  assert.match(texts[1], /Do not submit or publish/);
  assert.match(texts[1], /Check migrations\./);
  assert.match(texts[1], /direct and matter-of-fact/);
  await post('/settings', { publishReviews: false, reviewPreferences: '  ' });
  fixture.fail = true;
  await updateFixture();
  assert.equal(
    (
      await post('/job', {
        url: 'https://github.com/a/b/pull/7',
        kind: 'review',
        forceNew: true,
      })
    ).status,
    400,
  );
  assert.equal((await prompts()).length, 2);
  fixture.fail = false;
  fixture.auto = true;
  fixture.previouslyReviewed = false;
  await updateFixture();
  await post('/auto', { enabled: true });
  const draft = await waitForAutoTask(0, 'complete');
  assert.equal(draft.action, 'review');
  texts = await prompts();
  assert.equal(texts.length, 3);
  assert.match(
    texts[2],
    /Do not create draft reviews, submit or publish reviews/,
  );
  assert.match(
    texts[2],
    /git diff refs\/opusdesk\/base\.\.\.refs\/opusdesk\/head/,
  );
  assert.doesNotMatch(texts[2], /Additional review preferences/);
  const automaticallyStartedTurns = (
    await readLines(path.join(tmp, 'calls.jsonl'))
  ).filter(
    (call) => call.method === 'turn/start' && call.params.threadId === draft.id,
  );
  assert.equal(automaticallyStartedTurns.length, 1);
  assert.equal(
    automaticallyStartedTurns[0].params.sandboxPolicy.networkAccess,
    false,
  );
  let requests = await writes();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].args.includes('repos/a/b/pulls/7/reviews'));
  assert.equal(requests[0].body.commit_id, reviewCommit);
  assert.equal(
    requests[0].body.event,
    undefined,
    'omit event for a pending GitHub review',
  );
  assert.match(
    requests[0].body.comments[0].body,
    /```suggestion\ncomplete\n```/,
  );
  await post('/github/refresh', {});
  assert.equal((await autoTasks()).length, 1);
  assert.equal((await writes()).length, 1);

  assert.equal((await post('/settings', { publishReviews: true })).status, 400);
  assert.equal(
    (
      await post('/settings', {
        autoActions: { rereview: 'publish' },
        workflows: {
          rereview: { agent: 'codex', model: 'review-model', effort: 'high' },
        },
      })
    ).status,
    200,
  );
  fixture.previouslyReviewed = true;
  fixture.response = '2026-01-03T00:00:00Z';
  await updateFixture();
  await post('/github/refresh', {});
  const live = await waitForAutoTask(1, 'published');
  assert.equal(live.action, 'rereview');
  texts = await prompts();
  assert.equal(texts.length, 4);
  assert.match(texts[3], /^Re-review/);
  assert.match(texts[3], /later replies even if the head is unchanged/);
  requests = await writes();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.event, 'COMMENT');
  assert.equal(requests[1].body.commit_id, reviewCommit);
  assert.deepEqual(requests[1].body.comments, requests[0].body.comments);
  const rereviewCalls = await readLines(path.join(tmp, 'calls.jsonl'));
  assert.ok(
    rereviewCalls.some(
      (call) =>
        call.method === 'thread/start' && call.params.model === 'review-model',
    ),
  );
  assert.ok(
    rereviewCalls.some(
      (call) =>
        call.method === 'turn/start' &&
        call.params.threadId === live.id &&
        call.params.effort === 'high',
    ),
  );

  fixture.response = '2026-01-04T00:00:00Z';
  fixture.stale = true;
  await updateFixture();
  await post('/github/refresh', {});
  const stale = await waitForAutoTask(2, 'pending');
  assert.match(stale.error, /PR changed/);
  assert.equal((await writes()).length, 2);
  await post('/approvals/' + stale.key + '/dismiss', {});

  fixture.response = '2026-01-05T00:00:00Z';
  fixture.stale = false;
  fixture.pending = true;
  fixture.latePending = true;
  await updateFixture();
  await post('/github/refresh', {});
  const existing = await waitForAutoTask(3, 'pending');
  assert.match(existing.error, /pending GitHub review exists/);
  assert.equal((await writes()).length, 2);
  await post('/approvals/' + existing.key + '/dismiss', {});

  fixture.response = '2026-01-06T00:00:00Z';
  fixture.pending = false;
  fixture.latePending = false;
  fixture.delay = 1000;
  await updateFixture();
  await post('/github/refresh', {});
  await waitForAutoTask(4, 'running');
  await post('/auto', { enabled: false });
  const stopped = await waitForAutoTask(4, 'pending', false);
  assert.equal(stopped.automaticEffect, undefined);
  assert.equal((await writes()).length, 2);
  await post('/approvals/' + stopped.key + '/dismiss', {});

  fixture.previouslyReviewed = false;
  fixture.response = undefined;
  fixture.head = newCommit;
  await updateFixture();
  await post('/auto', { enabled: true });
  await waitForAutoTask(5, 'running');
  fixture.withdrawn = true;
  await updateFixture();
  const withdrawn = await waitForAutoTask(5, 'pending');
  assert.match(withdrawn.error, /review request or its latest replies changed/);
  assert.equal((await writes()).length, 2);
  await post('/auto', { enabled: false });

  fixture.auto = false;
  fixture.pending = true;
  fixture.delay = 0;
  await updateFixture();
  r = await post('/job', {
    url: 'https://github.com/a/b/pull/7',
    kind: 'review',
    forceNew: true,
  });
  assert.equal(r.status, 200);
  let pending;
  for (let i = 0; i < 80; i++) {
    const tasks = (await (await fetch(base + '/approvals')).json()).tasks;
    pending = tasks.find((t) => t.id === r.body.id && t.status === 'pending');
    if (pending) break;
    await delay(40);
  }
  assert.ok(pending, 'finished review waits for human approval');
  const preview = await (
    await fetch(base + '/approvals/' + pending.key)
  ).json();
  assert.equal(preview.comments[0].body, 'Check the edge case.');
  assert.equal((await writes()).length, 2);
  const published = await post('/approvals/' + pending.key + '/publish', {});
  assert.equal(published.status, 200);
  assert.match(
    await fs.readFile(path.join(tmp, 'writes.log'), 'utf8'),
    /event=COMMENT/,
  );
  assert.equal(
    (await post('/approvals/' + pending.key + '/publish', {})).status,
    400,
  );
  assert.equal(
    (
      await post('/issues/comment', {
        url: 'https://github.com/a/b/pull/7',
        body: 'bad target',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post('/issues/comment', {
        url: 'https://github.com/a/b/issues/5',
        body: '  Thanks, I will check.  ',
      })
    ).status,
    200,
  );
  assert.match(
    await fs.readFile(path.join(tmp, 'writes.log'), 'utf8'),
    /Thanks, I will check\./,
  );
  // Fix CI reuses the existing PR chat and pushes to its fork's exact head branch.
  fixture.head = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  await updateFixture();
  const ci = await post('/job', {
    url: 'https://github.com/a/b/pull/7',
    kind: 'ci',
    pushOnCompletion: true,
  });
  assert.equal(ci.status, 200);
  assert.equal(ci.body.id, r.body.id, 'reuse the linked review chat');
  let ciTask;
  for (let i = 0; i < 100; i++) {
    const state = JSON.parse(
      await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'),
    );
    ciTask = Object.values(state.preparations).find(
      (task) => task.kind === 'ci',
    );
    if (ciTask && ['published', 'failed'].includes(ciTask.status)) break;
    await delay(40);
  }
  assert.equal(ciTask?.status, 'published', ciTask?.error);
  const pushes = (await fs.readFile(path.join(tmp, 'pushes.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].slice(2), [
    'push',
    'git@github.com:contributor/fork.git',
    ciTask.head + ':refs/heads/fix-ci',
  ]);
  const calls = (await fs.readFile(path.join(tmp, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.ok(
    calls.some(
      (call) =>
        call.method === 'thread/resume' && call.params.threadId === ci.body.id,
    ),
  );
  fixture.head = ciTask.head;
  await updateFixture();
  const fresh = await post('/job', {
    url: 'https://github.com/a/b/pull/7',
    kind: 'ci',
    pushOnCompletion: true,
    forceNew: true,
  });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.id, ci.body.id);
  let freshTask;
  for (let i = 0; i < 100; i++) {
    const state = JSON.parse(
      await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'),
    );
    freshTask = Object.values(state.preparations).find(
      (task) => task.id === fresh.body.id,
    );
    if (freshTask && ['published', 'failed'].includes(freshTask.status)) break;
    await delay(40);
  }
  assert.equal(freshTask?.status, 'published', freshTask?.error);
  fixture.head = freshTask.head;
  await updateFixture();
  const unrelated = path.join(freshTask.cwd, 'unrelated.txt');
  await fs.writeFile(unrelated, 'Keep this unfinished work');
  const cleanRetry = await post('/job', {
    url: 'https://github.com/a/b/pull/7',
    kind: 'ci',
    pushOnCompletion: true,
  });
  assert.equal(cleanRetry.status, 200);
  assert.notEqual(
    cleanRetry.body.id,
    fresh.body.id,
    'dirty linked chats use an isolated checkout',
  );
  assert.equal(
    await fs.readFile(unrelated, 'utf8'),
    'Keep this unfinished work',
  );
  const saved = JSON.parse(
    await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'),
  );
  const cleanTask = Object.values(saved.preparations).find(
    (task) => task.id === cleanRetry.body.id,
  );
  assert.equal(cleanTask.status, 'published', cleanTask.error);
  assert.notEqual(cleanTask.cwd, freshTask.cwd);
  assert.equal(
    (
      await post('/job', {
        url: 'https://github.com/a/b/pull/7',
        kind: 'review',
        pushOnCompletion: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post('/job', {
        url: 'https://github.com/a/b/pull/7',
        kind: 'ci',
        pushOnCompletion: true,
        auto: true,
      })
    ).status,
    400,
  );
});
