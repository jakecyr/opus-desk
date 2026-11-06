import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobPrompt, autoCandidates } from '../server/core.js';
import {
  reviewDefaults,
  validateReviewSettings,
} from '../server/review-policy.js';
import {
  linkedIssueUrls,
  hasSubmittedReview,
  loadReviewContext,
} from '../server/reviews.js';

const url = 'https://github.com/team/app/pull/10';

test('manual and Auto reviews always require publishing approval', () => {
  assert.equal(reviewDefaults.publishReviews, false);
  for (const options of [
    {},
    { auto: true },
    { publish: false },
    { publish: true },
    { publish: 'true' },
    { publish: 'false' },
  ]) {
    const prompt = jobPrompt('review', url, options);
    assert.match(prompt, /pending GitHub review/);
    assert.match(prompt, /Do not submit or publish/);
    assert.match(prompt, /omit the event field/);
  }
  assert.throws(
    () => validateReviewSettings({ publishReviews: true }),
    /approval/,
  );
});

test('default review criteria cover context, engineering quality, and concise suggestions', () => {
  const prompt = jobPrompt('review', url);
  for (const text of [
    /PR description/,
    /linked issue/,
    /prior reviews/,
    /breaking API/,
    /simplicity/,
    /code smells/,
    /software design/,
    /one to three short sentences/,
    /suggestion block/,
    /Skip cosmetic nits/,
  ])
    assert.match(prompt, text);
  assert.doesNotMatch(prompt, /Additional review preferences/);
  assert.doesNotMatch(
    jobPrompt('review', url, { preferences: ' \n ' }),
    /Additional review preferences/,
  );
});

test('tone, scope, and nonblank custom criteria are included without replacing publication policy', () => {
  const prompt = jobPrompt('review', url, {
    tone: 'direct',
    scope: 'thorough',
    preferences: '  Check migration compatibility.  ',
  });
  assert.match(prompt, /direct and matter-of-fact/);
  assert.match(prompt, /small number of useful nits/);
  assert.match(prompt, /Additional review preferences/);
  assert.match(prompt, /Check migration compatibility\./);
  assert.match(prompt, /current publication policy still applies/);
  assert.match(
    jobPrompt('review', url, { scope: 'blocking' }),
    /Report only problems that should be fixed before merging/,
  );
  assert.equal(
    validateReviewSettings({ reviewPreferences: '   ' }).reviewPreferences,
    '',
  );
  for (const value of [
    { publishReviews: 'true' },
    { reviewTone: 'unknown' },
    { reviewScope: 'unknown' },
    { reviewPreferences: 42 },
    { reviewPreferences: 'a'.repeat(8001) },
  ])
    assert.throws(() => validateReviewSettings(value));
});

test('linked issues include attached, cross-repo, description, and discussion references', () => {
  const urls = linkedIssueUrls(
    {
      closingIssuesReferences: [
        { url: 'https://github.com/team/app/issues/5' },
      ],
      body: 'Fixes #5 and other/lib#7. See https://github.com/team/api/issues/9.',
    },
    'team/app',
    [{ body: 'Acceptance criteria in #8' }],
  );
  assert.deepEqual(
    urls.sort(),
    [
      'https://github.com/other/lib/issues/7',
      'https://github.com/team/api/issues/9',
      'https://github.com/team/app/issues/5',
      'https://github.com/team/app/issues/8',
    ].sort(),
  );
});

test('drafts are not submitted reviews; re-reviews compare previous feedback', () => {
  assert.equal(
    hasSubmittedReview([{ user: { login: 'ME' }, state: 'COMMENTED' }], 'me'),
    true,
  );
  assert.equal(
    hasSubmittedReview([{ user: { login: 'me' }, state: 'PENDING' }], 'me'),
    false,
  );
  assert.equal(
    hasSubmittedReview(
      [{ user: { login: 'someone' }, state: 'APPROVED' }],
      'me',
    ),
    false,
  );
  const prompt = jobPrompt('review', url, {
    context: { reviewedByMe: true, pullRequest: { title: 'Example' } },
  });
  assert.match(prompt, /^Re-review/);
  assert.match(prompt, /previously reviewed commits/);
  assert.match(prompt, /without deleting the user’s draft comments/);
  assert.match(prompt, /BEGIN_GITHUB_REVIEW_CONTEXT/);
});

test('review context combines paginated discussions, review history, and issue discussions', async () => {
  const calls = [];
  const fake = async (file, args) => {
    assert.equal(file, 'gh');
    calls.push(args);
    if (args[0] === 'pr')
      return JSON.stringify({
        title: 'Fix',
        body: 'Fixes #5',
        headRefOid: 'current',
        closingIssuesReferences: [
          { url: 'https://github.com/team/app/issues/5' },
        ],
      });
    if (args.at(-1) === 'user') return JSON.stringify({ login: 'me' });
    const responses = {
      'repos/team/app/issues/10/comments': [
        [{ id: 1, user: { login: 'author' }, body: 'PR conversation' }],
        [{ id: 2, body: 'More discussion' }],
      ],
      'repos/team/app/pulls/10/reviews': [
        [
          {
            id: 3,
            user: { login: 'me' },
            body: 'Earlier review',
            state: 'COMMENTED',
            commit_id: 'previous',
          },
        ],
      ],
      'repos/team/app/pulls/10/comments': [
        [{ id: 4, body: 'Existing inline feedback', path: 'app.js', line: 8 }],
      ],
      'repos/team/app/issues/5': {
        title: 'Issue acceptance criteria',
        body: 'Expected behavior',
        state: 'open',
      },
      'repos/team/app/issues/5/comments': [
        [{ id: 6, body: 'Issue discussion' }],
      ],
    };
    if (!(args.at(-1) in responses)) throw Error('Unexpected fixture request');
    return JSON.stringify(responses[args.at(-1)]);
  };
  const context = await loadReviewContext(url, fake);
  assert.equal(context.comments.length, 2);
  assert.equal(context.inlineComments[0].path, 'app.js');
  assert.equal(context.reviews[0].commit, 'previous');
  assert.equal(context.reviewedByMe, true);
  assert.equal(context.issues[0].body, 'Expected behavior');
  assert.equal(context.issues[0].comments[0].body, 'Issue discussion');
  assert.equal(calls.filter((args) => args.includes('--paginate')).length, 4);
});

test('Auto mode includes PRs assigned to the user', () => {
  assert.equal(
    autoCandidates({
      prs: [{ url, roles: ['assigned'], headRefOid: 'new' }],
      issues: [],
    })[0].kind,
    'review',
  );
});
