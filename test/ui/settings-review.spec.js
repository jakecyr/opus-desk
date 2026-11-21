import { expect, test } from '@playwright/test';

test('each Auto mode action and review criterion can be configured independently', async ({
  page,
}) => {
  let settings = { root: '/projects', defaultAgent: 'codex' };
  await page.route('**/api/**', async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': connected\n\n',
      });
    if (pathname === '/api/settings') {
      settings = { ...settings, ...route.request().postDataJSON() };
      return route.fulfill({ json: settings });
    }
    const responses = {
      '/api/status': {
        settings,
        projects: [],
        available: { codex: true, claude: true, gh: true },
      },
      '/api/github': { prs: [], issues: [], errors: [] },
      '/api/models': {
        data:
          searchParams.get('agent') === 'claude'
            ? [{ id: 'sonnet', displayName: 'Sonnet' }]
            : [],
      },
      '/api/approvals': { tasks: [] },
      '/api/requests': [],
      '/api/sessions': { data: [] },
    };
    return route.fulfill({ json: responses[pathname] ?? {} });
  });
  await page.goto('/settings');
  const first = page
    .locator('details.workflow')
    .filter({ hasText: 'First review' });
  const rereview = page
    .locator('details.workflow')
    .filter({ hasText: 'Re-review' });
  await first.locator('summary').click();
  await rereview.locator('summary').click();
  await expect(first.getByLabel('First review Auto mode')).toHaveValue('draft');
  await rereview.getByLabel('Re-review Auto mode').selectOption('publish');
  await expect(first.getByLabel('First review Auto mode')).toHaveValue('draft');
  await rereview.getByLabel('Provider').selectOption('claude');
  await rereview
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('sonnet');
  await rereview.getByLabel('Reasoning').selectOption('high');
  await expect
    .poll(() => [settings.autoActions, settings.workflows?.rereview])
    .toEqual([
      { rereview: 'publish' },
      { agent: 'claude', model: 'sonnet', effort: 'high' },
    ]);

  await expect(
    page.getByRole('checkbox', { name: 'Optional nits' }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Optional nits' }).check();
  await page.getByRole('checkbox', { name: 'Breaking changes' }).uncheck();
  await page.getByLabel('Related repositories').fill('team/sdk\nteam/api');
  await page.getByLabel('Related repositories').press('Tab');
  await expect
    .poll(() => settings.reviewRelatedRepos)
    .toEqual(['team/sdk', 'team/api']);
  expect(settings.reviewCriteria).toContain('nits');
  expect(settings.reviewCriteria).not.toContain('compatibility');

  await page.reload();
  await expect(
    page.getByRole('checkbox', { name: 'Optional nits' }),
  ).toBeChecked();
  await rereview.locator('summary').click();
  await expect(rereview.getByLabel('Re-review Auto mode')).toHaveValue(
    'publish',
  );
  await expect(rereview.getByLabel('Reasoning')).toHaveValue('high');
});
