import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAutosave } from '../src/autosave.js';
test('autosave coalesces typing, serializes in-flight edits and flushes on navigation', async () => {
  const writes = [];
  let finish;
  const queue = createAutosave(
    async (patch) => {
      writes.push(patch);
      if (writes.length === 1) await new Promise((r) => (finish = r));
    },
    () => {},
    10,
  );
  queue.change({ model: 'a' });
  queue.change({ model: 'ab', effort: 'high' });
  await delay(25);
  assert.deepEqual(writes, [{ model: 'ab', effort: 'high' }]);
  queue.change({ model: 'latest' });
  await delay(15);
  assert.equal(writes.length, 1);
  queue.dispose();
  finish();
  await delay(10);
  assert.deepEqual(writes[1], { model: 'latest' });
  assert.equal(queue.dirty, false);
});
test('autosave retains failed edits for retry without losing newer input', async () => {
  let calls = 0,
    last,
    status;
  const queue = createAutosave(
    async (patch) => {
      calls++;
      if (calls === 1) throw Error('offline');
      last = patch;
    },
    (s) => (status = s),
    5,
  );
  queue.change({ root: '/a' });
  await delay(20);
  assert.equal(status, 'error');
  assert.equal(queue.dirty, true);
  queue.change({ root: '/b', interval: 60 });
  await delay(20);
  assert.deepEqual(last, { root: '/b', interval: 60 });
  assert.equal(status, 'saved');
  queue.dispose();
});
