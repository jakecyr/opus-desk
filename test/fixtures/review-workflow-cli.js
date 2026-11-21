#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';

const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const readFixture = () =>
  JSON.parse(fs.readFileSync(process.env.REVIEW_FIXTURE, 'utf8'));
const record = (file, value) =>
  fs.appendFileSync(file, JSON.stringify(value) + '\n');

if (tool === 'gh') {
  const fixture = readFixture();
  const author = { login: 'contributor' };
  const pr = {
    url: 'https://github.com/a/b/pull/7',
    number: 7,
    title: 'PR intent',
    body: 'Fixes #5',
    state: 'OPEN',
    isDraft: false,
    author,
    headRefOid: fixture.head,
    baseRefOid: fixture.base,
    baseRefName: 'master',
    headRefName: 'fix-ci',
    headRepository: { name: 'fork' },
    headRepositoryOwner: author,
    updatedAt: '2026-01-02T00:00:00Z',
    repository: { nameWithOwner: 'a/b' },
    closingIssuesReferences: [{ url: 'https://github.com/a/b/issues/5' }],
  };
  const viewer = { login: 'me' };
  const review = {
    author: viewer,
    user: viewer,
    state: 'COMMENTED',
    body: 'Earlier feedback',
    commit: { oid: fixture.head },
    commit_id: 'older',
    submittedAt: '2026-01-01T00:00:00Z',
  };
  const pending = {
    id: 99,
    databaseId: 99,
    author: viewer,
    user: viewer,
    state: 'PENDING',
    body: 'Draft body',
    commit_id: fixture.head,
  };
  const reviews = fixture.previouslyReviewed ? [review] : [];
  const responses = {
    user: viewer,
    'repos/a/b/issues/7/comments': [[{ body: 'PR discussion' }]],
    'repos/a/b/pulls/7/reviews': [
      [...reviews, ...(fixture.pending ? [pending] : [])],
    ],
    'repos/a/b/pulls/7/reviews/99/comments': [
      [{ id: 1, path: 'file.txt', line: 1, body: 'Check the edge case.' }],
    ],
    'repos/a/b/pulls/7/comments': [
      [{ body: 'Inline discussion', path: 'file.txt', line: 1 }],
    ],
    'repos/a/b/issues/5': {
      title: 'Linked issue',
      body: 'Acceptance criteria',
    },
    'repos/a/b/issues/5/comments': [[{ body: 'Issue discussion' }]],
  };
  let result;
  if (args.includes('--method')) {
    const input = args.indexOf('--input');
    record(
      process.env.REVIEW_WRITES,
      input < 0
        ? args
        : { args, body: JSON.parse(fs.readFileSync(args[input + 1], 'utf8')) },
    );
    result = { id: 100 };
  } else if (args[0] === 'issue' && args[1] === 'comment') {
    record(process.env.REVIEW_WRITES, fs.readFileSync(args.at(-1), 'utf8'));
    result = {};
  } else if (args[0] === '--version') {
    console.log('gh test');
    process.exit(0);
  } else if (args[0] === 'search') {
    const reviewFlag = fixture.previouslyReviewed
      ? '--reviewed-by'
      : '--review-requested';
    result =
      fixture.auto && args[1] === 'prs' && args.includes(reviewFlag)
        ? [pr]
        : [];
  } else if (args[0] === 'pr' && args[1] === 'view') {
    if (fixture.fail) process.exit(1);
    result =
      fixture.stale && args.at(-1) === 'headRefOid,state,isDraft,author'
        ? { ...pr, headRefOid: fixture.base }
        : pr;
  } else if (args[0] === 'api' && args.includes('graphql')) {
    const root = { author: viewer, createdAt: review.submittedAt };
    result = {
      data: {
        viewer,
        p0: {
          pullRequest: {
            ...pr,
            mergeable: 'MERGEABLE',
            reviewRequests: {
              nodes:
                fixture.previouslyReviewed || fixture.withdrawn
                  ? []
                  : [{ requestedReviewer: viewer }],
            },
            reviews: {
              nodes: [
                ...reviews,
                ...(fixture.pending && !fixture.latePending ? [pending] : []),
              ],
            },
            reviewThreads: {
              nodes: fixture.response
                ? [
                    {
                      id: 'thread',
                      root: { nodes: [root] },
                      recent: {
                        nodes: [root, { author, createdAt: fixture.response }],
                      },
                    },
                  ]
                : [],
            },
            commits: { nodes: [] },
          },
        },
      },
    };
  } else {
    result = responses[args.at(-1).split('?')[0]];
    if (result === undefined) process.exit(1);
  }
  console.log(JSON.stringify(result));
} else if (tool === 'codex') {
  if (args.includes('--version')) {
    console.log('codex test');
    process.exit(0);
  }
  let count = 0;
  const directories = new Map();
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (!message.id) return;
    record(process.env.REVIEW_CALLS, message);
    const { id, method, params } = message;
    const cwd = directories.get(params?.threadId) || process.env.REVIEW_PROJECT;
    let result = {};
    if (method === 'thread/start') {
      const threadId = 'thread-' + ++count;
      directories.set(threadId, params.cwd);
      result = { thread: { id: threadId } };
    } else if (method === 'thread/read') {
      result = { thread: { id: params.threadId, cwd } };
    } else if (method === 'mcpServerStatus/list') {
      result = { data: [], nextCursor: null };
    } else if (method === 'turn/start') {
      const prompt = params.input[0].text;
      if (prompt.includes('user selected Fix CI')) {
        execFileSync('/usr/bin/git', [
          '-C',
          cwd,
          'merge',
          '--ff-only',
          readFixture().head,
        ]);
        fs.appendFileSync(path.join(cwd, 'file.txt'), ' CI fix');
        execFileSync('/usr/bin/git', [
          '-C',
          cwd,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qam',
          'fix: repair CI',
        ]);
      }
      const artifact = prompt.match(
        /Write only JSON to this local artifact path: (".*?")\. Use /,
      )?.[1];
      if (artifact) {
        fs.writeFileSync(
          JSON.parse(artifact),
          JSON.stringify({
            body: 'Prepared review',
            comments: [
              {
                path: 'file.txt',
                line: 1,
                body: 'Keep the final record.\n\n```suggestion\ncomplete\n```',
              },
            ],
          }),
        );
      }
      record(process.env.REVIEW_PROMPTS, prompt);
      setTimeout(
        () =>
          console.log(
            JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: params.threadId,
                turn: { status: 'completed' },
              },
            }),
          ),
        readFixture().delay || 20,
      );
    }
    console.log(JSON.stringify({ id, result }));
  });
} else if (tool === 'git') {
  if (args.includes('push')) {
    record(process.env.REVIEW_PUSHES, args);
    process.exit(0);
  }
  let gitArgs = args;
  if (args.some((arg) => arg.endsWith(':refs/opusdesk/head'))) {
    const { head, base } = readFixture();
    gitArgs = [
      '-C',
      args[1],
      'fetch',
      '--quiet',
      process.env.REVIEW_PROJECT,
      head + ':refs/opusdesk/head',
      base + ':refs/opusdesk/base',
    ];
  }
  const result = spawnSync('/usr/bin/git', gitArgs, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
