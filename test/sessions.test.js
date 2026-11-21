import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSessionSearch,
  listCodexSessions,
  mergeSessions,
  sessionDirectory,
  sessionModelOptions,
} from '../server/sessions.js';
import { groupSessions } from '../src/session-groups.js';

test('Codex follows all pages and keeps active and archived history identifiable', async () => {
  const calls = [];
  const cli = {
    async call(method, params) {
      calls.push({ method, params });
      const page = Number(params.cursor || 0);
      return {
        data: Array.from({ length: 100 }, (_, index) => ({
          id: `a-${page}-${index}`,
        })),
        nextCursor: page < 10 ? String(page + 1) : null,
      };
    },
  };
  const sessions = await listCodexSessions(cli, true);
  assert.equal(sessions.length, 1100);
  assert.ok(sessions.every((session) => session.archived));
  assert.ok(
    calls.every(
      ({ method, params }) => method === 'thread/list' && params.archived,
    ),
  );
  assert.equal(calls[10].params.cursor, '10');
});

test('chat search combines messages, project metadata and both CLI histories', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-sessions-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const rollout = path.join(folder, 'codex.jsonl');
  const claude = path.join(folder, 'claude.jsonl');
  const enterprise = 'https://git.example.com/org/project/pull/42';
  const codexMessage = (content, role = 'assistant') =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        content: [{ type: 'output_text', text: content }],
      },
    });
  await fs.writeFile(
    rollout,
    [
      codexMessage('A unique fix for cache drift'),
      codexMessage(enterprise + '7'),
      codexMessage('hidden prompt token', 'developer'),
      'incomplete line',
    ].join('\n'),
  );
  await fs.writeFile(
    claude,
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: `Fix cache drift on ${enterprise}#discussion_r42`,
          },
        ],
      },
    }),
  );
  const items = mergeSessions(
    [
      {
        id: 'codex',
        cwd: '/work/worktree',
        path: rollout,
        archived: true,
        updatedAt: 5,
      },
    ],
    [
      {
        id: 'claude:one',
        agent: 'claude',
        cwd: '/home/services',
        file: claude,
        updatedAt: 7,
      },
    ],
  );
  const search = createSessionSearch();
  const ids = (rows) => rows.map(({ id }) => id);
  assert.deepEqual(ids(await search(items, { query: 'CaChe DRiFt' })), [
    'claude:one',
    'codex',
  ]);
  assert.deepEqual(
    ids(
      await search(items, {
        query: 'favorite unique',
        worktrees: { '/work/worktree': '/projects/favorite' },
      }),
    ),
    ['codex'],
  );
  assert.deepEqual(
    ids(await search(items, { query: 'hidden prompt token' })),
    [],
  );
  assert.deepEqual(ids(await search(items, { reference: enterprise })), [
    'claude:one',
  ]);
  await fs.appendFile(rollout, '\n' + codexMessage(enterprise));
  assert.deepEqual(ids(await search(items, { reference: enterprise })), [
    'claude:one',
    'codex',
  ]);
});

test('project groups use latest chat and sort direction in both orders', () => {
  const projects = [
    { name: 'Alpha', path: '/code/a' },
    { name: 'Zebra', path: '/code/z' },
    { name: 'Tools', path: '/code/z/tools' },
  ];
  const sessions = [
    { id: 'intro', preview: 'Z first', cwd: '/code/z', updatedAt: 5 },
    { id: 'alpha', preview: 'Alpha', cwd: '/code/a/subdir', updatedAt: 11 },
    { id: 'newest', name: 'A last', cwd: '/worktree/z', recencyAt: 20 },
    { id: 'nested', cwd: '/code/z/tools', updatedAt: 15 },
  ];
  const by = (sort) =>
    groupSessions(sessions, projects, { '/worktree/z': '/code/z' }, sort);
  assert.deepEqual(
    by('recent-desc').map(({ name }) => name),
    ['Zebra', 'Tools', 'Alpha'],
  );
  assert.deepEqual(
    by('recent-asc').map(({ name }) => name),
    ['Alpha', 'Tools', 'Zebra'],
  );
  assert.deepEqual(
    by('alpha-asc').map(({ name }) => name),
    ['Alpha', 'Tools', 'Zebra'],
  );
  assert.deepEqual(
    by('alpha-desc')[0].items.map(({ id }) => id),
    ['intro', 'newest'],
  );
  assert.deepEqual(
    by('alpha-asc')
      .at(-1)
      .items.map(({ id }) => id),
    ['newest', 'intro'],
  );
});

test('chat creation resolves local folders and validates model options', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'opus-folder-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const canonical = await fs.realpath(folder);
  const file = path.join(folder, 'plain-file');
  await fs.writeFile(file, 'data');
  assert.equal(await sessionDirectory({ folder }), canonical);
  assert.equal(
    await sessionDirectory({ project: folder, projects: [{ path: folder }] }),
    folder,
  );
  await assert.rejects(
    sessionDirectory({ folder: 'relative' }),
    /absolute folder/,
  );
  await assert.rejects(sessionDirectory({ folder: file }), /does not exist/);
  await assert.rejects(
    sessionDirectory({ folder, project: folder }),
    /absolute folder/,
  );
  assert.throws(
    () => sessionModelOptions({ model: ['invalid'] }),
    /Invalid model/,
  );
  assert.deepEqual(
    sessionModelOptions({ model: ' claude-opus ', effort: 'max' }),
    { model: 'claude-opus', effort: 'max' },
  );
});
