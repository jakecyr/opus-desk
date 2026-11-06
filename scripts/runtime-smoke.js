import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function runtimeSmoke(command, prefix = []) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-runtime-'));
  const data = path.join(tmp, 'data');
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, 'gh'),
    '#!/bin/sh\nif [ "$1" = "search" ]; then echo "[]"; else echo "{}"; fi\n',
    { mode: 0o755 },
  );
  for (const name of ['codex', 'claude'])
    await fs.writeFile(path.join(bin, name), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
  const env = {
    ...process.env,
    HOME: tmp,
    OPUSDESK_DATA_DIR: data,
    PATH: `${bin}:${process.env.PATH}`,
  };
  delete env.OPUSDESK_STATIC_ROOT;
  delete env.PORT;
  delete env.OPUSDESK_HOSTNAME;
  if (prefix.length) {
    const root = path.join(tmp, 'static');
    await fs.mkdir(root);
    await fs.writeFile(
      path.join(root, 'index.html'),
      '<div id="root"></div><script src="/app.js"></script>',
    );
    await fs.writeFile(path.join(root, 'app.js'), '// fixture');
    env.OPUSDESK_STATIC_ROOT = root;
  }
  const cli = async (args) =>
    (
      await execute(command, [...prefix, ...args], {
        env,
        cwd: tmp,
        timeout: 20000,
      })
    ).stdout;
  const port = await unusedPort();
  try {
    assert.match(await cli(['--version']), /^\d+\.\d+\.\d+/);
    assert.match(
      await cli(['configure', '--agent', 'claude', '--projects', tmp]),
      /Configuration saved/,
    );
    assert.match(await cli(['status']), /Stopped/);
    assert.match(
      await cli([
        'start',
        '--port',
        String(port),
        '--hostname',
        'opus-desk.localhost',
      ]),
      /Started/,
    );
    const record = JSON.parse(await fs.readFile(path.join(data, 'daemon.pid')));
    assert.equal(record.port, port);
    assert.match(await cli(['start']), /Already running/);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(data, 'daemon.pid'))).pid,
      record.pid,
    );
    assert.match(await cli(['status']), /opus-desk\.localhost/);
    assert.match(
      await cli(['configure', '--agent', 'claude', '--projects', tmp]),
      /running daemon/,
    );
    const response = await fetch(`http://127.0.0.1:${port}/sessions/example`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<div id="root">/);
    const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
    assert.ok(asset, 'built dashboard references a JavaScript asset');
    assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 200);
    const hostStatus = (host) =>
      new Promise((resolve, reject) => {
        const request = http.get(
          { host: '127.0.0.1', port, path: '/api/health', headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
      });
    assert.equal(await hostStatus(`opus-desk.localhost:${port}`), 200);
    assert.equal(await hostStatus(`evil.localhost:${port}`), 403);
    assert.deepEqual(
      (await (await fetch(`http://127.0.0.1:${port}/api/models`)).json()).data,
      [],
    );
    assert.deepEqual(
      (await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json())
        .data,
      [],
    );
    const settings = (
      await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()
    ).settings;
    assert.equal(settings.defaultAgent, 'claude');
    assert.equal(settings.root, await fs.realpath(tmp));
    assert.match(await cli(['restart', '--port', String(port)]), /Started/);
    assert.match(await cli(['stop']), /Stopped PID/);
    assert.match(await cli(['stop']), /Already stopped/);
    await assert.rejects(cli(['start', '--port', '0']), /Port must be/);
    await fs.writeFile(
      path.join(data, 'daemon.pid'),
      JSON.stringify({
        pid: process.pid,
        port,
        hostname: 'localhost',
        instance: 'wrong',
      }),
    );
    assert.match(await cli(['stop']), /Already stopped/);
    process.kill(process.pid, 0);
  } finally {
    try {
      await cli(['stop']);
    } catch {
      /* Preserve the original assertion error. */
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
