import { test, expect } from '@playwright/test';

const host = 'git.internal.test';
const pr = (number, title, fields = {}) => ({
  url: `https://${host}/team/app/pull/${number}`,
  number,
  title,
  state: 'OPEN',
  roles: [],
  updatedAt: '2026-11-21T15:00:00Z',
  headRefOid: String(number % 10).repeat(40),
  ...fields,
});

async function installFixtures(page, options) {
  const fixture = { pulls: [], jobs: [], events: [], ...options };
  await page.addInitScript(() => {
    globalThis.EventSource = class {
      constructor() {
        globalThis.pushDashboardEvent = (method) =>
          this.onmessage?.({ data: JSON.stringify({ method }) });
      }
      close() {}
    };
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace('/api', '');
    if (request.method() === 'POST')
      fixture.events.push([endpoint, request.postDataJSON()]);
    if (endpoint === '/github/track') {
      const pull = fixture.lookup;
      fixture.pulls = [...fixture.pulls, pull];
      return route.fulfill({ json: pull });
    }
    if (endpoint === '/github/merge') {
      fixture.pulls = fixture.pulls.filter(
        (p) => p.url !== request.postDataJSON().url,
      );
      return route.fulfill({ json: { ok: true } });
    }
    if (endpoint === '/github/submit-review') {
      fixture.pulls = fixture.pulls.map((p) =>
        p.url === request.postDataJSON().url
          ? {
              ...p,
              pendingReview: false,
              reviewedByMe: true,
              reviewedCurrentHead: true,
            }
          : p,
      );
      return route.fulfill({ json: { ok: true } });
    }
    if (endpoint === '/job') {
      fixture.jobs = [
        {
          ...request.postDataJSON(),
          key: 'draft-key',
          id: 'new-review',
          status: 'pending',
          type: 'review',
          comments: [
            { path: 'app.js', line: 8, body: 'Handle an empty result.' },
          ],
        },
      ];
      return route.fulfill({ json: { id: 'new-review' } });
    }
    if (endpoint === '/approvals/draft-key/publish') {
      const [{ url }] = fixture.jobs;
      fixture.jobs = [];
      return route.fulfill({ json: { url } });
    }
    if (endpoint === '/approvals/draft-key')
      return route.fulfill({ json: fixture.jobs[0] });
    const responses = {
      '/status': {
        projects: [],
        available: { gh: true, codex: true },
        settings: { githubHost: host },
        links: fixture.links || {},
      },
      '/github': {
        prs: fixture.pulls,
        issues: [],
        errors: [],
        updated: new Date().toISOString(),
      },
      '/github/closed': {
        items: [pr(99, 'Merged already', { state: 'MERGED' })],
      },
      '/sessions': {
        data:
          url.searchParams.get('reference') === fixture.lookup?.url &&
          fixture.chat
            ? [{ id: fixture.chat }]
            : [],
      },
      '/models': { data: [] },
      '/requests': [],
      '/approvals': { tasks: fixture.jobs },
    };
    return route.fulfill({ json: responses[endpoint] ?? {} });
  });
  return fixture;
}

