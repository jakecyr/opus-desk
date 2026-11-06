import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  iterationProgress,
  issueMetadata,
  loadSprint,
  listRepoProjects,
  enrichIssues,
} from '../server/sprint.js';
test('iteration timeline handles future, current, and ended sprints', () => {
  const iteration = { id: 'i', startDate: '2026-11-01', duration: 14 };
  assert.equal(
    iterationProgress(iteration, Date.parse('2026-11-08T00:00:00Z')).daysLeft,
    7,
  );
  assert.equal(
    iterationProgress(iteration, Date.parse('2026-10-01')).progress,
    0,
  );
  assert.equal(
    iterationProgress(iteration, Date.parse('2026-12-01')).progress,
    100,
  );
  assert.equal(iterationProgress(null), null);
});
test('needs reply follows the last human comment on owned or assigned issues', () => {
  const issue = {
    author: { login: 'author' },
    assignees: { nodes: [{ login: 'me' }] },
    comments: {
      nodes: [
        { author: { login: 'other', __typename: 'User' } },
        { author: { login: 'bot', __typename: 'Bot' } },
      ],
    },
  };
  assert.equal(issueMetadata(issue, 'me').needsReply, true);
  assert.equal(issueMetadata(issue, 'stranger').needsReply, false);
  assert.equal(issueMetadata(issue, '').needsReply, false);
  issue.comments.nodes.push({ author: { login: 'ME', __typename: 'User' } });
  assert.equal(issueMetadata(issue, 'me').needsReply, false);
});
test('Sprint paginates all project repositories and keeps drafts with no invented links', async () => {
  let calls = 0;
  const execute = async (_cmd, args) => {
    calls++;
    const second = args.includes('cursor=next');
    const content = second
      ? { __typename: 'DraftIssue', title: 'Draft task' }
      : {
          __typename: 'Issue',
          title: 'Another repository',
          url: 'https://github.com/a/other/issues/1',
          repository: { nameWithOwner: 'a/other' },
          assignees: { nodes: [{ login: 'me' }] },
        };
    return JSON.stringify({
      data: {
        node: {
          id: 'PVT_1',
          title: 'Sprint project',
          url: 'https://github.com/users/a/projects/1',
          fields: { nodes: [{ name: 'Status', options: [{ name: 'Todo' }] }] },
          items: {
            nodes: [
              {
                id: second ? 'two' : 'one',
                content,
                fieldValues: {
                  nodes: [{ name: 'Todo', field: { name: 'Status' } }],
                },
              },
            ],
            pageInfo: {
              hasNextPage: !second,
              endCursor: second ? null : 'next',
            },
          },
        },
      },
    });
  };
  const result = await loadSprint(
    { sprintRepo: 'a/repo', sprintProjectId: 'PVT_1' },
    'me',
    execute,
  );
  assert.equal(calls, 2);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].repository.nameWithOwner, 'a/other');
  assert.equal(result.items[1].kind, 'draft');
  assert.equal(result.items[1].url, undefined);
  assert.equal(result.items[0].status, 'Todo');
  await assert.rejects(loadSprint({}, 'me', execute), /Settings/);
  assert.equal(calls, 2);
});
test('linked project discovery excludes closed projects and surfaces access errors', async () => {
  assert.deepEqual(
    await listRepoProjects('a/b', async () =>
      JSON.stringify({
        data: {
          repository: {
            projectsV2: {
              nodes: [{ id: 'open' }, { id: 'closed', closed: true }],
            },
          },
        },
      }),
    ),
    [{ id: 'open' }],
  );
  await assert.rejects(
    listRepoProjects('a/b', async () =>
      JSON.stringify({ errors: [{ message: 'Missing scope' }] }),
    ),
    /Missing scope/,
  );
});

test('issue metadata enrichment covers every batch rather than truncating at 100 issues', async () => {
  const items = Array.from({ length: 101 }, (_, i) => ({
    url: 'https://github.com/a/b/issues/' + (i + 1),
  }));
  let calls = 0;
  const execute = async () => {
    const selected = items.slice(calls * 40, ++calls * 40);
    return JSON.stringify({
      data: Object.fromEntries(
        selected.map((item, i) => [
          'i' + i,
          {
            issue: {
              ...item,
              body: 'Description ' + item.url,
              author: { login: 'me' },
              comments: {
                nodes: [{ author: { login: 'other', __typename: 'User' } }],
              },
            },
          },
        ]),
      ),
    });
  };
  const enriched = await enrichIssues(items, 'me', execute);
  assert.equal(calls, 3);
  assert.equal(enriched.length, 101);
  assert.equal(enriched.at(-1).needsReply, true);
  assert.match(enriched.at(-1).body, /101$/);
});
