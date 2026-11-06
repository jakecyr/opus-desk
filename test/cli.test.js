import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../server/cli.js';
import { runtimeSmoke } from '../scripts/runtime-smoke.js';

test('CLI validates commands and command-specific options', () => {
  assert.equal(parseArgs([]).action, 'help');
  assert.equal(parseArgs(['update']).action, 'update');
  assert.deepEqual(
    parseArgs(['start', '--port', '5000', '--hostname', 'desk.localhost'])
      .options,
    { port: '5000', hostname: 'desk.localhost' },
  );
  for (const args of [
    ['destroy'],
    ['update', '--port', '5000'],
    ['start', '--port'],
    ['stop', '--port', '5000'],
    ['run', '--agent', 'claude'],
    ['configure', '--port', '5000'],
  ]) {
    assert.throws(() => parseArgs(args));
  }
});

test(
  'detached source CLI serves assets and supports Claude-only setup',
  { timeout: 60000 },
  async () => {
    await runtimeSmoke(process.execPath, [
      fileURLToPath(new URL('../bin/opus-desk.js', import.meta.url)),
    ]);
  },
);
