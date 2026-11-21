import { test, expect } from '@playwright/test';

const projects = [
  { name: 'Arc', path: '/projects/arc' },
  { name: 'Beacon', path: '/projects/beacon' },
];
const chats = [
  {
    id: 'codex-chat',
    name: 'Search work',
    cwd: projects[1].path,
    updatedAt: 2,
  },
  {
    id: 'claude:chat',
    name: 'Initial task',
    cwd: projects[0].path,
    updatedAt: 1,
    agent: 'claude',
  },
];
const utilities = {
  '/api/status': {
    projects,
    available: { gh: true, codex: true, claude: true },
    settings: { defaultAgent: 'codex' },
    links: {},
  },
  '/api/github': { prs: [], issues: [], errors: [] },
  '/api/requests': [],
  '/api/approvals': { tasks: [] },
};

test('orchestrator searches all projects, sorts both ways, and starts chats in projects or folders', async ({
  page,
}) => {
  let query;
  const created = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': connected\n\n',
      });
    if (url.pathname === '/api/sessions') {
      if (url.searchParams.has('q')) {
        query = {
          text: url.searchParams.get('q'),
          scope: url.searchParams.get('archived'),
        };
        return route.fulfill({
          json: { data: [{ ...chats[1], archived: true }] },
        });
      }
      return route.fulfill({ json: { data: chats } });
    }
    if (url.pathname === '/api/session') {
      created.push(route.request().postDataJSON());
      return route.fulfill({ json: { id: 'draft:new' } });
    }
    if (url.pathname.startsWith('/api/session/'))
      return route.fulfill({
        json: { thread: { id: 'draft:new', turns: [] }, options: {} },
      });
    return route.fulfill({ json: utilities[url.pathname] ?? { data: [] } });
  });
  await page.goto('/sessions');
  const groups = page.locator('.session-group .group-name');
  const sort = page.getByRole('combobox', { name: 'Sort chats' });
  await expect(groups).toHaveText(['Beacon', 'Arc']);
  await sort.selectOption('recent-asc');
  await expect(groups).toHaveText(['Arc', 'Beacon']);
  await sort.selectOption('alpha-desc');
  await expect(groups).toHaveText(['Beacon', 'Arc']);
  await sort.selectOption('alpha-asc');
  await expect(groups).toHaveText(['Arc', 'Beacon']);
  await page
    .getByRole('textbox', { name: 'Search chats' })
    .fill('word from old thread');
  await expect(
    page.getByRole('button', { name: /Initial task/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Search work/ })).toHaveCount(
    0,
  );
  expect(query).toEqual({ text: 'word from old thread', scope: 'all' });
  await page.getByRole('textbox', { name: 'Search chats' }).clear();
  await page.getByRole('button', { name: 'New chat in Beacon' }).click();
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue(
    '/projects/beacon',
  );
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page).toHaveURL(/\/sessions\/draft%3Anew$/);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Project' })
    .selectOption('__folder');
  await page
    .getByRole('textbox', { name: 'Folder path' })
    .fill('/other/local folder');
  await page.getByRole('button', { name: 'Start chat' }).click();
  expect(created[0]).toMatchObject({
    project: '/projects/beacon',
    agent: 'codex',
  });
  expect(created[1]).toMatchObject({
    folder: '/other/local folder',
    agent: 'codex',
  });
  expect(created[1]).not.toHaveProperty('project');
});

test('orchestrator changes model and reasoning, steers a running turn, then stops and sends a new turn', async ({
  page,
}) => {
  let active = true;
  let options = { model: 'standard', effort: 'low' };
  const writes = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': connected\n\n',
      });
    if (url.pathname === '/api/sessions')
      return route.fulfill({ json: { data: chats } });
    if (url.pathname === '/api/models')
      return route.fulfill({
        json: {
          data: [
            { id: 'standard', displayName: 'Standard' },
            {
              id: 'alternate',
              displayName: 'Alternate',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            },
          ],
        },
      });
    if (url.pathname === '/api/session/codex-chat')
      return route.fulfill({
        json: {
          thread: { ...chats[0], turns: [] },
          externalUse: { available: true, blocked: false },
          options,
          active,
        },
      });
    if (url.pathname.startsWith('/api/session/codex-chat/')) {
      const action = url.pathname.split('/').at(-1);
      const body = route.request().postDataJSON();
      writes.push({ action, body });
      if (action === 'options') options = body;
      if (action === 'interrupt') active = false;
      return route.fulfill({ json: { id: 'codex-chat', options } });
    }
    return route.fulfill({ json: utilities[url.pathname] ?? {} });
  });
  await page.goto('/sessions/codex-chat');
  const settings = page.getByRole('button', {
    name: 'Chat model and reasoning',
  });
  await settings.click();
  await page
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('alternate');
  await page
    .getByRole('combobox', { name: 'Reasoning', exact: true })
    .selectOption('high');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toHaveAttribute('title', 'alternate · high');
  const composer = page.getByRole('textbox', { name: 'Chat message' });
  await composer.fill('Steer this work');
  await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Steer', exact: true }),
  ).toHaveCount(0);
  await composer.fill('Next turn');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  expect(writes).toEqual([
    { action: 'options', body: { model: 'alternate', effort: 'high' } },
    { action: 'message', body: { text: 'Steer this work', mode: 'steer' } },
    { action: 'interrupt', body: {} },
    { action: 'message', body: { text: 'Next turn', mode: 'send' } },
  ]);
});
