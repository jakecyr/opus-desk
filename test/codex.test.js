import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Codex } from '../server/codex.js';

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
