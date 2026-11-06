import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  githubUrl,
  jobPrompt,
  searchText,
  autoCandidates,
} from '../server/core.js';
test('accepts valid PR and issue links, rejects non-GitHub and malformed links', () => {
  assert.deepEqual(githubUrl('https://github.com/a/b/pull/42'), {
    repo: 'a/b',
    number: 42,
    kind: 'pull',
  });
  assert.equal(
    githubUrl('https://github.com/a/b/issues/7?source=test#x').kind,
    'issues',
  );
  for (const x of [
    'https://github.com.evil/a/b/pull/1',
    'https://github.com/a/b/pull/1/other',
    'file:///x',
    '',
  ])
    assert.throws(() => githubUrl(x));
});
test('review workflow requests pending comments by default', () => {
  assert.match(
    jobPrompt('review', 'https://github.com/a/b/pull/1'),
    /pending GitHub review/,
  );
  assert.match(
    jobPrompt('review', 'x', { publish: true }),
    /Do not submit or publish/,
  );
});
test('manual Fix CI prepares commits for an authorized push and diagnoses current job logs', () => {
  const prompt = jobPrompt('ci', 'https://github.com/a/b/pull/1', {
    pushOnCompletion: true,
  });
  assert.match(prompt, /latest failing checks and their job logs/);
  assert.match(prompt, /without discarding unrelated local changes/);
  assert.match(prompt, /Do not disable checks or weaken tests/);
  assert.match(prompt, /Opus Desk will validate and push/);
  assert.match(prompt, /Do not push directly, force-push, merge/);
  assert.doesNotMatch(prompt, /stop for human approval/);
  assert.match(
    jobPrompt('ci', 'https://github.com/a/b/pull/1'),
    /stop for human approval/,
  );
});
test('PR repair workflows integrate the latest base and resolve conflicts', () => {
  for (const kind of ['ci', 'comments', 'conflicts']) {
    const prompt = jobPrompt(kind, 'https://github.com/a/b/pull/1');
    assert.match(prompt, /Fetch the latest PR base branch/);
    assert.match(prompt, /merge it into the working branch/);
    assert.match(prompt, /resolve any conflicts/);
    assert.match(prompt, /preserving the original PR head/);
    assert.match(prompt, /Run relevant checks after integrating the base/);
  }
});
test('issue workflow does not exceed selected outcome', () => {
  assert.match(
    jobPrompt('issue', 'x', { outcome: 'local changes only' }),
    /Do not perform steps beyond/,
  );
});
test('search matches all terms case insensitively', () => {
  assert.equal(
    searchText({ title: 'Fix error', repo: 'x/y' }, 'fix X/Y'),
    true,
  );
  assert.equal(searchText({ title: 'Fix error' }, 'missing'), false);
});

test('auto mode deduplicates events by PR revision and issue identity', () => {
  const cache = {
    prs: [
      {
        url: 'https://github.com/a/b/pull/1',
        roles: ['authored', 'review'],
        headRefOid: 'aaa',
        baseRefOid: 'bbb',
        mergeable: 'CONFLICTING',
        checkState: 'FAILURE',
        failedChecks: ['test'],
      },
    ],
    issues: [{ url: 'https://github.com/a/b/issues/2' }],
  };
  const first = autoCandidates(cache);
  assert.deepEqual(
    first.map((x) => x.kind),
    ['conflicts', 'ci', 'review', 'issue'],
  );
  const known = Object.fromEntries(
    first.map((x) => [x.key, { status: 'completed' }]),
  );
  assert.equal(autoCandidates(cache, known).length, 0);
  cache.prs[0].headRefOid = 'ccc';
  assert.deepEqual(
    autoCandidates(cache, known).map((x) => x.kind),
    ['conflicts', 'ci', 'review'],
  );
});
