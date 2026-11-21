import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeAutomationArguments, claudeThread } from '../server/claude.js';

test('Claude history tolerates incomplete lines and renders text content only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-claude-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.jsonl');
  await fs.writeFile(
    file,
    [
      'incomplete JSON',
      JSON.stringify({
        type: 'user',
        cwd: '/example',
        message: { content: 'Review this' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reviewed' },
            { type: 'tool_use', text: 'not text' },
          ],
        },
      }),
      JSON.stringify({ type: 'system', message: { content: 'metadata' } }),
    ].join('\n'),
  );
  const thread = await claudeThread('claude:example', {
    id: 'claude:example',
    file,
  });
  assert.equal(thread.cwd, '/example');
  assert.equal(thread.preview, 'Review this');
  assert.deepEqual(
    thread.turns[0].items.map((item) => item.type),
    ['userMessage', 'agentMessage'],
  );
  assert.equal(thread.turns[0].items[1].text, 'Reviewed');
});

test('Claude Auto mode requires fail-closed sandbox support and enables local tools only', () => {
  assert.throws(
    () => claudeAutomationArguments('2.1.318 (Claude Code)'),
    /2.1.319/,
  );
  assert.throws(() => claudeAutomationArguments('unknown'), /2.1.319/);
  const args = claudeAutomationArguments('2.1.319 (Claude Code)');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  const option = (name) => args[args.indexOf(name) + 1];
  assert.equal(option('--setting-sources'), '');
  assert.equal(option('--permission-mode'), 'acceptEdits');
  assert.equal(option('--tools'), 'Bash,Read,Glob,Grep,Edit,Write');
  assert.deepEqual(JSON.parse(option('--mcp-config')), { mcpServers: {} });
  const settings = JSON.parse(option('--settings'));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.disableClaudeAiConnectors, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.network.strictAllowlist, true);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
});
