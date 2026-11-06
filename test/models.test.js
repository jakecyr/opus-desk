import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { claudeModels, modelCatalog } from '../server/models.js';
test('model catalog uses paginated CLI data, caches overlapping requests, and preserves reasoning levels', async () => {
  let calls = 0;
  const codex = {
    start: async () => {},
    call: async (_method, params) => {
      calls++;
      return params.cursor
        ? { data: [{ id: 'second' }] }
        : {
            data: [
              {
                id: 'first',
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              },
            ],
            nextCursor: 'next',
          };
    },
  };
  const load = modelCatalog(codex);
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(calls, 2);
  assert.deepEqual(a, b);
  assert.equal(a.data.length, 2);
  assert.equal(a.data[0].supportedReasoningEfforts[0].reasoningEffort, 'high');
  const missing = modelCatalog({
    start: async () => {
      throw Object.assign(Error('missing'), { code: 'ENOENT' });
    },
  });
  assert.match((await missing()).error, /not installed/);
});
test('Claude discovery only initializes the CLI and shuts down without a user prompt', async () => {
  let args,
    request,
    killed = false;
  const spawnProcess = (_file, argv) => {
    args = argv;
    const p = new EventEmitter();
    p.stdin = new PassThrough();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.kill = () => {
      killed = true;
    };
    p.stdin.on('data', (chunk) => {
      request = JSON.parse(chunk);
      queueMicrotask(() =>
        p.stdout.write(
          JSON.stringify({
            type: 'control_response',
            response: {
              request_id: request.request_id,
              subtype: 'success',
              response: {
                models: [
                  {
                    value: 'local-model',
                    displayName: 'Local Model',
                    supportedEffortLevels: ['medium', 'high'],
                  },
                ],
              },
            },
          }) + '\n',
        ),
      );
    });
    return p;
  };
  const data = await claudeModels({ spawnProcess });
  assert.equal(request.type, 'control_request');
  assert.equal(request.request.subtype, 'initialize');
  assert.ok(!JSON.stringify(request).includes('user'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(killed);
  assert.equal(data[0].model, 'local-model');
  assert.equal(data[0].supportedReasoningEfforts[1].reasoningEffort, 'high');
});
