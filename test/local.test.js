import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsHost, localOptions } from '../server/local.js';

test('validates loopback-only hostnames and port bounds', () => {
  assert.deepEqual(
    localOptions({ port: '4317', hostname: 'opus-desk.localhost' }),
    { port: 4317, hostname: 'opus-desk.localhost' },
  );
  for (const hostname of [
    '0.0.0.0',
    'desk.local',
    'evil.com',
    'a.localhost.evil.com',
    '-bad.localhost',
    'a/b.localhost',
    'localhost:4317',
  ]) {
    assert.throws(() => localOptions({ hostname }), /Hostname/);
  }
  for (const port of [0, 65536, 1.5, 'nope', ''])
    assert.throws(() => localOptions({ port }), /Port/);
});

test('host allowlist accepts only the configured name and actual port', () => {
  for (const host of [
    '127.0.0.1:4317',
    'localhost:4317',
    '[::1]:4317',
    'desk.localhost:4317',
  ])
    assert.equal(acceptsHost(host, 'desk.localhost', 4317), true);
  for (const host of [
    undefined,
    'localhost',
    'localhost:9999',
    'evil.localhost:4317',
    'user@localhost:4317',
    'localhost:4317.evil.com',
  ])
    assert.equal(acceptsHost(host, 'desk.localhost', 4317), false);
});
