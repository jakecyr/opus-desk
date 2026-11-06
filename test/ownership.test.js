import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingTerminal } from '../server/ownership.js';
test('detects only the same agent and project', () => {
  const terminals = [
    { agent: 'codex', cwd: '/code/a' },
    { agent: 'claude', cwd: '/code/b' },
  ];
  assert.equal(
    matchingTerminal({ agent: 'codex', cwd: '/code/a' }, terminals),
    true,
  );
  assert.equal(
    matchingTerminal({ agent: 'claude', cwd: '/code/a' }, terminals),
    false,
  );
  assert.equal(
    matchingTerminal({ agent: 'codex', cwd: '/code/other' }, terminals),
    false,
  );
  assert.equal(matchingTerminal({}, terminals), false);
});
