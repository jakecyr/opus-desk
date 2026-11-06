import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projects } from '../server/core.js';

const execute = promisify(execFile);

test('state saves serialize snapshots and preserve private permissions', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-state-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const core = new URL('../server/core.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const {loadState,saveState,statePath} = await import(${JSON.stringify(core)});
    assert.equal((await loadState()).settings.defaultAgent, 'codex');
    const snapshot = {settings: {defaultAgent: 'claude'}, revision: 1};
    const first = saveState(snapshot);
    snapshot.revision = 2;
    const second = saveState(snapshot);
    snapshot.revision = 3;
    await Promise.all([first, second, saveState(snapshot)]);
    assert.equal((await loadState()).revision, 3);
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(statePath))).mode & 0o777, 0o700);
    await fs.writeFile(statePath, 'invalid JSON');
    assert.equal((await loadState()).settings.interval, 120);
  `;
  await execute(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      HOME: tmp,
      OPUSDESK_DATA_DIR: path.join(tmp, 'data'),
    },
  });
});

test('project discovery includes Git repositories, parses GitHub origins, and ignores hidden folders', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-projects-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  for (const [name, remote] of [
    ['alpha', 'git@github.com:example/alpha.git'],
    ['beta', 'https://github.com/example/beta.git'],
    ['.hidden', 'git@github.com:example/hidden.git'],
  ]) {
    const project = path.join(tmp, name);
    await execute('git', ['init', '-q', project]);
    await execute('git', ['-C', project, 'remote', 'add', 'origin', remote]);
  }
  await fs.mkdir(path.join(tmp, 'ordinary-folder'));
  const found = await projects(tmp);
  assert.deepEqual(
    found.map((project) => [project.name, project.repo]),
    [
      ['alpha', 'example/alpha'],
      ['beta', 'example/beta'],
    ],
  );
  assert.deepEqual(await projects(path.join(tmp, 'missing')), []);
});
