import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentClient } from '../server/agent-host.js';

test('legacy background hosts cannot accept automation or turn control', async () => {
  const client = new AgentClient();
  const rpc = [];
  client.start = async () => {};
  client.request = async (method) => {
    rpc.push(method);
    return {};
  };
  await assert.rejects(client.requireAutomation(), /older agent host/);
  await assert.rejects(
    client.runClaude({ id: 'legacy', automated: true }),
    /older agent host/,
  );
  await assert.rejects(
    client.call('host/register', { auto: true }),
    /older agent host/,
  );
  await assert.rejects(
    client.call('host/steer', { threadId: 'legacy' }),
    /older agent host/,
  );
  await client.call('thread/list', {});
  assert.deepEqual(rpc, ['thread/list']);
});

test('orchestrator routes model changes, steering, stopping and continued local CLI turns', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-orchestrator-'));
  const cwd = await fs.realpath(folder);
  const bin = path.join(cwd, 'bin');
  const data = path.join(cwd, 'data');
  await fs.mkdir(bin);
  await fs.mkdir(data);
  await fs.writeFile(
    path.join(data, 'state.json'),
    JSON.stringify({
      settings: {
        root: cwd,
        githubHost: 'git.example.com',
        permissionMigrated: true,
        permission: 'sandbox',
      },
      links: {},
    }),
  );
  const codexCalls = path.join(cwd, 'codex.log');
  const claudeCalls = path.join(cwd, 'claude.log');
  const rollout = path.join(cwd, 'archive.jsonl');
  const reference = 'https://git.example.com/team/project/pull/4';
  await fs.writeFile(
    rollout,
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `Review ${reference}` }],
      },
    }) + '\n',
  );
  await fs.writeFile(path.join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "[]"\n', {
    mode: 0o755,
  });
  await fs.writeFile(
    path.join(bin, 'codex'),
    String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
if (process.argv[2] === '--version') { console.log('codex fixture'); process.exit(0); }
const send = (message) => console.log(JSON.stringify(message));
const threads = new Map();
let count = 0, turns = 0;
lines.on('line', (line) => {
  const call = JSON.parse(line);
  if (!call.id) return;
  fs.appendFileSync(process.env.OPUS_TEST_CODEX_LOG, line + '\n');
  const { method, params } = call;
  let result = {};
  let notification;
  if (method === 'thread/list') {
    result = { data: params.archived ? [{ id: 'archived-history', cwd: '/different/project', path: process.env.OPUS_TEST_ROLLOUT, updatedAt: 4 }] : [...threads.values()] };
  }
  if (method === 'thread/start') {
    const thread = { id: 'local-chat-' + ++count, cwd: params.cwd, turns: [] };
    threads.set(thread.id, thread);
    result = { thread };
  }
  if (method === 'thread/read') result = { thread: threads.get(params.threadId) };
  if (method === 'turn/start') {
    result = { turn: { id: 'turn-' + ++turns } };
    notification = { method: 'turn/started', params: { threadId: params.threadId, turn: result.turn } };
  }
  if (method === 'turn/interrupt') {
    notification = { method: 'turn/completed', params: {
      threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' },
    } };
  }
  send({ id: call.id, result });
  if (notification) send(notification);
});
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(bin, 'claude'),
    String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.319 (Claude Code)'); process.exit(0); }
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const id = option('--resume') || option('--session-id');
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
const prompt = fs.readFileSync(0, 'utf8');
fs.mkdirSync(folder, { recursive: true });
fs.appendFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({
  type: 'user', cwd: process.cwd(), message: { content: prompt },
}) + '\n');
fs.appendFileSync(process.env.OPUS_TEST_CLAUDE_LOG, JSON.stringify({ id, prompt, args, pid: process.pid }) + '\n');
if (prompt === 'hold') setInterval(() => {}, 1000);
else console.log(JSON.stringify({ type: 'result', result: 'ok' }));
`,
    { mode: 0o755 },
  );
  const port = 46000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OPUSDESK_DATA_DIR: data,
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude-config'),
      OPUS_TEST_CODEX_LOG: codexCalls,
      OPUS_TEST_CLAUDE_LOG: claudeCalls,
      OPUS_TEST_ROLLOUT: rollout,
      PORT: String(port),
    },
    stdio: 'ignore',
  });
  const lines = async (file) =>
    (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  t.after(async () => {
    const closed = once(child, 'exit');
    if (child.kill()) await closed;
    try {
      const host = JSON.parse(
        await fs.readFile(path.join(data, 'agents/host.json'), 'utf8'),
      );
      process.kill(-host.pid, 'SIGTERM');
    } catch {}
    for (const { pid } of await lines(claudeCalls).catch(() => [])) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {}
    }
    await fs.rm(folder, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}/api`;
  const get = async (url) => (await fetch(origin + url)).json();
  const post = (url, body = {}) =>
    fetch(origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PRQuay': 'local' },
      body: JSON.stringify(body),
    });
  async function waitFor(f) {
    for (let i = 0; i < 50; i++) {
      const result = await f().catch(() => false);
      if (result) return result;
      await delay(40);
    }
    assert.fail('Expected orchestrator state did not appear');
  }
  async function write(url, body) {
    const response = await post(url, body);
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    return result;
  }
  await waitFor(() => get('/github'));
  const found = await get(
    '/sessions?reference=' + encodeURIComponent(reference),
  );
  assert.equal(found.data[0].id, 'archived-history');
  assert.equal(found.data[0].archived, true);
  assert.equal((await post('/session', { folder: 'relative' })).status, 400);

  const draft = await write('/session', {
    folder,
    model: 'original',
    effort: 'low',
  });
  const draftUrl = '/session/' + encodeURIComponent(draft.id);
  await write(draftUrl + '/options', { model: 'first-model', effort: 'high' });
  const { id } = await write(draftUrl + '/message', { text: 'start chat' });
  const url = '/session/' + id;
  assert.equal((await get(url)).thread.cwd, cwd);
  assert.equal((await get(url)).active, true);
  assert.equal(
    (await post(url + '/message', { text: 'duplicate' })).status,
    400,
  );
  await write(url + '/message', { text: 'steer chat', mode: 'steer' });
  await write(url + '/options', { model: 'next-model', effort: 'medium' });
  await write(url + '/interrupt');
  await waitFor(async () => (await get(url)).active === false);
  assert.equal(
    (await post(url + '/message', { text: 'stale', mode: 'steer' })).status,
    400,
  );
  await write(url + '/message', { text: 'new turn', mode: 'send' });
  const calls = await lines(codexCalls);
  assert.equal(
    calls.find(({ method }) => method === 'thread/start').params.model,
    'first-model',
  );
  const starts = calls.filter(({ method }) => method === 'turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].params.effort, 'high');
  assert.equal(starts[1].params.model, 'next-model');
  assert.equal(starts[1].params.effort, 'medium');
  assert.deepEqual(calls.find(({ method }) => method === 'turn/steer').params, {
    threadId: id,
    input: [{ type: 'text', text: 'steer chat' }],
    expectedTurnId: 'turn-1',
  });
  assert.deepEqual(
    calls.find(({ method }) => method === 'turn/interrupt').params,
    { threadId: id, turnId: 'turn-1' },
  );

  const claudeDraft = await write('/session', { folder, agent: 'claude' });
  const claude = await write(
    '/session/' + encodeURIComponent(claudeDraft.id) + '/message',
    { text: 'hold' },
  );
  const claudeUrl = '/session/' + encodeURIComponent(claude.id);
  await waitFor(async () => (await lines(claudeCalls)).length === 1);
  await write(claudeUrl + '/options', { model: 'next-claude', effort: 'max' });
  await write(claudeUrl + '/message', {
    text: 'continue Claude',
    mode: 'steer',
  });
  await waitFor(async () => (await lines(claudeCalls)).length === 2);
  const [first, next] = await lines(claudeCalls);
  assert.equal(first.id, next.id);
  assert.equal(next.prompt, 'continue Claude');
  assert.ok(next.args.includes('--resume'));
  assert.equal(next.args[next.args.indexOf('--model') + 1], 'next-claude');
  assert.equal(next.args[next.args.indexOf('--effort') + 1], 'max');
  assert.equal((await get(url)).active, true);
  await write(url + '/interrupt');
  await waitFor(async () => (await get(claudeUrl)).active === false);
  assert.ok(
    (await get(claudeUrl)).thread.turns[0].items.some(
      (item) => item.content[0].text === 'continue Claude',
    ),
  );
});
