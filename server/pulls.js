import { canonicalGithubUrl, githubUrl, run } from './core.js';

const pullFields = `
  state isDraft mergeable mergeStateStatus reviewDecision headRefOid baseRefOid
  baseRef { target { oid } }
  author { login }
  reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } } } }
  reviews(last: 100) { nodes { databaseId author { login } state commit { oid } submittedAt } }
  reviewThreads(first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved isOutdated
      root: comments(first: 1) { nodes { author { login } createdAt } }
      recent: comments(last: 10) { nodes { author { login } createdAt } }
    }
  }
  comments(last: 50) { nodes { author { login } createdAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state contexts(first: 100) { nodes {
      ... on CheckRun { name conclusion status startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state createdAt }
    } }
  } } } }
`;
const failureStates = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'CANCELLED',
  'STARTUP_FAILURE',
]);
const submittedStates = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
]);
const loginIs = (author, viewer) =>
  !!viewer && author?.login?.toLowerCase() === viewer.toLowerCase();

export function pullStatus(item, pull, viewer) {
  const roles = new Set(item.roles || []);
  const authored = loginIs(pull.author, viewer);
  if (authored) roles.add('authored');
  else roles.delete('authored');
  if (Array.isArray(pull.reviewRequests?.nodes)) {
    if (
      pull.reviewRequests.nodes.some((r) =>
        loginIs(r.requestedReviewer, viewer),
      )
    )
      roles.add('review');
    else roles.delete('review');
  }
  const myReviews = (pull.reviews?.nodes || []).filter((r) =>
    loginIs(r.author, viewer),
  );
  const submitted = myReviews.filter((r) => submittedStates.has(r.state));
  const lastReview =
    submitted
      .map((r) => r.submittedAt || '')
      .sort()
      .at(-1) || '';
  const lastDiscussion = (pull.comments?.nodes || [])
    .filter((c) => loginIs(c.author, viewer))
    .map((c) => c.createdAt)
    .sort()
    .at(-1);
  const feedback = [];
  const responses = [];
  for (const thread of pull.reviewThreads?.nodes || []) {
    if (thread.isResolved || thread.isOutdated) continue;
    const comments = thread.recent?.nodes || [];
    const root = thread.root?.nodes?.[0];
    const last = comments.at(-1) || root;
    if (!last?.author?.login || loginIs(last.author, viewer)) continue;
    if (authored) feedback.push(`${thread.id}:${last.createdAt}`);
    else if (
      (loginIs(root?.author, viewer) ||
        comments.some((c) => loginIs(c.author, viewer))) &&
      last.createdAt > lastReview
    ) {
      responses.push(`${thread.id}:${last.createdAt}`);
    }
  }
  const latestDiscussion = pull.comments?.nodes?.at(-1);
  // A conversation comment counts as a response only after the viewer participated
  // and the PR author spoke next. Inline responses are tied to their own thread.
  if (
    !authored &&
    lastDiscussion &&
    latestDiscussion?.author?.login &&
    loginIs(latestDiscussion.author, pull.author?.login) &&
    latestDiscussion.createdAt > lastDiscussion &&
    latestDiscussion.createdAt > lastReview
  ) {
    responses.push(`discussion:${latestDiscussion.createdAt}`);
  }
  const rollup = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const latestChecks = new Map();
  for (const check of rollup?.contexts?.nodes || []) {
    const key =
      (check.checkSuite?.workflowRun?.workflow?.name || '') +
      ':' +
      (check.name || check.context);
    const time = check.startedAt || check.completedAt || check.createdAt || '';
    if (!latestChecks.has(key) || time >= latestChecks.get(key).time)
      latestChecks.set(key, { time, check });
  }
  const currentChecks = [...latestChecks.values()].map(({ check }) => check);
  const failedChecks = currentChecks
    .filter((c) => failureStates.has(c.conclusion || c.state))
    .map((c) => c.name || c.context)
    .filter(Boolean)
    .sort();
  const checkState = !currentChecks.length
    ? rollup?.state || null
    : failedChecks.length
      ? 'FAILURE'
      : currentChecks.some(
            (c) =>
              (c.status && c.status !== 'COMPLETED') ||
              c.state === 'PENDING' ||
              c.state === 'EXPECTED',
          )
        ? 'PENDING'
        : 'SUCCESS';
  const pending = myReviews.find((r) => r.state === 'PENDING');
  const reviewedByMe = submitted.length > 0 || roles.has('reviewed');
  return {
    ...item,
    roles: [...roles],
    viewer,
    statusReady: !!viewer && !!pull.headRefOid,
    state: pull.state,
    isDraft: pull.isDraft,
    headRefOid: pull.headRefOid,
    baseRefOid: pull.baseRef?.target?.oid || pull.baseRefOid,
    mergeable: pull.mergeable,
    mergeStateStatus: pull.mergeStateStatus,
    reviewDecision: pull.reviewDecision,
    readyToMerge:
      pull.state === 'OPEN' &&
      !pull.isDraft &&
      pull.mergeable === 'MERGEABLE' &&
      pull.mergeStateStatus === 'CLEAN',
    pendingReview: !!pending,
    pendingReviewId: pending?.databaseId || null,
    pendingResponse: responses.length > 0,
    responseFingerprint: responses.sort().join('|'),
    unaddressedComments: feedback.length,
    feedbackFingerprint: feedback.sort().join('|'),
    reviewedByMe,
    reviewedCurrentHead: submitted.some(
      (r) => r.state !== 'DISMISSED' && r.commit?.oid === pull.headRefOid,
    ),
    checkState,
    failedChecks,
  };
}

