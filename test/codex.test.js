import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Codex } from '../server/codex.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

function subprocess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test('Codex routes interleaved RPC responses and protocol failures', async () => {
  const codex = new Codex();
  const sent = [];
  codex.proc = { stdin: { write: (line) => sent.push(JSON.parse(line)) } };
  const first = codex.call('first');
  const second = codex.call('second', { limit: 2 });
  codex.receive({ id: sent[1].id, result: { ok: true } });
  codex.receive({ id: 999, result: {} });
  codex.receive({ id: sent[0].id, error: { message: 'Denied' } });
  assert.deepEqual(await second, { ok: true });
  await assert.rejects(first, /Denied/);
  assert.equal(codex.pending.size, 0);
});

test('Codex tracks approvals and sends the original typed request id', () => {
  const codex = new Codex();
  const sent = [];
  codex.proc = { stdin: { write: (line) => sent.push(JSON.parse(line)) } };
  const events = [];
  codex.on('event', (message) => events.push(message));
  codex.receive({
    id: 42,
    method: 'item/fileChange/requestApproval',
    params: {},
  });
  assert.equal(events.length, 1);
  codex.respond('42', { decision: 'decline' });
  assert.deepEqual(sent[0], { id: 42, result: { decision: 'decline' } });
  assert.equal(codex.requests.size, 0);
  assert.throws(() => codex.respond('42', {}), /no longer active/);
});

test('a closed Codex stdin rejects startup without an unhandled stream error', async () => {
  const child = subprocess();
  const codex = new Codex({ spawnProcess: () => child });
  const ready = codex.start();
  const rejected = assert.rejects(ready, /broken pipe/);
  child.stdin.emit(
    'error',
    Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
  );
  await rejected;
  assert.equal(child.killed, true);
  assert.equal(codex.ready, null);
  assert.equal(codex.pending.size, 0);
});

test('transport failures reject pending work and a stale exit cannot close a new connection', async () => {
  const first = subprocess(),
    second = subprocess();
  const children = [first, second];
  const codex = new Codex({ spawnProcess: () => children.shift() });
  const ready = codex.start();
  codex.receive({ id: 1, result: {} });
  await ready;
  codex.receive({
    id: 77,
    method: 'item/fileChange/requestApproval',
    params: {},
  });
  const pending = assert.rejects(codex.call('thread/list'), /broken pipe/);
  first.stdin.emit('error', new Error('broken pipe'));
  await pending;
  assert.equal(codex.requests.size, 0);
  const restarted = codex.start();
  first.emit('exit', 1);
  assert.equal(codex.proc, second);
  codex.receive({ id: 3, result: {} });
  await restarted;
  second.emit('exit', 0);
});

test('spawn and synchronous write failures leave no pending calls and allow another start', async () => {
  const codex = new Codex({
    spawnProcess: () => {
      throw new Error('spawn failed');
    },
  });
  await assert.rejects(codex.start(), /spawn failed/);
  assert.equal(codex.ready, null);
  const child = subprocess();
  child.stdin.write = () => {
    throw new Error('write failed');
  };
  codex.spawnProcess = () => child;
  await assert.rejects(codex.start(), /write failed/);
  assert.equal(codex.pending.size, 0);
  await assert.rejects(codex.call('thread/list'), /not connected/);
  assert.equal(codex.pending.size, 0);
});
