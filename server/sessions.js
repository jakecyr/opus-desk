import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const sourceKinds = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
];

export async function listCodexSessions(codex, archived) {
  const data = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const page = await codex.call('thread/list', {
      limit: 100,
      cursor,
      sortKey: 'updated_at',
      sourceKinds,
      archived,
    });
    data.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor))
      throw Error('Codex repeated a session page');
    cursors.add(cursor);
  } while (cursor);
  return data.map((session) => ({ ...session, archived }));
}

const recent = (session) => session.recencyAt || session.updatedAt || 0;

export function mergeSessions(...lists) {
  const sessions = new Map();
  for (const session of lists.flat()) {
    const previous = sessions.get(session.id);
    sessions.set(session.id, previous ? { ...previous, ...session } : session);
  }
  return [...sessions.values()].sort((a, b) => recent(b) - recent(a));
}

function messageText(record) {
  const message =
    record.type === 'response_item' ? record.payload : record.message;
  const role = record.type === 'response_item' ? message?.role : record.type;
  if (!['user', 'assistant'].includes(role)) return '';
  if (typeof message?.content === 'string') return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((item) => ['text', 'input_text', 'output_text'].includes(item.type))
    .map((item) => item.text)
    .join('\n');
}

export function createSessionSearch({ cacheBytes = 24 * 1024 * 1024 } = {}) {
  const transcripts = new Map();
  let retainedBytes = 0;

  async function readTranscript(file, signal) {
    if (!file?.endsWith('.jsonl') || signal?.aborted) return '';
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return '';
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const cached = transcripts.get(file);
      if (cached) {
        transcripts.delete(file);
        if (cached.signature === signature) {
          transcripts.set(file, cached);
          return cached.content;
        }
        retainedBytes -= cached.bytes;
      }

      // Strip tool output and other protocol records from the local search index.
      // Streams let large rollouts be read without loading their full contents.
      const lines = createInterface({
        input: createReadStream(file, { signal }),
        crlfDelay: Infinity,
      });
      const messages = [];
      for await (const line of lines) {
        const head = line.slice(0, 240);
        if (!/"type"\s*:\s*"(user|assistant|response_item)"/.test(head))
          continue;
        if (
          head.includes('"response_item"') &&
          !/"type"\s*:\s*"message"/.test(head)
        )
          continue;
        try {
          const text = messageText(JSON.parse(line));
          if (text) messages.push(text);
        } catch {}
      }
      const content = messages.join('\n').toLowerCase();
      const bytes = Buffer.byteLength(content);
      if (bytes <= cacheBytes) {
        // Simultaneous searches may finish reading the same file.
        retainedBytes -= transcripts.get(file)?.bytes || 0;
        transcripts.delete(file);
        while (retainedBytes + bytes > cacheBytes && transcripts.size) {
          const oldest = transcripts.keys().next().value;
          retainedBytes -= transcripts.get(oldest).bytes;
          transcripts.delete(oldest);
        }
        transcripts.set(file, { signature, bytes, content });
        retainedBytes += bytes;
      }
      return content;
    } catch {
      return '';
    }
  }

  return async function searchSessions(
    sessions,
    { query, reference, signal, worktrees = {} } = {},
  ) {
    const words =
      query?.trim().toLowerCase().split(/\s+/).filter(Boolean) || [];
    const url = reference?.toLowerCase();
    if (!words.length && !url) return sessions;
    const matches = (text) => {
      if (!url) return words.every((word) => text.includes(word));
      let index = text.indexOf(url);
      while (index !== -1) {
        if (!/\w/.test(text[index + url.length] || '')) return true;
        index = text.indexOf(url, index + url.length);
      }
      return false;
    };
    let next = 0;
    const matched = new Set();
    await Promise.all(
      Array.from({ length: Math.min(sessions.length, 4) }, async () => {
        while (next < sessions.length && !signal?.aborted) {
          const session = sessions[next++];
          const metadata = [
            session.name,
            session.preview,
            session.cwd,
            worktrees[session.cwd],
            session.gitInfo?.originUrl,
            session.id,
            session.agent || 'codex',
          ]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();
          if (
            matches(metadata) ||
            matches(
              metadata +
                '\n' +
                (await readTranscript(session.file || session.path, signal)),
            )
          ) {
            matched.add(session.id);
          }
        }
      }),
    );
    return sessions.filter((session) => matched.has(session.id));
  };
}

export async function sessionDirectory({ project, folder, projects }) {
  if (folder !== undefined) {
    if (
      typeof folder === 'string' &&
      (folder === '~' || folder.startsWith('~/'))
    )
      folder = path.join(os.homedir(), folder.slice(1));
    if (project || typeof folder !== 'string' || !path.isAbsolute(folder))
      throw Error('Enter an absolute folder path');
    try {
      const cwd = await fs.realpath(folder);
      if ((await fs.stat(cwd)).isDirectory()) return cwd;
    } catch {}
    throw Error('This folder does not exist or is not accessible');
  }
  if (!projects.some((item) => item.path === project))
    throw Error('Choose a discovered project');
  return project;
}

export function sessionModelOptions({ model, effort }) {
  for (const value of [model, effort]) {
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        value.length > 200 ||
        /[\r\n\0]/.test(value))
    )
      throw Error('Invalid model or reasoning setting');
  }
  return { model: model?.trim() || '', effort: effort?.trim() || '' };
}