function queryPulls(items) {
  return items
    .map(({ url }, i) => {
      const { repo, number } = githubUrl(url);
      const [owner, name] = repo.split('/').map(JSON.stringify);
      return `p${i}: repository(owner:${owner},name:${name}) { pullRequest(number:${number}) { ${pullFields} } }`;
    })
    .join(' ');
}

export async function enrichPullBatch(items, execute = run) {
  const graphql = async (query, options = []) =>
    JSON.parse(
      await execute('gh', [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        ...options,
      ]),
    );
  const result = await graphql(
    `query { viewer { login } ${queryPulls(items)} }`,
  );
  const viewer = result.data?.viewer?.login;
  return Promise.all(
    items.map(async (item, index) => {
      const pull = result.data?.[`p${index}`]?.pullRequest;
      if (!pull || !viewer) return { ...item, statusReady: false };
      let page = pull.reviewThreads;
      if (page?.pageInfo?.hasNextPage) {
        const { repo, number } = githubUrl(item.url);
        const [owner, name] = repo.split('/').map(JSON.stringify);
        while (page?.pageInfo?.hasNextPage && page.pageInfo.endCursor) {
          const cursor = page.pageInfo.endCursor;
          const next = await graphql(
            `query($cursor: String!) {
          repository(owner:${owner},name:${name}) { pullRequest(number:${number}) {
            reviewThreads(first:100, after:$cursor) { pageInfo { hasNextPage endCursor }
              nodes { id isResolved isOutdated
                root: comments(first:1) { nodes { author { login } createdAt } }
                recent: comments(last:10) { nodes { author { login } createdAt } }
              }
            }
          } }
        }`,
            ['-f', `cursor=${cursor}`],
          );
          page = next.data?.repository?.pullRequest?.reviewThreads;
          if (!page || page.pageInfo.endCursor === cursor)
            throw Error('Unable to synchronize all review threads');
          pull.reviewThreads.nodes.push(...page.nodes);
        }
      }
      return pullStatus(item, pull, viewer);
    }),
  );
}

export async function loadPullDetail(value, roles = [], execute = run) {
  const url = canonicalGithubUrl(value);
  if (githubUrl(url).kind !== 'pull')
    throw Error('Expected a pull request URL');
  const [result, [enriched]] = await Promise.all([
    execute('gh', [
      'pr',
      'view',
      url,
      '--json',
      'number,title,url,body,state,isDraft,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefOid,reviews,comments,latestReviews,statusCheckRollup,reviewRequests,updatedAt',
    ]).then(JSON.parse),
    enrichPullBatch([{ url, roles }], execute),
  ]);
  const { repo } = githubUrl(url);
  return { ...result, ...enriched, repository: { nameWithOwner: repo } };
}

export async function mergePull(value, expectedHead, execute = run) {
  const pr = await loadPullDetail(value, [], execute);
  if (!expectedHead || pr.headRefOid !== expectedHead || !pr.readyToMerge)
    throw Error(
      'This pull request changed or is not ready to merge. Refresh it and check its status.',
    );
  // The repository decides which merge methods it allows. Squash is the default
  // where enabled, otherwise use one of its allowed methods.
  const { repo } = githubUrl(pr.url);
  const [repository, rules] = await Promise.all([
    execute('gh', ['api', `repos/${repo}`]).then(JSON.parse),
    execute('gh', [
      'api',
      `repos/${repo}/rules/branches/${encodeURIComponent(pr.baseRefName)}`,
    ])
      .then(JSON.parse)
      .catch(() => []),
  ]);
  const restrictions = Array.isArray(rules)
    ? rules
        .filter(
          (rule) =>
            rule.type === 'pull_request' &&
            Array.isArray(rule.parameters?.allowed_merge_methods),
        )
        .map((rule) => rule.parameters.allowed_merge_methods)
    : [];
  const method = [
    ['squash', repository.allow_squash_merge],
    ['merge', repository.allow_merge_commit],
    ['rebase', repository.allow_rebase_merge],
  ].find(
    ([name, enabled]) =>
      enabled && restrictions.every((rule) => rule.includes(name)),
  )?.[0];
  if (!method) throw Error('This repository has no enabled merge method');
  await execute('gh', [
    'pr',
    'merge',
    pr.url,
    '--' + method,
    '--match-head-commit',
    expectedHead,
  ]);
  return { url: pr.url, ok: true };
}
