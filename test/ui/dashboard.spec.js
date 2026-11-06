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
