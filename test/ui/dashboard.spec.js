import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': connected\n\n',
      });
    const responses = {
      '/api/status': {
        projects: [],
        available: { gh: true, codex: false, claude: true },
        settings: { defaultAgent: 'claude', root: '/projects', interval: 120 },
        links: {},
        autoEnabled: false,
      },
      '/api/github': {
        prs: [],
        issues: [],
        errors: [],
        updated: new Date().toISOString(),
      },
      '/api/sessions': { data: [] },
      '/api/models': { data: [] },
      '/api/requests': [],
      '/api/auto': { enabled: true },
    };
    await route.fulfill({ json: responses[pathname] ?? {} });
  });
});

test('empty dashboard, navigation, and theme work without Codex', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Opus Desk', { exact: true })).toBeVisible();
  await expect(
    page.getByText("You're all caught up on review requests."),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Issues', exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(
    page.getByRole('heading', { name: /^Issues\.?$/ }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/focus$/);
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(errors).toEqual([]);
});

test('a deep link loads and auto mode sends the application header', async ({
  page,
}) => {
  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { name: /^Settings\.?$/ }),
  ).toBeVisible();
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/auto') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: /Auto off/ }).click();
  const sent = await request;
  expect(sent.headers()['x-prquay']).toBe('local');
  expect(sent.postDataJSON()).toEqual({ enabled: true });
});

