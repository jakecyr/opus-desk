import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { unusedPort } from '../scripts/runtime-smoke.js';

test(
  'Codex and Claude jobs survive dashboard exit, finish offline, and reconnect without duplicate work',
  { timeout: 30000 },
  async (t) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-background-'));
    const bin = path.join(tmp, 'bin'),
      data = path.join(tmp, 'data'),
      project = path.join(tmp, 'projects/app'),
      staticRoot = path.join(tmp, 'static');
    for (const dir of [bin, data, project, staticRoot])
      await fs.mkdir(dir, { recursive: true });
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', [
      '-C',
      project,
      'remote',
      'add',
      'origin',
      'git@github.com:a/b.git',
    ]);
    await fs.writeFile(path.join(project, 'file.txt'), 'baseline');
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
    await fs.writeFile(path.join(staticRoot, 'index.html'), '<html></html>');
    await fs.writeFile(
      path.join(data, 'state.json'),
      JSON.stringify({
        settings: {
          root: path.dirname(project),
          permission: 'danger',
          permissionMigrated: true,
          interval: 300,
        },
        links: {},
        archived: [],
      }),
    );
    await fs.writeFile(
      path.join(bin, 'gh'),
      `#!/usr/bin/env node
const a=process.argv.slice(2);console.log(a[0]==='search'?'[]':a.at(-1)==='user'?'{}':'{}');
`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(bin, 'codex'),
      `#!/usr/bin/env node
const fs=require('fs');if(process.argv[2]==='--version'){console.log('codex fixture');process.exit(0)}let seq=0;
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='thread/start')result={thread:{id:'background-'+(++seq)}};if(m.method==='thread/list')result={data:[]};if(m.method==='thread/read')result={thread:{id:m.params.threadId,cwd:process.env.TEST_PROJECT,turns:[]}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){console.log(JSON.stringify({id:77,method:'item/tool/requestUserInput',params:{threadId:m.params.threadId,questions:[]}}));fs.appendFileSync(process.env.JOB_STARTS,'codex\\n');const timer=setInterval(()=>{if(fs.existsSync(process.env.JOB_GATE)){clearInterval(timer);console.log(JSON.stringify({method:'turn/completed',params:{threadId:m.params.threadId,turn:{status:'completed'}}}));}},20);}});
`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(bin, 'claude'),
      `#!/usr/bin/env node
const fs=require('fs');if(process.argv[2]==='--version'){console.log('claude fixture');process.exit(0)}fs.readFileSync(0,'utf8');fs.appendFileSync(process.env.JOB_STARTS,'claude\\n');const timer=setInterval(()=>{if(fs.existsSync(process.env.JOB_GATE)){clearInterval(timer);console.log(JSON.stringify({type:'result',result:'done'}));}},20);
`,
      { mode: 0o755 },
    );
    const port = await unusedPort(),
      base = 'http://127.0.0.1:' + port;
    const env = {
      ...process.env,
      HOME: tmp,
      PATH: bin + ':' + process.env.PATH,
      OPUSDESK_DATA_DIR: data,
      OPUSDESK_STATIC_ROOT: staticRoot,
      OPUSDESK_HOSTNAME: '127.0.0.1',
      PORT: String(port),
      TEST_PROJECT: project,
      JOB_STARTS: path.join(tmp, 'starts'),
      JOB_GATE: path.join(tmp, 'gate'),
    };
    let child;
    const launch = async () => {
      child = spawn(
        process.env.OPUSDESK_TEST_BINARY || process.execPath,
        process.env.OPUSDESK_TEST_BINARY ? ['run'] : ['server/index.js'],
        {
          cwd: process.cwd(),
          env,
          stdio: 'ignore',
        },
      );
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(base + '/api/health')).ok) return;
        } catch {}
        await delay(30);
      }
      throw Error('Dashboard did not start');
    };
    t.after(async () => {
      child?.kill();
      try {
        const host = JSON.parse(
          await fs.readFile(path.join(data, 'agents/host.json'), 'utf8'),
        );
        process.kill(-host.pid, 'SIGTERM');
      } catch {}
      await fs.rm(tmp, { recursive: true, force: true });
    });
    const post = async (body) => {
      const response = await fetch(base + '/api/job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PRQuay': 'local' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    await launch();
    const codex = await post({
      url: 'https://github.com/a/b/issues/1',
      kind: 'issue',
      agent: 'codex',
    });
    const claude = await post({
      url: 'https://github.com/a/b/issues/2',
      kind: 'issue',
      agent: 'claude',
    });
    assert.equal(codex.status, 200);
    assert.equal(claude.status, 200);
    const duplicate = await post({
      url: 'https://github.com/a/b/issues/1',
      kind: 'issue',
      agent: 'codex',
    });
    assert.deepEqual(duplicate, codex);
    assert.equal(
      (await post({ url: 'https://github.com/a/b/issues/1', kind: 'describe' }))
        .status,
      400,
    );
    let tasks = (await (await fetch(base + '/api/approvals')).json()).tasks;
    assert.equal(tasks.filter((task) => task.status === 'running').length, 2);
    assert.equal(
      new Set(tasks.map((task) => task.cwd)).size,
      2,
      'parallel jobs use separate checkouts',
    );
    const host = JSON.parse(
      await fs.readFile(path.join(data, 'agents/host.json'), 'utf8'),
    );
    const stopped = once(child, 'exit');
    child.kill('SIGKILL');
    await stopped;
    process.kill(host.pid, 0);
    // Resume the dashboard while both agents are still working.
    await launch();
    for (let i = 0; i < 100; i++) {
      tasks = (await (await fetch(base + '/api/approvals')).json()).tasks;
      if (tasks.length === 2) break;
      await delay(20);
    }
    assert.equal(tasks.filter((task) => task.status === 'running').length, 2);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(data, 'agents/host.json'), 'utf8'))
        .pid,
      host.pid,
    );
    const requests = await (await fetch(base + '/api/requests')).json();
    assert.equal(
      requests[0].id,
      77,
      'interactive requests survive dashboard restart',
    );
    const answer = await fetch(base + '/api/requests/77', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PRQuay': 'local' },
      body: JSON.stringify({ result: { answers: {} } }),
    });
    assert.equal(answer.status, 200);
    const stoppedAgain = once(child, 'exit');
    child.kill('SIGTERM');
    await stoppedAgain;
    await fs.writeFile(env.JOB_GATE, 'finish');
    let results;
    for (let i = 0; i < 100; i++) {
      results = await Promise.all(
        tasks.map((task) =>
          fs
            .readFile(path.join(data, 'agents', task.key + '.json'), 'utf8')
            .then(JSON.parse),
        ),
      );
      if (results.every((task) => task.status === 'complete')) break;
      await delay(30);
    }
    assert.deepEqual(
      results.map((task) => task.status),
      ['complete', 'complete'],
    );
    await launch();
    const state = await (await fetch(base + '/api/status')).json();
    assert.equal(state.links['https://github.com/a/b/issues/1'], codex.body.id);
    assert.equal(
      state.links['https://github.com/a/b/issues/2'],
      claude.body.id,
    );
    assert.deepEqual(
      (await fs.readFile(env.JOB_STARTS, 'utf8')).trim().split('\n').sort(),
      ['claude', 'codex'],
    );
  },
);