test('all three PR queues and state filters work together without duplicate cards', async ({
  page,
}) => {
  const pulls = [
    pr(1, 'Request to review', { roles: ['review', 'involved'] }),
    pr(2, 'Needs response', {
      roles: ['reviewed', 'commented'],
      pendingResponse: true,
    }),
    pr(3, 'Check failure on my PR', {
      roles: ['authored', 'commented'],
      checkState: 'FAILURE',
      unaddressedComments: 2,
    }),
    pr(4, 'My mergeable PR', { roles: ['authored'], readyToMerge: true }),
    pr(5, 'My existing GitHub draft', {
      roles: ['review'],
      pendingReview: true,
    }),
  ];
  await installFixtures(page, { pulls });
  await page.goto('/pull-requests');
  const queues = page.getByRole('group', { name: 'Pull request queues' });
  const filter = page.getByLabel('Filter by status');
  await expect(
    page
      .getByRole('region', { name: 'Needs review', exact: true })
      .getByRole('link', { name: 'Request to review' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'In review', exact: true })
      .getByRole('link', { name: 'Needs response' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'My pull requests', exact: true })
      .getByRole('link', { name: 'Check failure on my PR' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Check failure on my PR' }),
  ).toHaveCount(1);
  await queues.getByRole('button', { name: /My pull requests/ }).click();
  await filter.selectOption({ label: 'Failing CI' });
  await expect(page.getByRole('button', { name: 'Fix CI' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Address comments' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'My mergeable PR' })).toHaveCount(
    0,
  );
  await filter.selectOption({ label: 'Unaddressed comments' });
  await expect(
    page.getByRole('link', { name: 'Check failure on my PR' }),
  ).toBeVisible();
  await filter.selectOption({ label: 'Ready to merge' });
  await expect(
    page.getByRole('button', { name: 'Merge', exact: true }),
  ).toBeVisible();
  await queues.getByRole('button', { name: /^All/ }).click();
  await filter.selectOption({ label: 'Pending my response' });
  await expect(
    page.getByRole('link', { name: 'Needs response' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Request to review' }),
  ).toHaveCount(0);
  await filter.selectOption({ label: 'Draft comments' });
  await expect(
    page.getByRole('button', { name: 'Submit review' }),
  ).toBeVisible();
  await filter.selectOption({ label: 'All statuses' });
  await page.getByLabel('Include closed PRs').check();
  await expect(
    page.getByRole('link', { name: 'Merged already' }),
  ).toBeVisible();
});

test('Focus clears completed review and repair actions when GitHub updates', async ({
  page,
}) => {
  const review = pr(1, 'Needs your review', { roles: ['review'] });
  const broken = pr(2, 'Resolve conflicts in my PR', {
    roles: ['authored'],
    mergeable: 'CONFLICTING',
  });
  const fixture = await installFixtures(page, { pulls: [review, broken] });
  await page.goto('/');
  await expect(page.getByRole('link', { name: review.title })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resolve conflicts', exact: true }),
  ).toBeVisible();
  fixture.pulls = [
    { ...review, reviewedByMe: true, reviewedCurrentHead: true },
    { ...broken, mergeable: 'MERGEABLE' },
  ];
  await page.evaluate(() => globalThis.pushDashboardEvent('github/updated'));
  await expect(page.getByText('Nothing needs your attention.')).toBeVisible();
  await expect(page.getByRole('link', { name: review.title })).toHaveCount(0);
  await expect(page.getByRole('link', { name: broken.title })).toHaveCount(0);
});

test('a custom-host URL finds matching history and re-review stays a draft until explicit publication', async ({
  page,
}) => {
  const external = pr(6, 'A pull request outside my queue', {
    roles: ['tracked'],
    reviewedByMe: true,
  });
  const fixture = await installFixtures(page, {
    lookup: external,
    chat: 'claude:history-chat',
  });
  await page.goto('/pull-requests');
  const lookup = page.getByRole('region', { name: 'Open a pull request' });
  await lookup
    .getByLabel('Pull request URL')
    .fill(external.url + '/files?diff=split#discussion_r42');
  await lookup.getByRole('button', { name: 'Open PR' }).click();
  await expect(
    lookup.getByRole('link', { name: 'Open in Orchestrator' }),
  ).toHaveAttribute('href', '/sessions/claude%3Ahistory-chat');
  await expect(page.getByRole('link', { name: external.title })).toHaveCount(1);
  expect(fixture.events.map(([path]) => path)).toEqual(['/github/track']);
  expect(fixture.events[0][1]).toEqual({ url: external.url });
  await lookup.getByRole('button', { name: 'Re-review', exact: true }).click();
  await lookup.getByRole('button', { name: 'Review & publish' }).click();
  await expect(page.getByText('Handle an empty result.')).toBeVisible();
  expect(fixture.events.map(([path]) => path)).toEqual([
    '/github/track',
    '/job',
  ]);
  await page.getByRole('button', { name: 'Publish to GitHub' }).click();
  await expect(
    page.getByRole('heading', { name: 'Published to GitHub' }),
  ).toBeVisible();
  expect(fixture.events.at(-1)[0]).toBe('/approvals/draft-key/publish');
});

test('an off-list PR without a matching chat can start a first review', async ({
  page,
}) => {
  const external = pr(7, 'Off-list PR');
  const fixture = await installFixtures(page, { lookup: external });
  await page.goto('/pull-requests');
  const lookup = page.getByRole('region', { name: 'Open a pull request' });
  await lookup.getByLabel('Pull request URL').fill(external.url);
  await lookup.getByRole('button', { name: 'Open PR' }).click();
  await expect(
    lookup.getByRole('link', { name: 'Open in Orchestrator' }),
  ).toHaveCount(0);
  await lookup.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(
    lookup.getByRole('button', { name: 'Review & publish' }),
  ).toBeVisible();
  expect(fixture.events.at(-1)).toEqual([
    '/job',
    { url: external.url, kind: 'review' },
  ]);
});

test('GitHub merge and existing pending review need separate confirmation', async ({
  page,
}) => {
  const draft = pr(7, 'Existing GitHub draft', {
    roles: ['review'],
    pendingReview: true,
  });
  const mergeable = pr(8, 'Merge this PR', {
    roles: ['authored'],
    readyToMerge: true,
  });
  const fixture = await installFixtures(page, { pulls: [draft, mergeable] });
  await page.goto('/pull-requests');
  await page
    .getByRole('button', { name: 'Submit review', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Submit review' }),
  ).toBeVisible();
  expect(fixture.events).toEqual([]);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel' })
    .click();
  await page
    .getByRole('button', { name: 'Submit review', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Submit review' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Re-review', exact: true }),
  ).toBeVisible();
  expect(fixture.events[0]).toEqual([
    '/github/submit-review',
    { url: draft.url, headRefOid: draft.headRefOid },
  ]);
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Merge pull request' }),
  ).toBeVisible();
  expect(fixture.events).toHaveLength(1);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Merge pull request' })
    .click();
  await expect(page.getByRole('link', { name: mergeable.title })).toHaveCount(
    0,
  );
  expect(fixture.events[1]).toEqual([
    '/github/merge',
    { url: mergeable.url, headRefOid: mergeable.headRefOid },
  ]);
});

test('an inspected PR can submit a written review with no existing chat or draft', async ({
  page,
}) => {
  const pull = pr(15, 'A review to write');
  const fixture = await installFixtures(page, { lookup: pull });
  await page.goto('/pull-requests');
  await page.getByLabel('Pull request URL').fill(pull.url);
  await page.getByRole('button', { name: 'Open PR' }).click();
  await page.getByRole('button', { name: 'Write review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit review' });
  await expect(
    dialog.getByRole('button', { name: 'Submit review' }),
  ).toBeDisabled();
  expect(
    fixture.events.some(([event]) => event === '/github/submit-review'),
  ).toBe(false);
  await dialog
    .getByLabel('Review feedback')
    .fill('Verified the migration behavior.');
  await dialog.getByRole('button', { name: 'Submit review' }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.events).toContainEqual([
    '/github/submit-review',
    {
      url: pull.url,
      headRefOid: pull.headRefOid,
      body: 'Verified the migration behavior.',
    },
  ]);
});
