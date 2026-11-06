import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../vite.config.js';

test('dev proxy forwards local origins while preserving cross-origin rejection', () => {
  const proxy = config.server.proxy['/api'];
  assert.equal(proxy.changeOrigin, true);
  let onRequest;
  proxy.configure({
    on: (_event, handler) => {
      onRequest = handler;
    },
  });
  for (const [origin, rewritten] of [
    ['http://127.0.0.1:5173', true],
    ['https://evil.example', false],
    ['http://127.0.0.1:9999', false],
    [undefined, false],
  ]) {
    const headers = [];
    onRequest(
      { setHeader: (...args) => headers.push(args) },
      { headers: { host: '127.0.0.1:5173', origin } },
    );
    assert.deepEqual(
      headers,
      rewritten ? [['origin', 'http://127.0.0.1:4317']] : [],
    );
  }
});
