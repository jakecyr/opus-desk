import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';

// Initialize the local CLI without sending a user message or starting inference.
export function claudeModels({ spawnProcess = spawn, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      'claude',
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
      ],
      { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false,
      stderr = '';
    const timer = setTimeout(
      () => finish(Error('Claude model discovery timed out')),
      timeout,
    );
    function finish(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(data);
    }
    child.on('error', (e) => finish(e));
    child.stdin.on('error', (e) => finish(e));
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-1000);
    });
    child.on('exit', () =>
      finish(Error(stderr || 'Claude did not return a model catalog')),
    );
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (
        m.type !== 'control_response' ||
        m.response?.request_id !== 'opus-models'
      )
        return;
      if (m.response.subtype === 'error')
        return finish(
          Error(m.response.error || 'Claude model discovery failed'),
        );
      const models = m.response.response?.models;
      if (!Array.isArray(models))
        return finish(
          Error('This Claude CLI does not expose its model catalog'),
        );
      finish(
        null,
        models
          .map((m) => ({
            id: m.value || m.model || m.id,
            model: m.value || m.model || m.id,
            displayName: m.displayName || m.display_name || m.value || m.id,
            supportedReasoningEfforts: (
              m.supportedEffortLevels ||
              m.supportedReasoningEfforts ||
              []
            ).map((e) => (typeof e === 'string' ? { reasoningEffort: e } : e)),
          }))
          .filter((m) => m.id),
      );
    });
    child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'opus-models',
        request: { subtype: 'initialize' },
      }) + '\n',
    );
  });
}

export function modelCatalog(
  codex,
  { loadClaude = claudeModels, ttl = 300000 } = {},
) {
  const cache = new Map();
  return async function load(agent = 'codex') {
    if (!['codex', 'claude'].includes(agent)) throw Error('Unknown agent');
    const prior = cache.get(agent);
    if (prior && prior.expires > Date.now()) return prior.promise;
    const promise = (async () => {
      try {
        if (agent === 'claude')
          return { data: await loadClaude(), source: 'cli' };
        await codex.start();
        const data = [];
        let cursor = null;
        do {
          const page = await codex.call('model/list', {
            limit: 100,
            includeHidden: false,
            cursor,
          });
          data.push(...(page.data || []));
          cursor = page.nextCursor || null;
        } while (cursor && data.length < 1000);
        return { data, source: 'cli' };
      } catch (e) {
        return {
          data: [],
          error:
            e.code === 'ENOENT'
              ? 'The ' + agent + ' CLI is not installed'
              : e.message,
        };
      }
    })();
    cache.set(agent, { promise, expires: Date.now() + ttl });
    return promise;
  };
}