test('PR actions stay on the page, show progress and chat links, and block duplicate actions', async ({
  page,
}) => {
  const url = 'https://github.com/team/app/pull/7';
  const tasks = [];
  await page.route('**/api/approvals', (route) =>
    route.fulfill({ json: { tasks } }),
  );
  await page.route('**/api/github', (route) =>
    route.fulfill({
      json: {
        prs: [
          {
            url,
            number: 7,
            title: 'Broken CI',
            state: 'OPEN',
            repository: { nameWithOwner: 'team/app' },
            roles: ['review'],
            checkState: 'FAILURE',
            failedChecks: ['lint'],
          },
          {
            url: 'https://github.com/team/app/pull/8',
            number: 8,
            title: 'Passing CI',
            state: 'OPEN',
            roles: ['review'],
            checkState: 'SUCCESS',
          },
        ],
        issues: [],
        errors: [],
        updated: new Date().toISOString(),
      },
    }),
  );
  await page.route('**/api/status', (route) =>
    route.fulfill({
      json: {
        projects: [],
        available: { gh: true, codex: false, claude: true },
        settings: { defaultAgent: 'claude', root: '/projects', interval: 120 },
        links: { [url]: 'claude:existing-pr-chat' },
        autoEnabled: false,
      },
    }),
  );
  await page.route('**/api/job', async (route) => {
    const body = route.request().postDataJSON();
    tasks.push({
      ...body,
      id: body.url === url ? 'claude:existing-pr-chat' : 'second-chat',
      key: body.url,
      status: 'running',
    });
    await route.fulfill({ json: { id: tasks.at(-1).id } });
  });
  await page.goto('/pull-requests');
  await expect(
    page.getByRole('button', { name: 'Fix CI', exact: true }),
  ).toHaveCount(1);
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/api/job') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Fix CI', exact: true }).click();
  expect((await request).postDataJSON()).toEqual({
    url,
    kind: 'ci',
    pushOnCompletion: true,
  });
  await expect(page).toHaveURL(/\/pull-requests$/);
  const broken = page.locator('.pr-row').filter({ hasText: 'Broken CI' });
  await expect(broken.getByRole('status')).toHaveText('Fixing CI');
  for (const name of ['Fix CI', 'Review', 'Address comments'])
    await expect(
      broken.getByRole('button', { name, exact: true }),
    ).toBeDisabled();
  await expect(
    broken.getByRole('link', { name: 'Chat', exact: true }),
  ).toHaveAttribute('href', '/sessions/claude%3Aexisting-pr-chat');
  const passing = page.locator('.pr-row').filter({ hasText: 'Passing CI' });
  await passing.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(passing.getByRole('status')).toHaveText('Reviewing');
  await expect(page).toHaveURL(/\/pull-requests$/);
  await page.reload();
  await expect(
    broken.getByRole('button', { name: 'Fix CI', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(
    page
      .locator('.pr-row')
      .filter({ hasText: 'Broken CI' })
      .getByRole('status'),
  ).toHaveText('Fixing CI');
});

test('issue and sprint cards share progress, disabled actions, and a chat link', async ({
  page,
}) => {
  const url = 'https://github.com/team/app/issues/3';
  const item = {
    id: 'task',
    url,
    number: 3,
    title: 'Repair issue',
    body: '',
    kind: 'issue',
    state: 'OPEN',
    status: 'Todo',
    assignees: [{ login: 'me' }],
  };
  const task = {
    url,
    kind: 'issue',
    id: 'issue-chat',
    key: 'task',
    status: 'running',
  };
  await page.route('**/api/approvals', (route) =>
    route.fulfill({ json: { tasks: [task] } }),
  );
  await page.route('**/api/status', (route) =>
    route.fulfill({
      json: {
        projects: [],
        available: {},
        settings: { sprintRepo: 'team/app', sprintProjectId: 'board' },
        links: { [url]: 'issue-chat' },
      },
    }),
  );
  await page.route('**/api/github', (route) =>
    route.fulfill({ json: { prs: [], issues: [item], errors: [] } }),
  );
  await page.route('**/api/sprint', (route) =>
    route.fulfill({
      json: {
        items: [item],
        statuses: ['Todo'],
        iterations: [],
        username: 'me',
        project: { title: 'Board' },
      },
    }),
  );
  await page.goto('/issues');
  for (const name of ['Address issue', 'Add description', 'Comment'])
    await expect(
      page.getByRole('button', { name, exact: true }),
    ).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Addressing issue');
  await expect(
    page.getByRole('link', { name: 'Chat', exact: true }),
  ).toHaveAttribute('href', '/sessions/issue-chat');
  await page.getByRole('button', { name: 'Sprint', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Addressing issue');
  await expect(
    page.getByRole('button', { name: 'Address issue', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('link', { name: 'Chat', exact: true }),
  ).toHaveAttribute('href', '/sessions/issue-chat');
});

test('starting an issue from its dialog stays on Issues and adds its chat link', async ({
  page,
}) => {
  const url = 'https://github.com/team/app/issues/9';
  let tasks = [];
  await page.route('**/api/status', (route) =>
    route.fulfill({
      json: {
        projects: [{ path: '/projects/app', repo: 'team/app', name: 'App' }],
        available: { claude: true },
        settings: { defaultAgent: 'claude' },
        links: {},
      },
    }),
  );
  await page.route('**/api/github', (route) =>
    route.fulfill({
      json: {
        prs: [],
        issues: [
          { url, number: 9, title: 'Fix the issue', state: 'OPEN', body: '' },
        ],
        errors: [],
      },
    }),
  );
  await page.route('**/api/approvals', (route) =>
    route.fulfill({ json: { tasks } }),
  );
  await page.route('**/api/job', async (route) => {
    tasks = [
      {
        ...route.request().postDataJSON(),
        id: 'new-issue-chat',
        status: 'running',
      },
    ];
    await route.fulfill({ json: { id: 'new-issue-chat' } });
  });
  await page.goto('/issues');
  await page
    .getByRole('button', { name: 'Address issue', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Start session', exact: true })
    .click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(page.getByRole('status')).toHaveText('Addressing issue');
  await expect(
    page.getByRole('link', { name: 'Chat', exact: true }),
  ).toHaveAttribute('href', '/sessions/new-issue-chat');
  await expect(
    page.getByRole('button', { name: 'Address issue', exact: true }),
  ).toBeDisabled();
});
