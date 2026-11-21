import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesPullFilter,
  needsFocus,
  pullUrlKey,
  queueForPull,
} from '../src/pull-queues.js';

const open = { state: 'OPEN' };

test('each PR has one queue, with current review and authored work taking precedence', () => {
  const requested = { ...open, roles: ['review'] };
  assert.equal(queueForPull(requested), 'needs-review');
  assert.equal(
    queueForPull({
      ...requested,
      reviewedByMe: true,
      reviewedCurrentHead: true,
    }),
    'other',
  );
  assert.equal(
    queueForPull({
      ...requested,
      reviewedByMe: true,
      reviewedCurrentHead: false,
    }),
    'needs-review',
  );
  assert.equal(
    queueForPull({ ...requested, pendingReview: true }),
    'in-review',
  );
  assert.equal(
    queueForPull({ ...requested, pendingResponse: true }),
    'in-review',
  );
  assert.equal(
    queueForPull(requested, { kind: 'review', status: 'running' }),
    'in-review',
  );
  assert.equal(
    queueForPull(requested, { kind: 'review', status: 'pending' }),
    'in-review',
  );
  assert.equal(
    queueForPull(requested, { kind: 'ci', status: 'running' }),
    'needs-review',
  );
  assert.equal(
    queueForPull({ ...requested, roles: ['authored', 'review'] }),
    'mine',
  );
  assert.equal(queueForPull({ ...open, roles: ['tracked'] }), 'other');
  assert.equal(queueForPull({ ...requested, state: 'MERGED' }), 'closed');
});

test('condition filters apply independently of queue placement', () => {
  const owned = {
    ...open,
    roles: ['authored'],
    readyToMerge: true,
    pendingResponse: true,
    unaddressedComments: 1,
  };
  assert.equal(matchesPullFilter(owned, 'ready'), true);
  assert.equal(
    matchesPullFilter({ ...owned, state: 'MERGED' }, 'ready'),
    false,
  );
  assert.equal(matchesPullFilter({ ...owned, isDraft: true }, 'ready'), false);
  assert.equal(matchesPullFilter(owned, 'reply'), true);
  assert.equal(matchesPullFilter(owned, 'feedback'), true);
  assert.equal(
    matchesPullFilter({ ...owned, roles: ['review'] }, 'feedback'),
    false,
  );
  assert.equal(
    matchesPullFilter(
      { ...owned, unaddressedComments: 0, feedbackFingerprint: 'old' },
      'feedback',
    ),
    false,
  );
  assert.equal(
    matchesPullFilter({ ...open, pendingReview: true }, 'pending'),
    true,
  );
  assert.equal(
    matchesPullFilter(open, 'pending', { kind: 'review', status: 'pending' }),
    true,
  );
  assert.equal(
    matchesPullFilter(open, 'pending', { kind: 'ci', status: 'pending' }),
    false,
  );
  assert.equal(
    matchesPullFilter(open, 'pending', {
      kind: 'ci',
      status: 'pending',
      pendingTasks: [{ kind: 'review', status: 'pending' }],
    }),
    true,
  );
  assert.equal(
    matchesPullFilter({ ...open, checkState: 'ERROR' }, 'failing'),
    true,
  );
  assert.equal(
    matchesPullFilter({ ...open, failedChecks: ['lint'] }, 'failing'),
    true,
  );
  assert.equal(
    matchesPullFilter({ ...open, mergeable: 'CONFLICTING' }, 'conflicts'),
    true,
  );
});

test('Focus follows synchronized state and leaves prepared work to approvals', () => {
  const requested = { ...open, roles: ['review'] };
  assert.equal(needsFocus(requested), true);
  assert.equal(
    needsFocus({ ...requested, reviewedByMe: true, reviewedCurrentHead: true }),
    false,
  );
  assert.equal(needsFocus({ ...open, pendingResponse: true }), true);
  assert.equal(needsFocus({ ...open, pendingReview: true }), true);
  assert.equal(
    needsFocus(requested, { kind: 'review', status: 'pending' }),
    false,
  );
  assert.equal(
    needsFocus(requested, { kind: 'review', status: 'running' }),
    true,
  );
  assert.equal(needsFocus({ ...requested, state: 'CLOSED' }), false);
  const own = { ...open, roles: ['authored'] };
  assert.equal(needsFocus(own), false);
  for (const action of [
    { checkState: 'FAILURE' },
    { readyToMerge: true },
    { pendingResponse: true },
    { unaddressedComments: 3 },
    { mergeable: 'CONFLICTING' },
  ]) {
    assert.equal(needsFocus({ ...own, ...action }), true);
  }
  assert.equal(
    needsFocus({ ...open, roles: ['tracked'], checkState: 'FAILURE' }),
    false,
  );
});

test('PR URL identity supports custom hosts, strips presentation suffixes and retains host scope', () => {
  const url = 'https://git.corp.test/team/lib/pull/7';
  assert.equal(
    pullUrlKey(
      'https://Git.Corp.Test/Team/Lib/pull/007/?foo=bar#discussion_r9',
    ),
    url,
  );
  assert.equal(pullUrlKey('https://Git.Corp.Test/Team/Lib/pull/7/files'), url);
  assert.notEqual(pullUrlKey('https://github.com/team/lib/pull/7'), url);
  for (const value of [
    'https://git.corp.test/team/lib/issues/7',
    'https://git.corp.test/team/lib/pull/7/files/unknown',
    'https://ignored@git.corp.test/team/lib/pull/7',
    'http://git.corp.test/team/lib/pull/7',
    'https://git.corp.test/team/lib/pull/9007199254740992',
  ]) {
    assert.equal(pullUrlKey(value), '');
  }
});
