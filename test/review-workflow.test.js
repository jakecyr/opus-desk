import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('manual and Auto reviews require approval and use full context', async (t) => {
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
  const fixture = { auto: false, head: 'head1', fail: false };
  const updateFixture = () =>
    fs.writeFile(fixtureFile, JSON.stringify(fixture));
  await updateFixture();
  await fs.writeFile(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2),f=JSON.parse(fs.readFileSync(process.env.REVIEW_FIXTURE,'utf8'));const pr={url:'https://github.com/a/b/pull/7',number:7,title:'PR intent',body:'Fixes #5',headRefOid:f.head,closingIssuesReferences:[{url:'https://github.com/a/b/issues/5'}],headRefName:'fix-ci',headRepository:{name:'fork'},headRepositoryOwner:{login:'contributor'}};let result;
if(a.includes('--method')){fs.appendFileSync(process.env.REVIEW_WRITES,JSON.stringify(a)+'\\n');console.log('{}');process.exit(0)}
if(a[0]==='issue'&&a[1]==='comment'){fs.appendFileSync(process.env.REVIEW_WRITES,fs.readFileSync(a.at(-1),'utf8'));console.log('{}');process.exit(0)}
if(a[0]==='--version'){console.log('gh test');process.exit(0)}
if(a[0]==='search')result=f.auto&&a[1]==='prs'&&a.includes('--review-requested')?[{...pr,state:'open',updatedAt:'2026-01-01T00:00:00Z',repository:{nameWithOwner:'a/b'}}]:[];
else if(a[0]==='pr'&&a[1]==='view'){if(f.fail)process.exit(1);result=pr;}
else if(a[0]==='api'&&a[1]==='graphql')result={data:{viewer:{login:'me'},p0:{pullRequest:{headRefOid:f.head,baseRefOid:'base',mergeable:'MERGEABLE',reviews:{nodes:[{author:{login:'me'},state:'COMMENTED'}]},commits:{nodes:[]}}}}};
else if(a.at(-1)==='user')result={login:'me'};
else {const responses={'repos/a/b/issues/7/comments':[[{body:'PR discussion'}]],'repos/a/b/pulls/7/reviews':[[{user:{login:'me'},state:'COMMENTED',body:'Earlier feedback',commit_id:'older'},...(f.pending?[{id:99,user:{login:'me'},state:'PENDING',body:'Draft body',commit_id:f.head}]:[])]],'repos/a/b/pulls/7/reviews/99/comments':[[{id:1,path:'file.txt',line:1,body:'Check the edge case.'}]],'repos/a/b/pulls/7/comments':[[{body:'Inline discussion',path:'file.txt',line:1}]],'repos/a/b/issues/5':{title:'Linked issue',body:'Acceptance criteria'},'repos/a/b/issues/5/comments':[[{body:'Issue discussion'}]]};result=responses[a.at(-1).split('?')[0]];if(result===undefined)process.exit(1);}
console.log(JSON.stringify(result));
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(bin, 'codex'),
    `#!/usr/bin/env node
const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});let count=0;const directories=new Map();if(process.argv[2]==='--version'){console.log('codex test');process.exit(0)}rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};fs.appendFileSync(process.env.REVIEW_CALLS,JSON.stringify(m)+'\\n');if(m.method==='thread/start'){const id='thread-'+(++count);directories.set(id,m.params.cwd);result={thread:{id}};}if(m.method==='thread/read')result={thread:{id:m.params.threadId,cwd:directories.get(m.params.threadId)||process.env.REVIEW_PROJECT}};if(m.method==='turn/start'){const cwd=directories.get(m.params.threadId)||process.env.REVIEW_PROJECT;if(m.params.input[0].text.includes('user selected Fix CI')){const cp=require('child_process');cp.execFileSync('/usr/bin/git',['-C',cwd,'merge','--ff-only',JSON.parse(fs.readFileSync(process.env.REVIEW_FIXTURE,'utf8')).head]);fs.appendFileSync(cwd+'/file.txt',' CI fix');require('child_process').execFileSync('/usr/bin/git',['-C',cwd,'-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-qam','fix: repair CI']);}fs.appendFileSync(process.env.REVIEW_PROMPTS,JSON.stringify(m.params.input[0].text)+'\\n');setTimeout(()=>console.log(JSON.stringify({method:'turn/completed',params:{threadId:m.params.threadId,turn:{status:'completed'}}})),20)}console.log(JSON.stringify({id:m.id,result}));});
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(bin, 'git'),
    `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2);if(a.includes('push')){fs.appendFileSync(process.env.REVIEW_PUSHES,JSON.stringify(a)+'\\n');process.exit(0)}const r=require('child_process').spawnSync('/usr/bin/git',a,{stdio:'inherit'});process.exit(r.status??1);
`,
    { mode: 0o755 },
  );
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
  const prompts = async () => {
    try {
      return (await fs.readFile(promptsFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    } catch {
      return [];
    }
  };
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
  await updateFixture();
  await post('/auto', { enabled: true });
  for (let i = 0; i < 80; i++) {
    texts = await prompts();
    if (texts.length >= 3) break;
    await delay(40);
  }
  assert.equal(texts.length, 3);
  assert.match(texts[2], /Do not submit or publish/);
  assert.doesNotMatch(texts[2], /Additional review preferences/);
  await post('/auto', { enabled: false });
  assert.equal((await post('/settings', { publishReviews: true })).status, 400);
  fixture.head = 'head2';
  await updateFixture();
  await post('/auto', { enabled: true });
  for (let i = 0; i < 80; i++) {
    texts = await prompts();
    if (texts.length >= 4) break;
    await delay(40);
  }
  assert.equal(texts.length, 4);
  assert.match(texts[3], /Do not submit or publish/);
  await post('/auto', { enabled: false });
  fixture.auto = false;
  fixture.pending = true;
  fixture.head = 'head3';
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
  await assert.rejects(fs.access(path.join(tmp, 'writes.log')));
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
