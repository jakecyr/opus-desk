import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
const root = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  'projects',
);
const exec = promisify(execFile);
export async function claudeSessions() {
  const sessions = [];
  let dirs;
  try {
    dirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        sessions.push({
          id: 'claude:' + name.slice(0, -6),
          file,
          updatedAt: stat.mtimeMs / 1000,
        });
      } catch {}
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}
function contentText(content) {
  return typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
}

export async function claudeThread(id, existing) {
  const record = existing || (await claudeSessions()).find((s) => s.id === id);
  if (!record) throw Error('Claude session not found');
  const raw = await fs.readFile(record.file, 'utf8');
  const items = [];
  let cwd = '',
    model = '',
    title = '';
  for (const line of raw.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.cwd) cwd = e.cwd;
    if (e.type === 'assistant' && e.message?.model) model = e.message.model;
    if (!['user', 'assistant'].includes(e.type)) continue;
    const text = contentText(e.message?.content);
    if (!text) continue;
    if (!title && e.type === 'user') title = text.slice(0, 140);
    items.push(
      e.type === 'user'
        ? { type: 'userMessage', content: [{ type: 'text', text }] }
        : { type: 'agentMessage', text },
    );
  }
  const { file: _file, ...metadata } = record;
  return {
    ...metadata,
    cwd,
    model,
    agent: 'claude',
    preview: title,
    turns: [{ items }],
  };
}
export async function listClaude() {
  const records = await claudeSessions();
  const sessions = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, records.length) }, async () => {
      while (next < records.length) {
        const record = records[next++];
        try {
          let cwd = '',
            preview = '';
          const input = createReadStream(record.file);
          try {
            for await (const line of createInterface({
              input,
              crlfDelay: Infinity,
            })) {
              try {
                const entry = JSON.parse(line);
                if (entry.cwd) cwd = entry.cwd;
                if (!preview && entry.type === 'user')
                  preview = contentText(entry.message?.content).slice(0, 140);
              } catch {}
              if (cwd && preview) break;
            }
          } finally {
            input.destroy();
          }
          if (!cwd && !preview) continue;
          sessions.push({
            ...record,
            cwd,
            preview,
            agent: 'claude',
            status: { type: 'notLoaded', activeFlags: [] },
          });
        } catch {}
      }
    }),
  );
  return sessions;
}
export function claudeAutomationArguments(version) {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version);
  const [, major, minor, patch] = match?.map(Number) || [];
  if (
    !major ||
    major < 2 ||
    (major === 2 && (minor < 1 || (minor === 1 && patch < 319)))
  )
    throw Error('Claude Code 2.1.319 or later is required for Auto mode');
  return [
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    'Bash,Read,Glob,Grep,Edit,Write',
    '--permission-mode',
    'acceptEdits',
    '--settings',
    JSON.stringify({
      disableAllHooks: true,
      disableClaudeAiConnectors: true,
      permissions: { denyInsteadOfPrompting: true },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        network: {
          strictAllowlist: true,
          allowedDomains: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
      },
    }),
  ];
}

export async function runClaude(
  {
    id = randomUUID(),
    cwd,
    prompt,
    model,
    effort,
    permission = 'sandbox',
    resume = false,
    automated = false,
  },
  emit,
) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', id);
  else args.push('--session-id', id);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (automated) {
    const { stdout } = await exec('claude', ['--version'], { timeout: 4000 });
    args.push(...claudeAutomationArguments(stdout));
  } else if (permission === 'danger')
    args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'default');
  const p = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  p.stdin.on('error', () => {});
  p.stdin.end(prompt);
  let stderr = '';
  let stopped = false;
  let finishClose;
  let forceStop;
  const closed = new Promise((resolve) => {
    finishClose = resolve;
  });
  function signal(signalName) {
    if (!p.pid) return;
    try {
      if (process.platform === 'win32') p.kill(signalName);
      else process.kill(-p.pid, signalName);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  p.stderr.on('data', (d) => {
    stderr = (stderr + d.toString()).slice(-4096);
  });
  createInterface({ input: p.stdout }).on('line', (line) => {
    try {
      emit({
        method: 'claude/event',
        params: { threadId: 'claude:' + id, event: JSON.parse(line) },
      });
    } catch {}
  });
  p.on('error', (e) => {
    stderr = e.message;
    emit({
      method: 'claude/error',
      params: { threadId: 'claude:' + id, error: e.message },
    });
  });
  p.on('close', (code) => {
    clearTimeout(forceStop);
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'claude:' + id,
        status: stopped ? 'interrupted' : code === 0 ? 'completed' : 'failed',
        error:
          stopped || code === 0
            ? undefined
            : stderr.slice(-2000) || 'Claude exited',
      },
    });
    finishClose();
  });
  return {
    stop() {
      if (!stopped) {
        signal('SIGINT');
        stopped = true;
        forceStop = setTimeout(() => signal('SIGKILL'), 2500);
        forceStop.unref();
      }
      return closed;
    },
  };
}
