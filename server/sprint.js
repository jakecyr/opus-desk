import { run, githubUrl } from './core.js';

export function repoName(value) {
  if (typeof value !== 'string' || !/^[-\w.]+\/[-\w.]+$/.test(value))
    throw Error('Use a repository in owner/name format');
  return value;
}
const issueFields = `number title body url state updatedAt author{login} repository{nameWithOwner} assignees(first:100){nodes{login}} comments(last:20){nodes{author{login __typename}createdAt}} closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number title url state}}`;
export function issueMetadata(issue, username = '') {
  const last = (issue.comments?.nodes || [])
    .filter((c) => c.author?.__typename !== 'Bot')
    .at(-1);
  const assignees = issue.assignees?.nodes || issue.assignees || [];
  const involved =
    !!username &&
    (issue.author?.login?.toLowerCase() === username.toLowerCase() ||
      assignees.some((a) => a.login.toLowerCase() === username.toLowerCase()));
  return {
    ...issue,
    assignees,
    linkedPRs:
      issue.closedByPullRequestsReferences?.nodes || issue.linkedPRs || [],
    needsReply: !!(
      involved &&
      last?.author?.login &&
      last.author.login.toLowerCase() !== username.toLowerCase()
    ),
  };
}
export async function enrichIssues(items, username, execute = run) {
  const enriched = new Map();
  for (let offset = 0; offset < items.length; offset += 40) {
    const selected = items.slice(offset, offset + 40);
    const query =
      'query { ' +
      selected
        .map((item, i) => {
          const target = githubUrl(item.url),
            [owner, name] = target.repo.split('/');
          return (
            'i' +
            i +
            ':repository(owner:' +
            JSON.stringify(owner) +
            ',name:' +
            JSON.stringify(name) +
            '){issue(number:' +
            target.number +
            '){' +
            issueFields +
            '}}'
          );
        })
        .join(' ') +
      ' }';
    const result = JSON.parse(
      await execute('gh', ['api', 'graphql', '-f', 'query=' + query]),
    );
    if (result.errors?.length) throw Error(result.errors[0].message);
    selected.forEach((item, i) => {
      const issue = result.data?.['i' + i]?.issue;
      if (issue)
        enriched.set(item.url, { ...item, ...issueMetadata(issue, username) });
    });
  }
  return items.map((item) => enriched.get(item.url) || item);
}
export async function listRepoProjects(repository, execute = run) {
  const [owner, name] = repoName(repository).split('/');
  const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){projectsV2(first:100){nodes{id number title url closed}}} }`;
  const result = JSON.parse(
    await execute('gh', ['api', 'graphql', '-f', `query=${query}`]),
  );
  if (result.errors?.length) throw Error(result.errors[0].message);
  return (result.data?.repository?.projectsV2?.nodes || []).filter(
    (p) => !p.closed,
  );
}
export function iterationProgress(iteration, now = Date.now()) {
  if (!iteration?.startDate || !iteration.duration) return null;
  const start = Date.parse(iteration.startDate + 'T00:00:00Z'),
    end = start + iteration.duration * 86400000;
  return {
    ...iteration,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    daysLeft: Math.max(0, Math.ceil((end - now) / 86400000)),
    progress: Math.max(0, Math.min(100, (100 * (now - start)) / (end - start))),
  };
}
export async function loadSprint(settings, username, execute = run) {
  if (!settings.sprintRepo || !settings.sprintProjectId)
    throw Error('Choose a repository and project in Settings first');
  repoName(settings.sprintRepo);
  if (!/^[\w=-]+$/.test(settings.sprintProjectId))
    throw Error('Invalid project ID');
  const items = [];
  let cursor = null,
    project;
  do {
    const query = `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{id title url fields(first:100){nodes{... on ProjectV2SingleSelectField{name options{id name}} ... on ProjectV2IterationField{name configuration{iterations{id title startDate duration}completedIterations{id title startDate duration}}}}}items(first:100,after:$cursor){pageInfo{endCursor hasNextPage}nodes{id fieldValues(first:100){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}} ... on ProjectV2ItemFieldIterationValue{iterationId title startDate duration field{... on ProjectV2IterationField{name}}}}}content{__typename ... on Issue{${issueFields}} ... on PullRequest{number title body url state updatedAt repository{nameWithOwner}assignees(first:100){nodes{login}}} ... on DraftIssue{title body}}}}}}}`;
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `id=${settings.sprintProjectId}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const result = JSON.parse(await execute('gh', args));
    if (result.errors?.length) throw Error(result.errors[0].message);
    project = result.data?.node;
    if (!project) throw Error('Project not found or not accessible');
    items.push(...project.items.nodes);
    cursor = project.items.pageInfo.hasNextPage
      ? project.items.pageInfo.endCursor
      : null;
  } while (cursor && items.length < 1000);
  const iterations = (project.fields.nodes || [])
    .flatMap((f) => [
      ...(f.configuration?.iterations || []),
      ...(f.configuration?.completedIterations || []),
    ])
    .map((i) => iterationProgress(i));
  const statuses =
    project.fields.nodes
      .find((f) => f.name?.toLowerCase() === 'status')
      ?.options?.map((o) => o.name) || [];
  const normalized = items
    .filter((i) => i.content?.title)
    .map((i) => {
      const content = i.content,
        fields = i.fieldValues?.nodes || [],
        iteration = fields.find((f) => f.iterationId),
        status =
          fields.find((f) => f.field?.name?.toLowerCase() === 'status')?.name ||
          'No status';
      return {
        ...issueMetadata(content, username),
        id: i.id,
        status,
        kind:
          content.__typename === 'DraftIssue'
            ? 'draft'
            : content.__typename === 'PullRequest'
              ? 'pr'
              : 'issue',
        iterationId: iteration?.iterationId || null,
      };
    });
  return {
    project: { id: project.id, title: project.title, url: project.url },
    username,
    items: normalized,
    statuses,
    iterations,
    truncated: !!cursor,
    updated: new Date().toISOString(),
  };
}
