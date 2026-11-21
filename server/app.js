import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { localOptions, acceptsHost } from './local.js';
import { AgentClient } from './agent-host.js';
import {
  collectPublication,
  publishPrepared,
  submitPendingReview,
  submitReviewText,
  materializeReview,
} from './publications.js';
import { enrichPullBatch, loadPullDetail, mergePull } from './pulls.js';
import { modelCatalog } from './models.js';
import {
  loadSprint,
  listRepoProjects,
  enrichIssues,
  repoName,
} from './sprint.js';
import { loadReviewContext, loadReviewState } from './reviews.js';
import {
  getAutoActionMode,
  reviewDefaults,
  validateReviewSettings,
} from './review-policy.js';
import { automaticEffect } from './automation.js';
import { prepareAutomaticCheckout } from './auto-checkout.js';
import { externalUse } from './ownership.js';
import { listClaude, claudeThread } from './claude.js';
import {
  createSessionSearch,
  listCodexSessions,
  mergeSessions,
  sessionDirectory,
  sessionModelOptions,
} from './sessions.js';
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
  setGithubHost,
  getGithubHost,
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
  setGithubHost(state.settings.githubHost || 'github.com');
  if (!state.settings.permissionMigrated) {
    if (state.settings.permission === 'sandbox')
      state.settings.permission = 'danger';
    state.settings.permissionMigrated = true;
    await saveState(state);
  }
  state.autoEnabled = state.autoEnabled === true;
  state.drafts ??= {};
  state.sessionOptions ??= {};
  state.preparations ??= {};
  state.settings.publishReviews = false;
  state.trackedPulls ??= [];
  function normalizeGithubBindings() {
    const canonical = (value) => {
      try {
        return canonicalGithubUrl(value);
      } catch {
        return value;
      }
    };
    state.links = Object.fromEntries(
      Object.entries(state.links || {}).map(([url, id]) => [
        canonical(url),
        id,
      ]),
    );
    state.trackedPulls = [...new Set(state.trackedPulls.map(canonical))];
  }
  normalizeGithubBindings();
  let cache = { prs: [], issues: [], errors: [], updated: null };
  let polling;
  let githubGeneration = 0;
  let timer;
  const clients = new Set();
  const cleanupJobs = new Map();
  const pendingClaude = new Map();
  let autoBusy = false;
  let runAutoAgain = false;
  function broadcast(event) {
    if (event.method === 'preparation/updated') {
      const task = event.params.task;
      const previous = state.preparations[task.key];
      if (
        !previous?.automaticEffect &&
        !['published', 'dismissed'].includes(previous?.status)
      ) {
        state.preparations[task.key] = task;
        updateAutoRecord(task);
        void saveState(state);
        if (
          ['published', 'pending', 'complete', 'failed'].includes(task.status)
        ) {
          requestAuto();
          if (task.status === 'published') void poll();
        }
      }
      event = { method: 'approvals/updated', params: { key: task.key } };
    }
    if (event.method === 'turn/completed') {
      if (event.params?.threadId?.startsWith('claude:'))
        pendingClaude.delete(event.params.threadId);
      void finishPreparation(event).catch((e) =>
        broadcast({ method: 'approvals/error', params: { error: e.message } }),
      );
    }
    for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  codex.on('event', broadcast);
  codex.on('snapshot', (snapshot) => {
    for (const task of Object.values(snapshot.tasks)) {
      const local = state.preparations[task.key];
      if (
        !local ||
        (!local.automaticEffect &&
          ['running', 'collecting', 'publishing'].includes(local.status))
      ) {
        state.preparations[task.key] = task;
        updateAutoRecord(task);
      }
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
    requestAuto();
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
  function poll() {
    if (polling) return polling;
    const generation = githubGeneration;
    polling = syncGithub(generation)
      .catch((error) => {
        if (generation === githubGeneration) {
          cache = {
            ...cache,
            errors: [error.message],
            prs: cache.prs.map((pr) => ({ ...pr, statusReady: false })),
          };
          broadcast({
            method: 'github/updated',
            params: { updated: cache.updated },
          });
        }
      })
      .finally(() => {
        polling = null;
        if (generation !== githubGeneration) void poll();
        else requestAuto();
      });
    return polling;
  }
  async function syncGithub(generation) {
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
    if (generation !== githubGeneration) return;
    const old = cache;
    const prs = new Map();
    let issues = old.issues;
    const errors = [];
    results.forEach((r, i) => {
      const name = qs[i][0];
      if (r.status === 'rejected') {
        errors.push(name + ': ' + r.reason.message);
        return;
      }
      if (name === 'issues') {
        issues = r.value;
        return;
      }
      for (const x of r.value) {
        let url;
        try {
          url = canonicalGithubUrl(x.url);
        } catch {
          continue;
        }
        const prior = prs.get(url);
        prs.set(url, {
          ...prior,
          ...x,
          url,
          roles: [...(prior?.roles || []), name],
        });
      }
    });
    const criticalSearchFailed = results
      .slice(0, 6)
      .some((r) => r.status === 'rejected');
    const tracked = state.trackedPulls.flatMap((url) => {
      try {
        return !prs.has(url) && canonicalGithubUrl(url) === url ? [url] : [];
      } catch {
        return [];
      }
    });
    for (const url of tracked) {
      const oldItem = old.prs.find((pr) => pr.url === url);
      prs.set(url, { ...oldItem, url, roles: ['tracked'] });
    }
    if (criticalSearchFailed) {
      for (const item of old.prs) {
        if (!prs.has(item.url))
          prs.set(item.url, { ...item, statusReady: false });
      }
    }
    const candidates = [...prs.values()];
    const synced = [];
    for (let start = 0; start < candidates.length; start += 8) {
      if (generation !== githubGeneration) return;
      const batch = candidates.slice(start, start + 8);
      try {
        synced.push(...(await enrichPullBatch(batch)));
      } catch (e) {
        if (!errors.some((error) => error.startsWith('PR status:'))) {
          errors.push(
            'PR status: ' + (e.stderr?.trim().split('\n')[0] || e.message),
          );
        }
        synced.push(...batch.map((item) => ({ ...item, statusReady: false })));
      }
    }
    if (generation !== githubGeneration) return;
    const closedTracked = new Set(
      synced
        .filter((item) => item.statusReady && item.state !== 'OPEN')
        .map((item) => item.url),
    );
    if (state.trackedPulls.some((url) => closedTracked.has(url))) {
      state.trackedPulls = state.trackedPulls.filter(
        (url) => !closedTracked.has(url),
      );
      void saveState(state);
    }
    const result = await Promise.allSettled(
      synced
        .filter((item) => !item.title && item.state === 'OPEN')
        .map((item) => getPullDetail(item.url, item.roles)),
    );
    if (generation !== githubGeneration) return;
    const details = new Map(
      result.flatMap((r) =>
        r.status === 'fulfilled' ? [[r.value.url, r.value]] : [],
      ),
    );
    const current = synced
      .map((item) => details.get(item.url) || item)
      .filter((item) => item.title && (!item.state || item.state === 'OPEN'))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    cache = { prs: current, issues, errors, updated: new Date().toISOString() };
    if (old.updated) {
      const previous = new Map(old.prs.map((pr) => [pr.url, pr]));
      for (const pr of current) {
        const before = previous.get(pr.url);
        if (pr.roles.includes('review') && !before?.roles.includes('review'))
          broadcast({
            method: 'pr/reviewRequested',
            params: { title: pr.title, url: pr.url },
          });
        if (
          before?.checkState &&
          before.checkState !== 'FAILURE' &&
          pr.checkState === 'FAILURE'
        )
          broadcast({
            method: 'pr/checkFailed',
            params: { title: pr.title, url: pr.url },
          });
      }
    }
    broadcast({ method: 'github/updated', params: { updated: cache.updated } });
    const snapshot = cache;
    void currentUsername()
      .then((u) => enrichIssues(issues, u))
      .then((items) => {
        if (cache !== snapshot) return;
        cache.issues = items;
        broadcast({
          method: 'github/updated',
          params: { updated: cache.updated },
        });
      })
      .catch(() => {});
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
  async function getPullDetail(value, roles) {
    const url = canonicalGithubUrl(value);
    const pr = await loadPullDetail(
      url,
      roles || cache.prs.find((x) => x.url === url)?.roles,
    );
    return { ...pr, linkedChat: state.links[url] || null };
  }
  app.get(
    '/api/github/detail',
    wrap(async (req, res) => {
      res.json(await getPullDetail(req.query.url));
    }),
  );
  app.post(
    '/api/github/track',
    wrap(async (req, res) => {
      const pr = await getPullDetail(req.body.url);
      if (pr.state !== 'OPEN') return res.json(pr);
      if (!state.trackedPulls.includes(pr.url)) {
        if (state.trackedPulls.length >= 100)
          throw Error('The tracked pull request list is full');
        state.trackedPulls.push(pr.url);
        await saveState(state);
      }
      pr.roles = [...new Set([...pr.roles, 'tracked'])];
      const index = cache.prs.findIndex((item) => item.url === pr.url);
      if (index < 0) cache.prs.unshift(pr);
      else cache.prs[index] = pr;
      broadcast({
        method: 'github/updated',
        params: { updated: cache.updated },
      });
      res.json(pr);
    }),
  );
  app.post(
    '/api/github/merge',
    wrap(async (req, res) => {
      const result = await mergePull(req.body.url, req.body.headRefOid);
      githubGeneration++;
      cache.prs = cache.prs.filter((item) => item.url !== result.url);
      broadcast({
        method: 'github/updated',
        params: { updated: cache.updated },
      });
      res.json(result);
      void poll();
    }),
  );
  app.post(
    '/api/github/submit-review',
    wrap(async (req, res) => {
      const { url, headRefOid, body } = req.body;
      const result =
        body === undefined
          ? await submitPendingReview(url, headRefOid)
          : await submitReviewText(url, headRefOid, body);
      githubGeneration++;
      const pr = cache.prs.find((item) => item.url === result.url);
      if (pr)
        Object.assign(pr, {
          pendingReview: false,
          reviewedByMe: true,
          reviewedCurrentHead: true,
          pendingResponse: false,
        });
      broadcast({
        method: 'github/updated',
        params: { updated: cache.updated },
      });
      res.json(result);
      void poll();
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
  const searchSessions = createSessionSearch();
  app.get(
    '/api/sessions',
    wrap(async (req, res) => {
      const reference = req.query.reference
        ? canonicalGithubUrl(req.query.reference)
        : '';
      const includeActive = reference || req.query.archived !== 'true';
      const includeArchived =
        reference || ['true', 'all'].includes(req.query.archived);
      const query =
        typeof req.query.q === 'string' ? req.query.q.slice(0, 240) : '';
      const abort = new AbortController();
      res.once('close', () => abort.abort());
      const errors = [];
      const [agentSessions, claudeSessions] = await Promise.all([
        hasCodex().then(async (installed) => {
          if (!installed) return [];
          const feeds = [];
          if (includeActive) feeds.push(listCodexSessions(codex, false));
          if (includeArchived) feeds.push(listCodexSessions(codex, true));
          return (await Promise.allSettled(feeds)).flatMap((feed) => {
            if (feed.status === 'fulfilled') return feed.value;
            errors.push(`Codex: ${feed.reason.message}`);
            return [];
          });
        }),
        includeActive ? listClaude() : [],
        codex.start().catch((error) => errors.push(error.message)),
      ]);
      const localSessions = includeActive
        ? [
            ...Object.values(state.drafts).map((draft) => ({
              id: draft.id,
              cwd: draft.cwd,
              preview: 'New session',
              updatedAt: draft.createdAt / 1000,
              agent: draft.agent,
            })),
            ...pendingClaude.values(),
          ]
        : [];
      const matches = await searchSessions(
        mergeSessions(agentSessions, localSessions, claudeSessions),
        {
          query,
          reference,
          signal: abort.signal,
          worktrees: state.worktreeProjects,
        },
      );
      if (abort.signal.aborted) return;
      res.json({
        data: matches.map(({ file: _file, ...session }) =>
          codex.active.has(session.id)
            ? {
                ...session,
                status: {
                  type: 'active',
                  activeFlags: session.status?.activeFlags || [],
                },
              }
            : session,
        ),
        errors,
      });
    }),
  );
  const getDraft = (id) =>
    Object.hasOwn(state.drafts, id) ? state.drafts[id] : null;
  const savedSessionOptions = (id) =>
    Object.hasOwn(state.sessionOptions, id) ? state.sessionOptions[id] : {};
  async function readSession(id, includeTurns) {
    const draft = getDraft(id);
    if (draft) return { ...draft, preview: 'New session', turns: [] };
    if (id.startsWith('claude:')) {
      await codex.start().catch(() => {});
      try {
        return await claudeThread(id);
      } catch (error) {
        const pending = pendingClaude.get(id);
        if (!pending) throw error;
        return {
          ...pending,
          turns: [
            {
              items: [
                { type: 'userMessage', content: [{ text: pending.prompt }] },
              ],
            },
          ],
        };
      }
    }
    return (await codex.call('thread/read', { threadId: id, includeTurns }))
      .thread;
  }
  app.get(
    '/api/session/:id',
    wrap(async (req, res) => {
      const { id } = req.params;
      const thread = await readSession(id, true);
      const draft = getDraft(id);
      const inUse = draft
        ? { blocked: false, available: true }
        : await externalUse({
            cwd: thread.cwd,
            agent: thread.agent || 'codex',
          });
      const options = draft || savedSessionOptions(id);
      res.json({
        thread,
        externalUse: inUse,
        active: codex.active.has(id),
        options: {
          model: options.model ?? thread.model ?? '',
          effort: options.effort ?? thread.reasoningEffort ?? '',
        },
      });
    }),
  );
  const worktreeAdds = new Map();
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
    const commonDir = (
      await run('git', [
        '-C',
        project,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ])
    ).trim();
    // Worktree creation updates shared repository metadata.
    const previous = worktreeAdds.get(commonDir) || Promise.resolve();
    const add = previous
      .catch(() => {})
      .then(() =>
        run('git', [
          '-C',
          project,
          'worktree',
          'add',
          '-b',
          `prquay/${safe}-${token}`,
          dir,
          'HEAD',
        ]),
      );
    worktreeAdds.set(commonDir, add);
    try {
      await add;
    } finally {
      if (worktreeAdds.get(commonDir) === add) worktreeAdds.delete(commonDir);
    }
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
        folder,
        permission,
        agent = 'codex',
        worktree = false,
      } = req.body;
      if (!['codex', 'claude'].includes(agent)) throw Error('Unknown agent');
      const { model, effort } = sessionModelOptions(req.body);
      if (agent === 'claude')
        await run('claude', ['--version'], { timeout: 4000 });
      if (folder !== undefined && worktree)
        throw Error('Choose a project to start a Git worktree');
      const directory = await sessionDirectory({
        project,
        folder,
        projects:
          folder === undefined ? await configuredProjects(state.settings) : [],
      });
      if (project) await rememberWorktree(project, worktree);
      const cwd = worktree
        ? await prepareWorktree(
            directory,
            `session-${path.basename(directory)}`,
          )
        : directory;
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
    '/api/session/:id/options',
    wrap(async (req, res) => {
      const { id } = req.params;
      if (openingDrafts.has(id)) throw Error('This chat is already starting');
      const options = sessionModelOptions(req.body);
      const draft = getDraft(id);
      if (draft) Object.assign(draft, options);
      else {
        const thread = await readSession(id, false);
        if (thread.id !== id) throw Error('Session not found');
        state.sessionOptions[id] = { ...savedSessionOptions(id), ...options };
      }
      await saveState(state);
      res.json({ options });
    }),
  );
  app.post(
    '/api/session/:id/interrupt',
    wrap(async (req, res) => {
      await codex.call('host/interrupt', { threadId: req.params.id });
      res.json({ ok: true });
    }),
  );
  const openingDrafts = new Set();
  app.post(
    '/api/session/:id/message',
    wrap(async (req, res) => {
      let id = req.params.id;
      const text =
        typeof req.body.text === 'string' ? req.body.text.trim() : '';
      if (!text) throw Error('Enter a message');
      const mode = req.body.mode || 'send';
      if (!['send', 'steer'].includes(mode))
        throw Error('Unknown message action');
      const input = [{ type: 'text', text }];
      const draft = getDraft(id);
      if (draft) {
        if (mode === 'steer')
          throw Error('This chat has no active turn to steer');
        if (openingDrafts.has(id)) throw Error('This chat is already starting');
        openingDrafts.add(id);
        try {
          const { model, effort, permission, cwd } = draft;
          if (draft.agent === 'claude') {
            id = await runClaude({
              id: randomUUID(),
              cwd,
              prompt: text,
              model,
              effort,
              permission,
            });
            if (codex.active.has(id))
              pendingClaude.set(id, {
                id,
                cwd,
                agent: 'claude',
                preview: text,
                updatedAt: Date.now() / 1000,
                prompt: text,
                status: { type: 'active' },
              });
          } else {
            const danger = permission === 'danger';
            const started = await codex.call('thread/start', {
              cwd,
              model: model || null,
              approvalPolicy: danger ? 'never' : 'on-request',
              sandbox: danger ? 'danger-full-access' : 'workspace-write',
            });
            id = started.thread.id;
            await codex.call('turn/start', {
              threadId: id,
              input,
              effort: effort || null,
            });
          }
          state.sessionOptions[id] = { model, effort, permission };
          delete state.drafts[req.params.id];
          await saveState(state);
        } finally {
          openingDrafts.delete(req.params.id);
        }
        return res.json({ ok: true, id });
      }
      const thread = await readSession(id, false);
      const agent = id.startsWith('claude:') ? 'claude' : 'codex';
      const guard = await externalUse({ cwd: thread.cwd, agent });
      if (!guard.available)
        throw Error(
          'Unable to check whether this session is in use elsewhere.',
        );
      if (guard.blocked) {
        const name = agent === 'claude' ? 'Claude' : 'Codex';
        throw Error(
          `Another ${name} terminal is open in this project. Close it before sending.`,
        );
      }
      const { model, effort, permission } = savedSessionOptions(id);
      if (agent === 'claude') {
        if (mode === 'steer')
          await codex.call('host/interrupt', { threadId: id });
        await runClaude({
          id: id.slice(7),
          cwd: thread.cwd,
          prompt: text,
          model,
          effort,
          permission: permission || state.settings.permission || 'danger',
          resume: true,
        });
      } else if (mode === 'steer') {
        await codex.call('host/steer', { threadId: id, input });
      } else {
        if (codex.active.has(id))
          throw Error('Steer the active turn or stop it before sending');
        await codex.call('thread/resume', { threadId: id });
        await codex.call('turn/start', {
          threadId: id,
          input,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        });
      }
      res.json({ ok: true, id });
    }),
  );
  app.post(
    '/api/session/:id/archive',
    wrap(async (req, res) => {
      if (getDraft(req.params.id)) {
        if (openingDrafts.has(req.params.id))
          throw Error('This chat is starting');
        delete state.drafts[req.params.id];
        await saveState(state);
        return res.json({ ok: true });
      }
      if (req.params.id.startsWith('claude:'))
        throw Error('Archiving Claude sessions is not supported yet');
      if (codex.active.has(req.params.id))
        throw Error('Stop the active turn before archiving');
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
  async function startJob(input, candidate) {
    const url = canonicalGithubUrl(input.url);
    if (startingJobs.has(url))
      throw Error('A workflow is already starting for this item.');
    startingJobs.add(url);
    try {
      return await launchJob(input, candidate);
    } finally {
      startingJobs.delete(url);
    }
  }
  async function launchJob(input, candidate) {
    const { kind, outcome, forceNew, isolated } = input,
      auto = !!candidate,
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
    if (!project && kind !== 'review')
      throw Error(
        'No local checkout for ' +
          target.repo +
          '. Set its repository folder in Settings.',
      );
    let current;
    if (auto) {
      current = await getPullDetail(url);
      const fresh = autoCandidates(
        { prs: [current] },
        {},
        state.settings,
        state.preparations,
      ).find((item) => item.key === candidate.key);
      if (!state.autoEnabled || !fresh || fresh.mode !== candidate.mode)
        throw Error('The GitHub state or automation settings changed');
    }
    const reviewContext =
      kind === 'review' || (auto && kind === 'comments')
        ? await loadReviewContext(url)
        : undefined;
    const action =
      candidate?.action ||
      (kind === 'review' &&
      (input.rereview === true || reviewContext?.reviewedByMe)
        ? 'rereview'
        : kind);
    if (!project && !current) current = await getPullDetail(url);
    const config = {
      ...state.settings.workflows?.[kind],
      ...state.settings.workflows?.[action],
    };
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
    if (auto) permission = 'sandbox';
    if (auto && !state.autoEnabled) throw Error('Auto mode was turned off');
    let issueContext;
    if (kind === 'describe') {
      issueContext = JSON.parse(
        await run('gh', [
          'issue',
          'view',
          String(target.number),
          '-R',
          getGithubHost() + '/' + target.repo,
          '--json',
          'title,body,comments,labels',
        ]),
      );
      if (issueContext.body?.trim())
        throw Error('This issue already has a description');
    }
    const localReview = kind === 'review' && (auto || !project);
    const restricted = auto || localReview;
    if (restricted) {
      permission = 'sandbox';
      await codex.requireAutomation();
    }
    const sourceHead =
      current?.headRefOid ||
      (target.kind === 'pull' && kind !== 'review'
        ? JSON.parse(
            await run('gh', ['pr', 'view', url, '--json', 'headRefOid']),
          ).headRefOid
        : null);
    if (localReview && reviewContext.pullRequest?.headRefOid !== sourceHead)
      throw Error('The PR changed before the review started');
    let cwd = project?.path,
      id = forceNew || isolated || !project ? null : state.links[url];
    if (
      id &&
      (input.agent || config.agent) &&
      (id.startsWith('claude:') ? 'claude' : 'codex') !== agent
    )
      id = null;
    if (id) {
      try {
        if (id.startsWith('claude:')) {
          const thread = await claudeThread(id);
          cwd = thread.cwd;
          agent = 'claude';
          model ||= state.sessionOptions?.[id]?.model;
          effort ||= state.sessionOptions?.[id]?.effort;
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
      cwd &&
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
    const taskId = randomUUID(),
      artifactDir = path.join(path.dirname(statePath), 'prepared', taskId);
    let automatedContext;
    if (auto || localReview) {
      ({ cwd, context: automatedContext } = await prepareAutomaticCheckout({
        project: project?.path,
        directory: artifactDir,
        pull: current,
        kind,
        discussion: kind === 'comments' ? reviewContext : undefined,
      }));
      if (project) {
        state.worktreeProjects ??= {};
        state.worktreeProjects[cwd] = project.path;
      }
    } else if (
      isolated ||
      (!id &&
        (needsIsolation || (target.kind === 'pull' && isolated !== false)))
    ) {
      cwd = await prepareWorktree(project.path, kind + '-' + target.number);
    }
    await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const artifact =
      localReview || auto
        ? path.join(cwd, 'opus-result-' + taskId + '.json')
        : path.join(
            artifactDir,
            kind === 'describe' ? 'description.md' : 'pr.json',
          );
    const initialHead =
      sourceHead || (await run('git', ['-C', cwd, 'rev-parse', 'HEAD'])).trim();
    const prompt = jobPrompt(kind, url, {
      outcome,
      publish: false,
      auto,
      localReview,
      rereview: action === 'rereview',
      criteria: state.settings.reviewCriteria,
      repositories: ps.filter(
        (other) =>
          other.repo &&
          other.path !== project?.path &&
          ((state.settings.reviewRelatedRepos || []).some(
            (name) => name.toLowerCase() === other.repo.toLowerCase(),
          ) ||
            (reviewContext?.relatedPullRequests || []).some((pull) =>
              pull.url
                .toLowerCase()
                .startsWith(
                  'https://' +
                    getGithubHost() +
                    '/' +
                    other.repo.toLowerCase() +
                    '/',
                ),
            )),
      ),
      automatedContext,
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
        auto,
        action,
        localReview,
        githubHost: getGithubHost(),
        ...(auto
          ? {
              autoKey: candidate.key,
              requestedMode: candidate.mode,
              base: candidate.base,
              signal: candidate.signal,
              viewer: current.viewer,
            }
          : {}),
        pushOnCompletion,
        background: true,
      };
      updateAutoRecord(state.preparations[taskId]);
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
          {
            id: uuid,
            cwd,
            prompt,
            model,
            effort,
            permission,
            resume,
            automated: restricted,
          },
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
            approvalPolicy: danger || restricted ? 'never' : 'on-request',
            sandbox: danger ? 'danger-full-access' : 'workspace-write',
            ...(restricted ? { config: await restrictedCodexConfig(cwd) } : {}),
          })
        ).thread.id;
      }
      if (restricted) {
        const inventory = await codex.call('mcpServerStatus/list', {
          threadId: id,
          limit: 100,
          detail: 'toolsAndAuthOnly',
        });
        if (
          !Array.isArray(inventory.data) ||
          inventory.nextCursor ||
          inventory.data.some((server) => server.runtimeStatus !== 'disabled')
        ) {
          throw Error(
            'Codex still has connected tools in the isolated session',
          );
        }
      }
      await register(id);
      try {
        await codex.call('turn/start', {
          threadId: id,
          input: [{ type: 'text', text: prompt }],
          effort: effort || null,
          ...(model ? { model } : {}),
          ...(restricted
            ? {
                approvalPolicy: 'never',
                sandboxPolicy: {
                  type: 'workspaceWrite',
                  writableRoots: [],
                  networkAccess: false,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
              }
            : {}),
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
  async function restrictedCodexConfig(cwd) {
    const { config } = await codex.call('config/read', {
      cwd,
      includeLayers: false,
    });
    return {
      mcp_servers: Object.fromEntries(
        Object.keys(config?.mcp_servers || {}).map((name) => [
          name,
          { enabled: false },
        ]),
      ),
      web_search: 'disabled',
      shell_environment_policy: { inherit: 'core' },
      features: {
        apps: false,
        plugins: false,
        remote_plugin: false,
        hooks: false,
        browser_use: false,
        browser_use_external: false,
        in_app_browser: false,
        skill_mcp_dependency_install: false,
      },
    };
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
    wrap(async (req, res) => {
      if ('auto' in req.body)
        throw Error('Auto workflows start from synchronized GitHub state');
      res.json(await startJob(req.body));
    }),
  );
  function updateAutoRecord(task) {
    if (!task.autoKey) return;
    state.autoRuns ??= {};
    const record = state.autoRuns[task.autoKey];
    if (record)
      Object.assign(record, {
        id: task.id,
        status: task.status,
        error: task.error,
      });
  }
  function requestAuto() {
    if (autoBusy) {
      runAutoAgain = true;
      return;
    }
    void scheduleAuto().catch((error) =>
      broadcast({ method: 'auto/error', params: { error: error.message } }),
    );
  }
  async function scheduleAuto() {
    if (!state.autoEnabled || autoBusy || polling) return;
    autoBusy = true;
    try {
      for (const task of Object.values(state.preparations)) {
        if (task.githubHost !== getGithubHost()) continue;
        const effect = automaticEffect(task, state.autoEnabled, state.settings);
        if (effect) await applyAutomaticResult(task, effect);
      }
      const tasks = Object.values(state.preparations);
      if (
        !state.autoEnabled ||
        polling ||
        tasks.some(
          (task) =>
            task.auto &&
            ['running', 'collecting', 'publishing'].includes(task.status),
        )
      )
        return;
      const ps = await configuredProjects(state.settings);
      if (!state.autoEnabled || polling) return;
      state.autoRuns ??= {};
      const candidate = autoCandidates(
        cache,
        state.autoRuns,
        state.settings,
        state.preparations,
      ).find(
        (c) =>
          !tasks.some(
            (t) =>
              t.url === c.url &&
              (['running', 'collecting', 'publishing'].includes(t.status) ||
                (t.status === 'pending' &&
                  (t.kind === c.kind || t.type === 'code'))),
          ) &&
          (c.kind === 'review' ||
            ps.some(
              (p) =>
                p.repo?.toLowerCase() === githubUrl(c.url).repo.toLowerCase(),
            )),
      );
      if (!candidate) return;
      await codex.requireAutomation();
      if (!state.autoEnabled || polling) return;
      state.autoRuns[candidate.key] = {
        ...candidate,
        status: 'starting',
        at: Date.now(),
      };
      await saveState(state);
      try {
        const result = await startJob(
          {
            url: candidate.url,
            kind: candidate.kind,
            forceNew: true,
            isolated: true,
          },
          candidate,
        );
        broadcast({
          method: 'auto/started',
          params: {
            threadId: result.id,
            title: candidate.action,
            url: candidate.url,
          },
        });
      } catch (error) {
        Object.assign(state.autoRuns[candidate.key], {
          status: 'failed',
          error: error.message,
        });
        await saveState(state);
        broadcast({
          method: 'auto/error',
          params: { error: error.message, url: candidate.url },
        });
        setTimeout(requestAuto, 0);
      }
    } finally {
      autoBusy = false;
      if (runAutoAgain) {
        runAutoAgain = false;
        setTimeout(requestAuto, 0);
      }
    }
  }
  async function applyAutomaticResult(task, effect) {
    const authorized = () =>
      task.githubHost === getGithubHost() &&
      state.autoEnabled &&
      (effect === 'draft'
        ? getAutoActionMode(state.settings, task.action) !== 'off'
        : getAutoActionMode(state.settings, task.action) === 'publish');
    task.automaticEffect = 'attempted';
    task.status = 'publishing';
    updateAutoRecord(task);
    await saveState(state);
    broadcast({ method: 'approvals/updated', params: { key: task.key } });
    try {
      if (task.type === 'review-artifact') {
        const latest = await getPullDetail(task.url);
        const current = autoCandidates(
          { prs: [latest] },
          {},
          state.settings,
          state.preparations,
        );
        if (
          !current.some((candidate) => candidate.key === task.autoKey) ||
          latest.viewer !== task.viewer
        )
          throw Error('The review request or its latest replies changed');
      }
      const prepared = { ...task, status: 'pending' };
      const result =
        task.type === 'review-artifact'
          ? await materializeReview(prepared, effect, undefined, authorized)
          : await publishPrepared(prepared, undefined, authorized);
      task.status = effect === 'draft' ? 'complete' : 'published';
      task.publishedAt = Date.now();
      task.publishedUrl = result.url;
      if (effect === 'draft') {
        task.note = 'Draft review ready on GitHub';
        if (result.reviewId) task.reviewId = result.reviewId;
      }
      void poll();
    } catch (error) {
      task.status = 'pending';
      task.error = error.message;
    }
    updateAutoRecord(task);
    await saveState(state);
    broadcast({ method: 'approvals/updated', params: { key: task.key } });
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
    requestAuto();
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
      const reviewSettings = validateReviewSettings(req.body, state.settings);
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
      if ('githubHost' in req.body) {
        const previousHost = getGithubHost();
        const host = setGithubHost(req.body.githubHost || 'github.com');
        req.body.githubHost = host;
        if (host !== previousHost) {
          githubGeneration++;
          normalizeGithubBindings();
          detectedUsername = null;
          cache = { prs: [], issues: [], errors: [], updated: null };
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
        'githubHost',
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
      if ('githubHost' in req.body) void poll();
      else requestAuto();
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
    if (task.status === 'publishing' && task.automaticEffect) {
      task.status = 'pending';
      task.error = 'Publication was interrupted. Check GitHub before retrying.';
    }
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
