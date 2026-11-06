import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { localOptions, acceptsHost } from './local.js';
import { AgentClient } from './agent-host.js';
import { collectPublication, publishPrepared } from './publications.js';
import { modelCatalog } from './models.js';
import {
  loadSprint,
  listRepoProjects,
  enrichIssues,
  repoName,
} from './sprint.js';
import { loadReviewContext, loadReviewState } from './reviews.js';
import { reviewDefaults, validateReviewSettings } from './review-policy.js';
import { externalUse } from './ownership.js';
import { listClaude, claudeThread } from './claude.js';
import {
  run,
  githubUrl,
  canonicalGithubUrl,
  loadState,
  saveState,
  jobPrompt,
  autoCandidates,
  configuredProjects,
  statePath,
} from './core.js';
export async function startServer({
  staticRoot,
  port,
  hostname,
  agentRuntime,
} = {}) {
  ({ port, hostname } = localOptions({ port, hostname }));
  const app = express(),
    codex = new AgentClient(agentRuntime);
  const runClaude = (options) => codex.runClaude(options);
  const catalog = modelCatalog(codex);
  let detectedUsername = null;
  async function currentUsername() {
    if (detectedUsername === null) {
      detectedUsername =
        JSON.parse(await run('gh', ['api', 'user'])).login || '';
    }
    return state.settings.githubUsername || detectedUsername;
  }
  let state = await loadState();
  state.settings = { ...reviewDefaults, ...state.settings };
  if (!state.settings.permissionMigrated) {
    if (state.settings.permission === 'sandbox')
      state.settings.permission = 'danger';
    state.settings.permissionMigrated = true;
    await saveState(state);
  }
  state.autoEnabled = state.autoEnabled === true;
  state.drafts ??= {};
  state.preparations ??= {};
  state.settings.publishReviews = false;
  let cache = { prs: [], issues: [], errors: [], updated: null };
  let polling = false;
  let timer;
  const clients = new Set();
  const cleanupJobs = new Map();
  const pendingClaude = new Map();
  let autoBusy = false;
  let autoThread = null;
  const recentCompletions = new Map();
  function broadcast(event) {
    if (event.method === 'preparation/updated') {
      const task = event.params.task;
      state.preparations[task.key] = task;
      void saveState(state);
      event = { method: 'approvals/updated', params: { key: task.key } };
      if (
        ['published', 'pending', 'complete', 'failed'].includes(task.status)
      ) {
        void scheduleAuto();
        if (task.status === 'published') void poll();
      }
    }
    if (event.method === 'turn/completed')
      void finishPreparation(event).catch((e) =>
        broadcast({ method: 'approvals/error', params: { error: e.message } }),
      );
    if (event.method === 'turn/completed' && event.params?.threadId) {
      if (event.params.threadId.startsWith('claude:'))
        pendingClaude.delete(event.params.threadId);
      recentCompletions.set(event.params.threadId, event);
      if (recentCompletions.size > 100)
        recentCompletions.delete(recentCompletions.keys().next().value);
    }
    if (
      event.method === 'turn/completed' &&
      event.params?.threadId === autoThread
    ) {
      const key = Object.keys(state.autoRuns || {}).find(
        (k) => state.autoRuns[k].id === autoThread,
      );
      if (key) {
        state.autoRuns[key].status =
          event.params?.turn?.status || event.params?.status || 'completed';
        void saveState(state);
      }
      autoThread = null;
      autoBusy = false;
      setTimeout(scheduleAuto, 0);
    }
    for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  codex.on('event', broadcast);
  codex.on('snapshot', (snapshot) => {
    for (const task of Object.values(snapshot.tasks)) {
      const local = state.preparations[task.key];
      if (
        !local ||
        ['running', 'collecting', 'publishing'].includes(local.status)
      )
        state.preparations[task.key] = task;
      if (task.id.startsWith('claude:') && snapshot.active.includes(task.id))
        pendingClaude.set(task.id, {
          id: task.id,
          cwd: task.cwd,
          agent: 'claude',
          preview: 'Background ' + task.kind,
          prompt: 'Background ' + task.kind,
          updatedAt: task.startedAt / 1000,
          status: { type: 'active' },
        });
    }
    void saveState(state);
  });
  app.use((req, res, next) => {
    if (!acceptsHost(req.headers.host, hostname, port))
      return res.status(403).send('Local access only');
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`)
        return res.status(403).send('Invalid origin');
      if (req.headers['x-prquay'] !== 'local')
        return res.status(403).send('Missing application header');
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) =>
      res.status(400).json({ error: e.message }),
    );
  async function search(kind, args, limit = 100) {
    return JSON.parse(
      await run('gh', [
        'search',
        kind,
        ...args,
        '--limit',
        String(limit),
        '--json',
        kind === 'prs'
          ? 'number,title,url,state,isDraft,author,repository,updatedAt,labels,commentsCount'
          : 'number,title,url,state,author,repository,updatedAt,labels,commentsCount',
      ]),
    );
  }
  async function poll() {
    if (polling) return;
    polling = true;
    const qs = [
      ['authored', () => search('prs', ['--author', '@me', '--state', 'open'])],
      [
        'review',
        () => search('prs', ['--review-requested', '@me', '--state', 'open']),
      ],
      [
        'assigned',
        () => search('prs', ['--assignee', '@me', '--state', 'open']),
      ],
      [
        'involved',
        () => search('prs', ['--involves', '@me', '--state', 'open']),
      ],
      [
        'reviewed',
        () => search('prs', ['--reviewed-by', '@me', '--state', 'open']),
      ],
      [
        'commented',
        () =>
          search('prs', [
            '--involves',
            '@me',
            '--commenter',
            '@me',
            '--state',
            'open',
          ]),
      ],
      [
        'unreviewed',
        () =>
          search('prs', [
            '--involves',
            '@me',
            '--review',
            'none',
            '--state',
            'open',
          ]),
      ],
      [
        'approved',
        () =>
          search('prs', [
            '--involves',
            '@me',
            '--review',
            'approved',
            '--state',
            'open',
          ]),
      ],
      [
        'failing',
        () =>
          search('prs', [
            '--involves',
            '@me',
            '--checks',
            'failure',
            '--state',
            'open',
          ]),
      ],
      [
        'issues',
        () => search('issues', ['--assignee', '@me', '--state', 'open']),
      ],
    ];
    const results = await Promise.allSettled(qs.map(([, f]) => f()));
    const old = cache;
    const prs = new Map();
    let issues = old.issues,
      errors = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        errors.push(`${qs[i][0]}: ${r.reason.message}`);
        return;
      }
      if (qs[i][0] === 'issues') {
        issues = r.value;
        return;
      }
      for (const x of r.value) {
        const prior = prs.get(x.url) || old.prs.find((y) => y.url === x.url);
        prs.set(x.url, {
          ...prior,
          ...x,
          roles: [...new Set([...(prs.get(x.url)?.roles || []), qs[i][0]])],
        });
      }
    });
    if (prs.size === 0 && errors.length) cache = { ...old, errors };
    else
      cache = {
        prs: [...prs.values()].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
        issues,
        errors,
        updated: new Date().toISOString(),
      };
    if (old.updated) {
      const oldSet = new Set(
        old.prs.filter((x) => x.roles.includes('review')).map((x) => x.url),
      );
      for (const pr of cache.prs.filter(
        (x) => x.roles.includes('review') && !oldSet.has(x.url),
      ))
        broadcast({
          method: 'pr/reviewRequested',
          params: { title: pr.title, url: pr.url },
        });
    }
    polling = false;
    broadcast({ method: 'github/updated', params: { updated: cache.updated } });
    void enrichPulls(cache.prs);
    void currentUsername()
      .then((u) => enrichIssues(cache.issues, u))
      .then((items) => {
        cache.issues = items;
        broadcast({
          method: 'github/updated',
          params: { updated: cache.updated },
        });
      })
      .catch(() => {});
  }
  async function enrichPulls(items) {
    const eligible = items
      .filter((x) =>
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(x.url),
      )
      .slice(0, 100);
    if (!eligible.length) {
      void scheduleAuto();
      return;
    }
    const fields = eligible
      .map((x, i) => {
        const { repo, number } = githubUrl(x.url);
        const [owner, name] = repo.split('/');
        return `p${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${number}){mergeable reviewDecision headRefOid baseRefOid reviewThreads(first:100){nodes{id isResolved comments(last:1){nodes{createdAt author{login}}}}} reviews(last:100){nodes{author{login}state commit{oid}}} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{... on CheckRun{name conclusion} ... on StatusContext{context state}}}}}}}}}`;
      })
      .join(' ');
    try {
      const result = JSON.parse(
        await run('gh', [
          'api',
          'graphql',
          '-f',
          `query=query { viewer { login } ${fields} }`,
        ]),
      );
      for (let i = 0; i < eligible.length; i++) {
        const p = result.data?.[`p${i}`]?.pullRequest;
        if (!p) continue;
        const x = cache.prs.find((y) => y.url === eligible[i].url);
        if (!x) continue;
        const previousCheck = x.checkState;
        x.mergeable = p.mergeable;
        x.reviewDecision = p.reviewDecision;
        x.headRefOid = p.headRefOid;
        x.baseRefOid = p.baseRefOid;
        x.feedbackFingerprint = (p.reviewThreads?.nodes || [])
          .filter(
            (t) =>
              !t.isResolved &&
              t.comments?.nodes?.[0]?.author?.login &&
              t.comments.nodes[0].author.login !== result.data?.viewer?.login,
          )
          .map((t) => `${t.id}:${t.comments.nodes[0].createdAt}`)
          .sort()
          .join('|');
        x.failedChecks = (
          p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ||
          []
        )
          .filter((c) =>
            [
              'FAILURE',
              'ERROR',
              'TIMED_OUT',
              'ACTION_REQUIRED',
              'CANCELLED',
            ].includes(c.conclusion || c.state),
          )
          .map((c) => c.name || c.context)
          .filter(Boolean);
        x.pendingReview =
          p.reviews?.nodes?.some(
            (r) =>
              r.author?.login === result.data?.viewer?.login &&
              r.state === 'PENDING',
          ) || false;
        x.reviewedByMe =
          p.reviews?.nodes?.some(
            (r) =>
              r.author?.login === result.data?.viewer?.login &&
              [
                'APPROVED',
                'CHANGES_REQUESTED',
                'COMMENTED',
                'DISMISSED',
              ].includes(r.state),
          ) ||
          x.roles?.includes('reviewed') ||
          false;
        x.reviewedCurrentHead =
          p.reviews?.nodes?.some(
            (r) =>
              r.author?.login === result.data?.viewer?.login &&
              ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(
                r.state,
              ) &&
              r.commit?.oid === p.headRefOid,
          ) || false;
        x.checkState =
          p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null;
        if (
          previousCheck &&
          previousCheck !== 'FAILURE' &&
          x.checkState === 'FAILURE'
        )
          broadcast({
            method: 'pr/checkFailed',
            params: { title: x.title, url: x.url },
          });
      }
      broadcast({
        method: 'github/updated',
        params: { updated: cache.updated },
      });
      void scheduleAuto();
    } catch (e) {
      cache.errors.push(`PR status: ${e.message}`);
      broadcast({
        method: 'github/updated',
        params: { updated: cache.updated },
      });
    }
  }
  function schedule() {
    clearInterval(timer);
    timer = setInterval(
      poll,
      Math.max(30, Number(state.settings.interval) || 120) * 1000,
    );
  }
  app.get('/api/health', (req, res) =>
    res.json({
      ok: true,
      pid: process.pid,
      instance: process.env.OPUSDESK_INSTANCE || null,
    }),
  );
  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  app.get(
    '/api/status',
    wrap(async (req, res) => {
      const ps = await configuredProjects(state.settings);
      let available = { codex: false, claude: false, gh: false };
      await Promise.all(
        Object.keys(available).map(async (x) => {
          try {
            await run(x, ['--version'], { timeout: 4000 });
            available[x] = true;
          } catch {}
        }),
      );
      res.json({
        available,
        projects: ps,
        settings: state.settings,
        links: state.links,
        archived: state.archived,
        worktreeProjects: state.worktreeProjects || {},
        autoEnabled: !!state.autoEnabled,
        autoRuns: state.autoRuns || {},
        username: await currentUsername().catch(() => ''),
        detectedUsername: detectedUsername || '',
      });
    }),
  );
  app.get('/api/github', (req, res) => res.json(cache));
  app.post(
    '/api/github/refresh',
    wrap(async (req, res) => {
      await poll();
      res.json(cache);
    }),
  );
  app.get(
    '/api/github/closed',
    wrap(async (req, res) => {
      const data = await search(
        'prs',
        ['--involves', '@me', '--state', 'closed', '--sort', 'updated'],
        1000,
      );
      res.json({
        items: data.map((x) => ({ ...x, roles: ['closed'] })),
        limitReached: data.length >= 1000,
      });
    }),
  );
  app.get(
    '/api/issues/local',
    wrap(async (req, res) => {
      const ps = await configuredProjects(state.settings);
      const repos = [...new Set(ps.map((p) => p.repo).filter(Boolean))];
      const results = await Promise.allSettled(
        repos.map((r) => search('issues', ['--repo', r, '--state', 'open'])),
      );
      const raw = results
        .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const issues = await enrichIssues(raw, await currentUsername()).catch(
        () => raw,
      );
      res.json({
        issues,
        errors: results.filter((r) => r.status === 'rejected').length,
      });
    }),
  );
  app.post(
    '/api/cleanup/close',
    wrap(async (req, res) => {
      const urls = req.body.urls;
      if (
        !Array.isArray(urls) ||
        !urls.length ||
        urls.length > 1000 ||
        new Set(urls).size !== urls.length
      )
        throw Error('Select 1 to 1000 distinct items');
      const targets = urls.map((url) => ({ url, ...githubUrl(url) }));
      const job = {
        id: randomUUID(),
        total: targets.length,
        completed: 0,
        results: [],
        status: 'running',
      };
      cleanupJobs.set(job.id, job);
      res.json({ id: job.id });
      let cursor = 0;
      async function worker() {
        while (cursor < targets.length) {
          const item = targets[cursor++];
          try {
            await run('gh', [
              item.kind === 'pull' ? 'pr' : 'issue',
              'close',
              String(item.number),
              '-R',
              item.repo,
            ]);
            job.results.push({ url: item.url, ok: true });
          } catch (e) {
            job.results.push({
              url: item.url,
              ok: false,
              error: e.stderr?.trim() || e.message,
            });
          }
          job.completed++;
          broadcast({ method: 'cleanup/progress', params: job });
        }
      }
      Promise.all(
        Array.from({ length: Math.min(4, targets.length) }, () => worker()),
      )
        .then(async () => {
          job.status = 'complete';
          await poll();
          broadcast({ method: 'cleanup/progress', params: job });
        })
        .catch((e) => {
          job.status = 'failed';
          job.error = e.message;
          broadcast({ method: 'cleanup/progress', params: job });
        });
    }),
  );
  app.get('/api/cleanup/jobs/:id', (req, res) => {
    const job = cleanupJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Cleanup job not found' });
    res.json(job);
  });
  app.get(
    '/api/sprint/projects',
    wrap(async (req, res) => {
      try {
        res.json({ projects: await listRepoProjects(req.query.repo) });
      } catch (e) {
        throw Error(
          `Unable to read linked projects. GitHub Projects needs read:project access in gh. ${e.message}`,
          { cause: e },
        );
      }
    }),
  );
  app.get(
    '/api/sprint',
    wrap(async (req, res) =>
      res.json(await loadSprint(state.settings, await currentUsername())),
    ),
  );
  app.post(
    '/api/issues/comment',
    wrap(async (req, res) => {
      const target = githubUrl(req.body.url);
      if (target.kind !== 'issues') throw Error('Expected an issue URL');
      const body =
        typeof req.body.body === 'string' ? req.body.body.trim() : '';
      if (!body || body.length > 10000)
        throw Error('Enter a comment of at most 10,000 characters');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opusdesk-comment-'));
      try {
        const file = path.join(dir, 'comment.txt');
        await fs.writeFile(file, body, { mode: 0o600 });
        await run('gh', [
          'issue',
          'comment',
          String(target.number),
          '-R',
          target.repo,
          '--body-file',
          file,
        ]);
        res.json({ ok: true });
        void poll();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }),
  );
  app.get(
    '/api/github/review-state',
    wrap(async (req, res) => res.json(await loadReviewState(req.query.url))),
  );
  app.get(
    '/api/github/detail',
    wrap(async (req, res) => {
      const { repo, number, kind } = githubUrl(req.query.url);
      if (kind !== 'pull') throw Error('Expected a pull request');
      const fields =
        'number,title,url,body,state,isDraft,author,headRefName,baseRefName,mergeable,reviewDecision,reviews,comments,latestReviews,statusCheckRollup,reviewRequests';
      const data = JSON.parse(
        await run('gh', [
          'pr',
          'view',
          String(number),
          '-R',
          repo,
          '--json',
          fields,
        ]),
      );
      res.json(data);
    }),
  );
  async function hasCodex() {
    try {
      await run('codex', ['--version'], { timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  }
  app.get(
    '/api/models',
    wrap(async (req, res) =>
      res.json(await catalog(req.query.agent || 'codex')),
    ),
  );
  app.get(
    '/api/sessions',
    wrap(async (req, res) => {
      let result = { data: [] };
      if (await hasCodex()) {
        await codex.start();
        let cursor = null;
        do {
          const page = await codex.call('thread/list', {
            limit: 100,
            cursor,
            sortKey: 'updated_at',
            sourceKinds: [
              'cli',
              'vscode',
              'exec',
              'appServer',
              'unknown',
              'subAgent',
              'subAgentReview',
              'subAgentCompact',
              'subAgentThreadSpawn',
              'subAgentOther',
            ],
            archived: req.query.archived === 'true',
          });
          result.data.push(...page.data);
          cursor = page.nextCursor || null;
        } while (cursor && result.data.length < 1000);
        result.truncated = !!cursor;
      }
      if (req.query.archived !== 'true')
        result.data = [
          ...result.data,
          ...Object.values(state.drafts).map((d) => ({
            id: d.id,
            cwd: d.cwd,
            preview: 'New session',
            updatedAt: d.createdAt / 1000,
            agent: d.agent,
          })),
          ...(await listClaude()),
          ...Array.from(pendingClaude.values()),
        ]
          .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      result.data = result.data.map((session) =>
        codex.active.has(session.id)
          ? { ...session, status: { type: 'active', activeFlags: [] } }
          : session,
      );
      res.json(result);
    }),
  );
  app.get(
    '/api/session/:id',
    wrap(async (req, res) => {
      if (state.drafts[req.params.id])
        return res.json({
          thread: {
            ...state.drafts[req.params.id],
            preview: 'New session',
            turns: [],
          },
          externalUse: { blocked: false, available: true },
        });
      let thread;
      if (req.params.id.startsWith('claude:')) {
        try {
          thread = await claudeThread(req.params.id);
        } catch (e) {
          const p = pendingClaude.get(req.params.id);
          if (!p) throw e;
          thread = {
            ...p,
            turns: [
              {
                items: [{ type: 'userMessage', content: [{ text: p.prompt }] }],
              },
            ],
          };
        }
      } else {
        await codex.start();
        thread = (
          await codex.call('thread/read', {
            threadId: req.params.id,
            includeTurns: true,
          })
        ).thread;
      }
      const inUse = await externalUse({
        cwd: thread.cwd,
        agent: req.params.id.startsWith('claude:') ? 'claude' : 'codex',
      });
      res.json({ thread, externalUse: inUse });
    }),
  );
  async function prepareWorktree(project, label) {
    const token = randomUUID().slice(0, 8),
      safe = label.replace(/[^a-z0-9-]/gi, '-').slice(0, 50);
    const dir = path.join(
      os.homedir(),
      '.local',
      'share',
      'prquay',
      'worktrees',
      `${safe}-${token}`,
    );
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await run('git', [
      '-C',
      project,
      'worktree',
      'add',
      '-b',
      `prquay/${safe}-${token}`,
      dir,
      'HEAD',
    ]);
    state.worktreeProjects ??= {};
    state.worktreeProjects[dir] = project;
    await saveState(state);
    return dir;
  }
  async function rememberWorktree(project, choice) {
    state.settings.worktreePreferences ??= {};
    state.settings.worktreePreferences[project] = !!choice;
    await saveState(state);
  }
  app.post(
    '/api/session',
    wrap(async (req, res) => {
      const {
        project,
        model,
        effort,
        permission,
        agent = 'codex',
        worktree = false,
      } = req.body;
      if (!['codex', 'claude'].includes(agent)) throw Error('Unknown agent');
      if (agent === 'claude')
        await run('claude', ['--version'], { timeout: 4000 });
      const ps = await configuredProjects(state.settings);
      if (!ps.some((x) => x.path === project))
        throw Error('Choose a discovered project');
      await rememberWorktree(project, worktree);
      const cwd = worktree
        ? await prepareWorktree(project, `session-${path.basename(project)}`)
        : project;
      const id = `draft:${randomUUID()}`;
      state.drafts[id] = {
        id,
        agent,
        cwd,
        model,
        effort,
        permission: permission || state.settings.permission || 'danger',
        createdAt: Date.now(),
      };
      await saveState(state);
      res.json({ id });
    }),
  );
  app.post(
    '/api/session/:id/message',
    wrap(async (req, res) => {
      let id = req.params.id;
      const text = String(req.body.text || '').trim();
      if (!text) throw Error('Enter a message');
      const draft = state.drafts[id];
      if (draft) {
        if (draft.agent === 'claude') {
          const uuid = randomUUID();
          id = await runClaude(
            {
              id: uuid,
              cwd: draft.cwd,
              prompt: text,
              model: draft.model,
              effort: draft.effort,
              permission: draft.permission,
            },
            broadcast,
          );
          pendingClaude.set(id, {
            id,
            cwd: draft.cwd,
            agent: 'claude',
            preview: text,
            updatedAt: Date.now() / 1000,
            prompt: text,
            status: { type: 'active' },
          });
          state.sessionOptions ??= {};
          state.sessionOptions[id] = {
            model: draft.model,
            effort: draft.effort,
            permission: draft.permission,
          };
        } else {
          await codex.start();
          const danger = draft.permission === 'danger';
          const started = await codex.call('thread/start', {
            cwd: draft.cwd,
            model: draft.model || null,
            approvalPolicy: danger ? 'never' : 'on-request',
            sandbox: danger ? 'danger-full-access' : 'workspace-write',
          });
          id = started.thread.id;
          await codex.call('turn/start', {
            threadId: id,
            input: [{ type: 'text', text }],
            effort: draft.effort || null,
          });
        }
        delete state.drafts[req.params.id];
        await saveState(state);
        return res.json({ ok: true, id });
      }
      if (id.startsWith('claude:')) {
        const thread = await claudeThread(id);
        const guard = await externalUse({ cwd: thread.cwd, agent: 'claude' });
        if (!guard.available)
          throw Error(
            'Unable to check whether this session is in use elsewhere.',
          );
        if (guard.blocked)
          throw Error(
            'Another Claude terminal is open in this project. Close it before sending.',
          );
        await runClaude(
          {
            id: id.slice(7),
            cwd: thread.cwd,
            prompt: text,
            model: state.sessionOptions?.[id]?.model,
            effort: state.sessionOptions?.[id]?.effort,
            permission: state.sessionOptions?.[id]?.permission || 'danger',
            resume: true,
          },
          broadcast,
        );
        return res.json({ ok: true, id });
      }
      await codex.start();
      const existing = await codex.call('thread/read', {
        threadId: id,
        includeTurns: false,
      });
      const guard = await externalUse({
        cwd: existing.thread.cwd,
        agent: 'codex',
      });
      if (!guard.available)
        throw Error(
          'Unable to check whether this session is in use elsewhere.',
        );
      if (guard.blocked)
        throw Error(
          'Another Codex terminal is open in this project. Close it before sending.',
        );
      await codex.call('thread/resume', { threadId: id });
      await codex.call('turn/start', {
        threadId: id,
        input: [{ type: 'text', text }],
      });
      res.json({ ok: true, id });
    }),
  );
  app.post(
    '/api/session/:id/archive',
    wrap(async (req, res) => {
      if (state.drafts[req.params.id]) {
        delete state.drafts[req.params.id];
        await saveState(state);
        return res.json({ ok: true });
      }
      if (req.params.id.startsWith('claude:'))
        throw Error('Archiving Claude sessions is not supported yet');
      await codex.start();
      await codex.call('thread/archive', { threadId: req.params.id });
      res.json({ ok: true });
    }),
  );
  app.get('/api/requests', (req, res) =>
    res.json([...codex.requests.values()]),
  );
  app.post(
    '/api/requests/:id',
    wrap(async (req, res) => {
      await codex.respond(req.params.id, req.body.result);
      res.json({ ok: true });
    }),
  );
  const startingJobs = new Set();
  async function startJob(input) {
    const url = canonicalGithubUrl(input.url);
    if (startingJobs.has(url))
      throw Error('A workflow is already starting for this item.');
    startingJobs.add(url);
    try {
      return await launchJob(input);
    } finally {
      startingJobs.delete(url);
    }
  }
  async function launchJob(input) {
    const { kind, outcome, forceNew, isolated, auto } = input,
      url = canonicalGithubUrl(input.url),
      target = githubUrl(url);
    if (
      !['review', 'conflicts', 'comments', 'issue', 'ci', 'describe'].includes(
        kind,
      )
    )
      throw Error('Unknown workflow');
    if (
      (kind === 'issue' || kind === 'describe') !==
      (target.kind === 'issues')
    )
      throw Error('URL does not match the selected workflow');
    const pushOnCompletion = input.pushOnCompletion === true;
    if (pushOnCompletion && (kind !== 'ci' || auto))
      throw Error('Automatic push is only available for manual CI fixes');
    const busyTask = Object.values(state.preparations).find(
      (task) =>
        task.url === url &&
        ['running', 'collecting', 'publishing'].includes(task.status),
    );
    if (busyTask) {
      if (
        busyTask.kind === kind &&
        !!busyTask.pushOnCompletion === pushOnCompletion
      )
        return { id: busyTask.id };
      throw Error(
        'This PR already has a running workflow. Wait for it to finish before starting another.',
      );
    }
    const ps = await configuredProjects(state.settings),
      project = ps.find(
        (p) =>
          p.repo?.toLowerCase() === target.repo.toLowerCase() &&
          (!input.project || p.path === input.project),
      );
    if (!project)
      throw Error(
        'No local checkout for ' +
          target.repo +
          '. Set its repository folder in Settings.',
      );
    const config = state.settings.workflows?.[kind] || {};
    let agent =
      input.agent || config.agent || state.settings.defaultAgent || 'codex';
    let permission =
      input.permission ||
      config.permission ||
      state.settings.permission ||
      'danger';
    let model =
      'model' in input
        ? input.model
        : config.model ||
          (agent === 'claude'
            ? state.settings.claudeModel
            : state.settings.codexModel);
    let effort =
      'effort' in input ? input.effort : config.effort || state.settings.effort;
    if (
      !['codex', 'claude'].includes(agent) ||
      !['danger', 'sandbox'].includes(permission)
    )
      throw Error('Invalid agent or permissions');
    if (auto && !state.autoEnabled) throw Error('Auto mode was turned off');
    let issueContext;
    if (kind === 'describe') {
      issueContext = JSON.parse(
        await run('gh', [
          'issue',
          'view',
          String(target.number),
          '-R',
          target.repo,
          '--json',
          'title,body,comments,labels',
        ]),
      );
      if (issueContext.body?.trim())
        throw Error('This issue already has a description');
    }
    const reviewContext =
      kind === 'review' ? await loadReviewContext(url) : undefined;
    const sourceHead =
      target.kind === 'pull' && kind !== 'review'
        ? JSON.parse(
            await run('gh', ['pr', 'view', url, '--json', 'headRefOid']),
          ).headRefOid
        : null;
    let cwd = project.path,
      id = forceNew || isolated ? null : state.links[url];
    if (id) {
      try {
        if (id.startsWith('claude:')) {
          const thread = await claudeThread(id);
          cwd = thread.cwd;
          agent = 'claude';
          model = state.sessionOptions?.[id]?.model;
          effort = state.sessionOptions?.[id]?.effort;
          permission = state.sessionOptions?.[id]?.permission || permission;
        } else {
          await codex.start();
          const result = await codex.call('thread/read', {
            threadId: id,
            includeTurns: false,
          });
          cwd = result.thread.cwd;
          agent = 'codex';
        }
      } catch {
        id = null;
        cwd = project.path;
      }
    }
    const checkoutBusy = Object.values(state.preparations).some(
      (task) =>
        task.cwd === cwd &&
        ['running', 'collecting', 'publishing'].includes(task.status),
    );
    const checkoutDirty =
      target.kind === 'pull' &&
      !!(await run('git', ['-C', cwd, 'status', '--porcelain'])).trim();
    const needsIsolation = checkoutBusy || checkoutDirty;
    if (needsIsolation) id = null;
    if (id) {
      const guard = await externalUse({ cwd, agent });
      if (!guard.available)
        throw Error(
          'Unable to check whether this session is in use elsewhere.',
        );
      if (guard.blocked)
        throw Error(
          'Another ' +
            (agent === 'claude' ? 'Claude' : 'Codex') +
            ' terminal is open in this project. Close it before continuing this linked chat.',
        );
    }
    if (
      typeof isolated === 'boolean' &&
      (kind === 'issue' || kind === 'describe')
    )
      await rememberWorktree(project.path, isolated);
    if (
      isolated ||
      (!id &&
        (needsIsolation || (target.kind === 'pull' && isolated !== false)))
    )
      cwd = await prepareWorktree(project.path, kind + '-' + target.number);
    const taskId = randomUUID(),
      artifactDir = path.join(path.dirname(statePath), 'prepared', taskId);
    await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const artifact = path.join(
      artifactDir,
      kind === 'describe' ? 'description.md' : 'pr.json',
    );
    const initialHead =
      sourceHead || (await run('git', ['-C', cwd, 'rev-parse', 'HEAD'])).trim();
    const prompt = jobPrompt(kind, url, {
      outcome,
      publish: false,
      auto: !!auto,
      context: reviewContext,
      tone: state.settings.reviewTone,
      scope: state.settings.reviewScope,
      preferences: state.settings.reviewPreferences,
      issueContext,
      artifact,
      pushOnCompletion,
    });
    async function register(threadId) {
      state.preparations[taskId] = {
        key: taskId,
        id: threadId,
        url,
        kind,
        cwd,
        initialHead,
        outcome,
        artifact,
        status: 'running',
        startedAt: Date.now(),
        auto: !!auto,
        pushOnCompletion,
        background: true,
      };
      await saveState(state);
      await codex.call('host/register', state.preparations[taskId]);
    }
    if (auto && !state.autoEnabled) throw Error('Auto mode was turned off');
    if (agent === 'claude') {
      const resume = !!id,
        uuid = id?.startsWith('claude:') ? id.slice(7) : randomUUID();
      id = 'claude:' + uuid;
      await register(id);
      try {
        await runClaude(
          { id: uuid, cwd, prompt, model, effort, permission, resume },
          broadcast,
        );
      } catch (error) {
        await broadcastLaunchFailure(taskId, error);
        throw error;
      }
      state.sessionOptions ??= {};
      state.sessionOptions[id] = { model, effort, permission };
    } else {
      await codex.start();
      if (id) await codex.call('thread/resume', { threadId: id });
      else {
        const danger = permission === 'danger';
        id = (
          await codex.call('thread/start', {
            cwd,
            model: model || null,
            approvalPolicy: danger ? 'never' : 'on-request',
            sandbox: danger ? 'danger-full-access' : 'workspace-write',
          })
        ).thread.id;
      }
      await register(id);
      try {
        await codex.call('turn/start', {
          threadId: id,
          input: [{ type: 'text', text: prompt }],
          effort: effort || null,
        });
      } catch (e) {
        await broadcastLaunchFailure(taskId, e);
        throw e;
      }
    }
    state.links[url] = id;
    await saveState(state);
    broadcast({ method: 'approvals/updated', params: {} });
    return { id };
  }
  async function broadcastLaunchFailure(taskId, error) {
    const task = state.preparations[taskId];
    task.status = 'failed';
    task.error = error.message;
    await codex.call('host/register', task);
    await saveState(state);
  }
  app.post(
    '/api/job',
    wrap(async (req, res) => res.json(await startJob(req.body))),
  );
  async function scheduleAuto() {
    if (!state.autoEnabled || autoBusy) return;
    state.autoRuns ??= {};
    const ps = await configuredProjects(state.settings);
    if (!state.autoEnabled || autoBusy) return;
    const candidate = autoCandidates(cache, state.autoRuns).find(
      (c) =>
        !Object.values(state.preparations).some(
          (t) =>
            t.url === c.url &&
            [
              'running',
              'collecting',
              'pending',
              'publishing',
              'failed',
            ].includes(t.status),
        ) &&
        ps.some(
          (p) => p.repo?.toLowerCase() === githubUrl(c.url).repo.toLowerCase(),
        ),
    );
    if (!candidate) return;
    autoBusy = true;
    state.autoRuns[candidate.key] = {
      ...candidate,
      status: 'starting',
      at: Date.now(),
    };
    await saveState(state);
    if (!state.autoEnabled) {
      state.autoRuns[candidate.key].status = 'cancelled';
      autoBusy = false;
      await saveState(state);
      return;
    }
    try {
      const result = await startJob({
        url: candidate.url,
        kind: candidate.kind,
        outcome: 'implement, commit, push and create a pull request',
        forceNew: true,
        isolated: true,
        auto: true,
      });
      autoThread = result.id;
      state.autoRuns[candidate.key].id = result.id;
      state.autoRuns[candidate.key].status = 'running';
      await saveState(state);
      broadcast({
        method: 'auto/started',
        params: {
          threadId: result.id,
          title: candidate.kind,
          url: candidate.url,
        },
      });
      const early = recentCompletions.get(result.id);
      if (early) broadcast(early);
    } catch (e) {
      state.autoRuns[candidate.key].status = 'failed';
      state.autoRuns[candidate.key].error = e.message;
      autoBusy = false;
      await saveState(state);
      broadcast({
        method: 'auto/error',
        params: { error: e.message, url: candidate.url },
      });
    }
  }
  app.post(
    '/api/auto',
    wrap(async (req, res) => {
      if (typeof req.body.enabled !== 'boolean')
        throw Error('Expected an on/off value');
      state.autoEnabled = req.body.enabled;
      await saveState(state);
      res.json({ enabled: state.autoEnabled });
      broadcast({
        method: 'auto/changed',
        params: { enabled: state.autoEnabled },
      });
      if (state.autoEnabled) void poll();
    }),
  );
  async function finishPreparation(event) {
    const task = Object.values(state.preparations).find(
      (t) => t.id === event.params?.threadId && t.status === 'running',
    );
    if (!task) return;
    if (task.background) return;
    task.status = 'collecting';
    await saveState(state);
    if (
      ['failed', 'interrupted'].includes(
        event.params?.turn?.status || event.params?.status,
      )
    ) {
      task.status = 'failed';
      task.error = event.params?.error || 'Agent did not finish';
    } else
      try {
        Object.assign(task, await collectPublication(task));
        if (
          task.kind === 'ci' &&
          task.pushOnCompletion &&
          !task.auto &&
          task.status === 'pending'
        ) {
          task.status = 'publishing';
          await saveState(state);
          const result = await publishPrepared({ ...task, status: 'pending' });
          task.status = 'published';
          task.publishedAt = Date.now();
          task.publishedUrl = result.url;
          void poll();
        }
      } catch (e) {
        task.status = 'failed';
        task.error = e.message;
      }
    await saveState(state);
    broadcast({ method: 'approvals/updated', params: { key: task.key } });
    void scheduleAuto();
  }
  app.get('/api/approvals', (req, res) =>
    res.json({
      tasks: Object.values(state.preparations)
        .filter(
          (t) => !['complete', 'published', 'dismissed'].includes(t.status),
        )
        .map(({ diff, comments, body, ...task }) => ({
          ...task,
          commentCount: comments?.length || 0,
        }))
        .sort((a, b) => b.startedAt - a.startedAt),
    }),
  );
  app.get('/api/approvals/:key', (req, res) => {
    const task = state.preparations[req.params.key];
    if (!task)
      return res.status(404).json({ error: 'Prepared work not found' });
    res.json(task);
  });
  app.post(
    '/api/approvals/:key/refresh',
    wrap(async (req, res) => {
      const task = state.preparations[req.params.key];
      if (
        !task ||
        ['running', 'collecting', 'publishing'].includes(task.status)
      )
        throw Error('This task is busy');
      task.status = 'collecting';
      try {
        Object.assign(task, await collectPublication(task), { error: null });
      } catch (e) {
        task.status = 'failed';
        task.error = e.message;
        await saveState(state);
        throw e;
      }
      await saveState(state);
      res.json(task);
      broadcast({ method: 'approvals/updated', params: {} });
    }),
  );
  app.post(
    '/api/approvals/:key/publish',
    wrap(async (req, res) => {
      const task = state.preparations[req.params.key];
      if (!task || task.status !== 'pending')
        throw Error('This task is not ready for publishing');
      task.status = 'publishing';
      await saveState(state);
      try {
        const result = await publishPrepared({ ...task, status: 'pending' });
        task.status = 'published';
        task.publishedAt = Date.now();
        task.publishedUrl = result.url;
        if (result.url) state.links[canonicalGithubUrl(result.url)] = task.id;
        await saveState(state);
        res.json(result);
        broadcast({ method: 'approvals/updated', params: {} });
        void poll();
      } catch (e) {
        task.status = 'pending';
        task.error = e.message;
        await saveState(state);
        throw e;
      }
    }),
  );
  app.post(
    '/api/approvals/:key/dismiss',
    wrap(async (req, res) => {
      const task = state.preparations[req.params.key];
      if (
        !task ||
        ['running', 'collecting', 'publishing'].includes(task.status)
      )
        throw Error('This task is busy');
      task.status = 'dismissed';
      await saveState(state);
      res.json({ ok: true });
      broadcast({ method: 'approvals/updated', params: {} });
    }),
  );
  app.post(
    '/api/settings',
    wrap(async (req, res) => {
      const reviewSettings = validateReviewSettings(req.body);
      if (req.body.sprintRepo) repoName(req.body.sprintRepo);
      if (
        req.body.sprintProjectId &&
        !/^[\w=-]+$/.test(req.body.sprintProjectId)
      )
        throw Error('Invalid project ID');
      if (
        req.body.githubUsername &&
        !/^[A-Za-z0-9-]+$/.test(req.body.githubUsername)
      )
        throw Error('Invalid GitHub username');
      if (req.body.repoPaths) {
        for (const [repo, dir] of Object.entries(req.body.repoPaths)) {
          repoName(repo);
          if (typeof dir !== 'string' || !path.isAbsolute(dir))
            throw Error('Repository folders must be absolute paths');
        }
      }
      const allowed = [
        'root',
        'interval',
        'defaultAgent',
        'codexModel',
        'claudeModel',
        'effort',
        'permission',
        'workflows',
        'githubUsername',
        'repoPaths',
        'sprintRepo',
        'sprintProjectId',
        'sprintProjectTitle',
        'sprintProjectUrl',
      ];
      for (const k of allowed)
        if (k in req.body) state.settings[k] = req.body[k];
      Object.assign(state.settings, reviewSettings);
      await saveState(state);
      schedule();
      res.json(state.settings);
    }),
  );
  app.use(express.static(staticRoot));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/'))
      return res.sendFile(path.join(staticRoot, 'index.html'));
    next();
  });
  app.use((err, req, res, _next) =>
    res.status(500).json({ error: err.message }),
  );
  if (Object.values(state.preparations).some((task) => task.background))
    await codex.start();
  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  for (const task of Object.values(state.preparations)) {
    if (task.background) continue;
    if (['running', 'collecting'].includes(task.status)) {
      task.status = 'failed';
      task.error =
        'Server restarted. Open the chat, then refresh the prepared result.';
    }
    if (task.status === 'publishing') {
      task.status = 'failed';
      task.error = 'Publishing was interrupted. Check GitHub before retrying.';
    }
  }
  console.log(`Opus Desk: http://${hostname}:${port}`);
  schedule();
  void poll();
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    for (const client of clients) client.end();
    codex.disconnect();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}
