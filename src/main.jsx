import {
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  LayoutDashboard,
  MessagesSquare,
  GitPullRequest,
  CircleDot,
  Settings,
  Search,
  Plus,
  CircleCheck,
  CircleAlert,
  ArrowRight,
  X,
  Bell,
  BellOff,
  Moon,
  Sun,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import './style.css';
import opusMark from './assets/opus-mark.svg';
import { ApprovalPreview } from './Approvals.jsx';
import { SettingsPage } from './SettingsPage.jsx';
import { SessionModal } from './SessionModal.jsx';
import { SessionNavigator, ChatControls, ChatInput } from './Orchestrator.jsx';
import { SprintPage, IssueRow } from './Sprint.jsx';
import {
  FocusPage,
  PullActionDialog,
  PullRequestPage,
} from './PullRequests.jsx';
import { pullUrlKey, queueForPull } from './pull-queues.js';
const api = async (url, opts = {}) => {
  const r = await fetch('/api' + url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-PRQuay': 'local',
      ...opts.headers,
    },
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.error || 'Request failed');
  return j;
};
const post = (u, v = {}) => api(u, { method: 'POST', body: JSON.stringify(v) });
const age = (t) => {
  if (!t) return '—';
  const d = Math.max(
    0,
    (Date.now() - new Date(typeof t === 'number' ? t * 1000 : t)) / 1000,
  );
  return d < 60
    ? 'just now'
    : d < 3600
      ? `${Math.floor(d / 60)}m ago`
      : d < 86400
        ? `${Math.floor(d / 3600)}h ago`
        : `${Math.floor(d / 86400)}d ago`;
};
const repo = (x) =>
  x.repository?.nameWithOwner ||
  x.repository?.name ||
  x.url?.split('/').slice(3, 5).join('/') ||
  '';
const routes = {
  sprint: '/sprint',
  focus: '/focus',
  sessions: '/sessions',
  prs: '/pull-requests',
  issues: '/issues',
  cleanup: '/cleanup',
  settings: '/settings',
};
function readRoute() {
  const pieces = window.location.pathname.split('/').filter(Boolean);
  if (pieces[0] === 'sessions') {
    let id = null;
    try {
      id = pieces[1] ? decodeURIComponent(pieces[1]) : null;
    } catch {}
    return { page: 'sessions', chat: id };
  }
  const page =
    Object.entries(routes).find(
      ([, path]) => path === window.location.pathname,
    )?.[0] || 'focus';
  return { page, chat: null };
}
function routeFor(page, chat) {
  return page === 'sessions' && chat
    ? `/sessions/${encodeURIComponent(chat)}`
    : routes[page] || routes.focus;
}
function App() {
  const [page, setPage] = useState(() => readRoute().page),
    [status, S] = useState({
      projects: [],
      settings: {},
      available: {},
      links: {},
    }),
    [statusLoaded, StatusLoaded] = useState(false),
    [sessionsLoaded, SessionsLoaded] = useState(false),
    [data, D] = useState({ prs: [], issues: [], errors: [] }),
    [sessions, T] = useState([]),
    [models, M] = useState({}),
    [query, Q] = useState(''),
    [filter, F] = useState('all'),
    [chat, C] = useState(() => readRoute().chat),
    [thread, Thread] = useState(null),
    [chatControls, ChatControlState] = useState(null),
    [externalCheck, ExternalCheck] = useState(null),
    [requests, R] = useState([]),
    [modal, Modal] = useState(null),
    [error, E] = useState(''),
    [loading, L] = useState(false),
    [sessionView, SessionView] = useState('all'),
    [approvals, Approvals] = useState([]),
    [startingJobs, StartingJobs] = useState({}),
    [approvalKey, ApprovalKey] = useState(null),
    [pullAction, PullAction] = useState(null),
    [pullOverrides, PullOverrides] = useState({}),
    [allIssues, AllIssues] = useState(null),
    [selectedIssues, SelectIssues] = useState([]),
    [cleanupSelected, CleanupSelected] = useState([]),
    [staleDays, StaleDays] = useState(30),
    [cleanupIssues, CleanupIssues] = useState(null),
    [noticeOpen, NoticeOpen] = useState(false),
    [notices, Notices] = useState(() => {
      try {
        return JSON.parse(localStorage.getItem('prquay-notices') || '[]');
      } catch {
        return [];
      }
    }),
    [desktop, Desktop] = useState(
      () =>
        localStorage.getItem('prquay-desktop') === 'true' &&
        'Notification' in window &&
        Notification.permission === 'granted',
    ),
    [collapsedGroups, CollapsedGroups] = useState(() => {
      try {
        return JSON.parse(localStorage.getItem('opusdesk-collapsed') || '{}');
      } catch {
        return {};
      }
    }),
    [cleanupJob, CleanupJob] = useState(() => {
      try {
        return JSON.parse(sessionStorage.getItem('opusdesk-cleanup') || 'null');
      } catch {
        return null;
      }
    }),
    [theme, Theme] = useState(
      () => localStorage.getItem('prquay-theme') || 'dark',
    );
  const notificationAnchor = useRef(null);
  useEffect(() => {
    if (!noticeOpen) return;
    const dismissOutside = (event) => {
      if (!notificationAnchor.current?.contains(event.target))
        NoticeOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () =>
      document.removeEventListener('pointerdown', dismissOutside, true);
  }, [noticeOpen]);
  useEffect(() => {
    const desired = routeFor(page, chat);
    if (window.location.pathname !== desired)
      history.pushState({}, '', desired);
  }, [page, chat]);
  useEffect(() => {
    const onPop = () => {
      const route = readRoute();
      setPage(route.page);
      C(route.chat);
      Q('');
      F('all');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('prquay-theme', theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem('prquay-notices', JSON.stringify(notices));
  }, [notices]);
  useEffect(() => {
    localStorage.setItem('prquay-desktop', String(desktop));
  }, [desktop]);
  useEffect(() => {
    localStorage.setItem('opusdesk-collapsed', JSON.stringify(collapsedGroups));
  }, [collapsedGroups]);
  useEffect(() => {
    if (cleanupJob)
      sessionStorage.setItem('opusdesk-cleanup', JSON.stringify(cleanupJob));
    else sessionStorage.removeItem('opusdesk-cleanup');
  }, [cleanupJob]);
  const refresh = useCallback(async () => {
    const rs = await Promise.allSettled([
      api('/status'),
      api('/github'),
      api('/sessions?archived=all'),
      api('/requests'),
      api('/approvals'),
    ]);
    if (rs[0].status === 'fulfilled') {
      S(rs[0].value);
      StatusLoaded(true);
    }
    if (rs[1].status === 'fulfilled') D(rs[1].value);
    if (rs[2].status === 'fulfilled') {
      T(rs[2].value.data || []);
      SessionsLoaded(true);
    }
    if (rs[3].status === 'fulfilled') R(rs[3].value);
    if (rs[4].status === 'fulfilled') Approvals(rs[4].value.tasks || []);
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      await Promise.allSettled(
        ['codex', 'claude'].map(async (agent) => {
          try {
            const result = await api('/models?agent=' + agent);
            if (!cancelled) M((old) => ({ ...old, [agent]: result }));
          } catch {}
        }),
      );
    }
    void loadModels();
    const timer = setInterval(loadModels, 300000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const chatBody = useRef(null),
    chatLoad = useRef(0),
    lastChat = useRef(null),
    followBottom = useRef(true);
  useEffect(() => {
    if (page !== 'sessions') lastChat.current = null;
  }, [page]);
  useLayoutEffect(() => {
    if (!chatBody.current || thread?.id !== chat) return;
    const changed = lastChat.current !== chat;
    if (changed || followBottom.current) {
      chatBody.current.scrollTop = chatBody.current.scrollHeight;
      followBottom.current = true;
    }
    lastChat.current = chat;
  }, [chat, thread, requests]);

  useEffect(() => {
    refresh();
    const stream = new EventSource('/api/events');
    let chatTimer;
    stream.onmessage = (e) => {
      const x = JSON.parse(e.data);
      let n = null;
      if (x.method === 'pr/checkFailed')
        n = { title: 'Checks failed', body: x.params.title, url: x.params.url };
      if (x.method === 'pr/reviewRequested')
        n = {
          title: 'Review requested',
          body: x.params.title,
          url: x.params.url,
        };
      if (x.method === 'turn/completed')
        n = {
          title:
            (x.params?.turn?.status || x.params?.status) === 'interrupted'
              ? 'Agent stopped'
              : (x.params?.turn?.status || x.params?.status) === 'failed'
                ? 'Agent failed'
                : 'Agent finished',
          body: x.params?.error || 'Open the conversation',
          threadId: x.params.threadId,
        };
      if (n) {
        n = { ...n, id: crypto.randomUUID(), at: Date.now() };
        Notices((prev) => [n, ...prev].slice(0, 100));
        if (
          desktop &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          const notification = new Notification(n.title, {
            body: n.body,
            tag: n.url || n.threadId,
          });
          notification.onclick = () => {
            window.focus();
            if (n.url) window.open(n.url, '_blank', 'noopener');
            if (n.threadId) {
              setPage('sessions');
              C(n.threadId);
            } else setPage('prs');
          };
        }
      }
      if (
        [
          'github/updated',
          'turn/completed',
          'turn/started',
          'thread/started',
          'item/tool/requestUserInput',
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
        ].includes(x.method)
      )
        refresh();
      if (x.method === 'approvals/updated') refresh();
      if (x.method === 'auto/error') E(`Auto: ${x.params.error}`);
      if (x.method === 'auto/changed' || x.method === 'auto/started') refresh();
      if (x.method === 'claude/error') E(x.params.error);
      if (x.method === 'turn/completed' && x.params?.error) E(x.params.error);
      if (chat && x.params?.threadId === chat) {
        clearTimeout(chatTimer);
        chatTimer = setTimeout(() => loadChat(chat), 120);
      }
    };
    return () => {
      clearTimeout(chatTimer);
      stream.close();
    };
  }, [refresh, chat, desktop]);

  async function loadChat(id) {
    const request = ++chatLoad.current;
    try {
      const result = await api('/session/' + encodeURIComponent(id));
      if (chatLoad.current !== request) return;
      Thread(result.thread);
      ExternalCheck(result.externalUse);
      ChatControlState({ id, active: result.active, options: result.options });
      R(await api('/requests'));
    } catch (e) {
      if (chatLoad.current === request) E(e.message);
    }
  }
  useEffect(() => {
    ExternalCheck(null);
    if (!chat) return;
    loadChat(chat);
    const timer = setInterval(() => loadChat(chat), 5000);
    return () => {
      ++chatLoad.current;
      clearInterval(timer);
    };
  }, [chat]);
  const guard = async (fn) => {
    try {
      E('');
      L(true);
      await fn();
      await refresh();
      return true;
    } catch (e) {
      E(e.message);
      return false;
    } finally {
      L(false);
    }
  };
  async function job(url, kind, outcome, options = {}) {
    StartingJobs((old) => ({ ...old, [url]: { kind, status: 'starting' } }));
    try {
      E('');
      const r = await post('/job', { url, kind, outcome, ...options });
      S((old) => ({ ...old, links: { ...old.links, [url]: r.id } }));
      Modal(null);
      await refresh();
    } catch (error) {
      E(error.message);
    } finally {
      StartingJobs((old) => {
        const next = { ...old };
        delete next[url];
        return next;
      });
    }
  }
  async function start(form) {
    await guard(async () => {
      let r = await post('/session', form);
      Modal(null);
      C(r.id);
      setPage('sessions');
    });
  }
  const navigate = (p) => {
    setPage(p);
    Q('');
    F('all');
    if (p === 'cleanup')
      api('/issues/local')
        .then((x) => {
          CleanupIssues(x.issues);
          if (x.errors) E(`Could not load issues for ${x.errors} repositories`);
        })
        .catch((e) => E(e.message));
  };
  async function bulkIssues(urls, outcome, options) {
    StartingJobs((old) => ({
      ...old,
      ...Object.fromEntries(
        urls.map((url) => [url, { kind: 'issue', status: 'starting' }]),
      ),
    }));
    try {
      await guard(async () => {
        const results = await Promise.allSettled(
          urls.map((url) =>
            post('/job', { url, kind: 'issue', outcome, ...options }),
          ),
        );
        const failed = results
          .map((r, i) =>
            r.status === 'rejected' ? `${urls[i]}: ${r.reason.message}` : null,
          )
          .filter(Boolean);
        SelectIssues(
          failed.length
            ? urls.filter((u, i) => results[i].status === 'rejected')
            : [],
        );
        Modal(null);
        if (failed.length) E(`Some jobs did not start: ${failed.join(' · ')}`);
      });
    } finally {
      StartingJobs((old) => {
        const next = { ...old };
        for (const url of urls) delete next[url];
        return next;
      });
    }
  }
  const jobsByUrl = {
    ...Object.fromEntries(
      [...approvals].reverse().map((task) => [task.url, task]),
    ),
    ...startingJobs,
  };
  async function closeCleanup(urls) {
    try {
      E('');
      const job = await post('/cleanup/close', { urls });
      CleanupJob({
        id: job.id,
        total: urls.length,
        completed: 0,
        status: 'running',
      });
      Modal(null);
      CleanupSelected([]);
    } catch (e) {
      E(e.message);
    }
  }
  useEffect(() => {
    if (!cleanupJob?.id || cleanupJob.status !== 'running') return;
    let stopped = false;
    const check = async () => {
      try {
        const job = await api('/cleanup/jobs/' + cleanupJob.id);
        if (stopped) return;
        CleanupJob(job);
        if (job.status === 'complete') {
          const failed = job.results.filter((x) => !x.ok);
          const done = new Set(
            job.results.filter((x) => x.ok).map((x) => x.url),
          );
          D((prev) => ({
            ...prev,
            prs: prev.prs.filter((x) => !done.has(x.url)),
            issues: prev.issues.filter((x) => !done.has(x.url)),
          }));
          CleanupSelected(failed.map((x) => x.url));
          if (failed.length)
            E(
              `Some items were not closed: ${failed.map((x) => `${x.url}: ${x.error}`).join(' · ')}`,
            );
          api('/issues/local')
            .then((x) => CleanupIssues(x.issues))
            .catch(() => {});
          refresh();
        } else if (job.status === 'failed') E(job.error || 'Cleanup failed');
      } catch (e) {
        if (!stopped) {
          E(e.message);
          CleanupJob((prev) => ({
            ...prev,
            status: 'failed',
            error: e.message,
          }));
        }
      }
    };
    check();
    const timer = setInterval(check, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [cleanupJob?.id, cleanupJob?.status, refresh]);

  const search = (obj) =>
    JSON.stringify(obj).toLowerCase().includes(query.toLowerCase());
  const issue = (allIssues || data.issues).filter(
    (x) => search(x) && (filter !== 'reply' || x.needsReply),
  );
  const cutoff = Date.now() - staleDays * 86400000;
  const cleanupItems = [
    ...new Map(
      [...data.prs, ...data.issues, ...(cleanupIssues || [])]
        .filter(
          (x) =>
            x.state?.toUpperCase() === 'OPEN' &&
            new Date(x.updatedAt).getTime() < cutoff,
        )
        .map((x) => [x.url, x]),
    ).values(),
  ].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const activeReq = requests.filter((r) => r.params?.threadId === chat);
  const currentChat = thread?.id === chat ? thread : null;
  const chatAgent =
    chat?.startsWith('claude:') || currentChat?.agent === 'claude'
      ? 'claude'
      : 'codex';
  const activeChat = chatControls?.id === chat && chatControls.active;
  const archivedChat = sessions.some(
    (session) => session.id === chat && session.archived,
  );
  const pullLinks = new Map(
    Object.entries(status.links || {}).map(([url, id]) => [
      pullUrlKey(url),
      id,
    ]),
  );
  const pullJobs = new Map(
    Object.entries(jobsByUrl).map(([url, task]) => [pullUrlKey(url), task]),
  );
  for (const task of approvals) {
    const key = pullUrlKey(task.url);
    if (!key || task.status !== 'pending') continue;
    const job = pullJobs.get(key);
    pullJobs.set(key, {
      ...job,
      pendingTasks: [...(job.pendingTasks || []), task],
    });
  }
  const unread = data.prs.filter(
    (pr) =>
      queueForPull(pr, pullJobs.get(pullUrlKey(pr.url))) === 'needs-review',
  );
  const openChat = (id) => {
    C(id);
    navigate('sessions');
  };
  const pullActions = {
    runJob: job,
    preview: ApprovalKey,
    confirmAction: PullAction,
    age,
  };
  function trackPull(pr) {
    const key = pullUrlKey(pr.url);
    PullOverrides((old) => {
      if (!(key in old)) return old;
      const next = { ...old };
      delete next[key];
      return next;
    });
    D((old) => ({
      ...old,
      prs: [pr, ...old.prs.filter((item) => pullUrlKey(item.url) !== key)],
    }));
  }
  function pullActionChanged({ kind, pr }) {
    const key = pullUrlKey(pr.url);
    const change =
      kind === 'merge'
        ? { state: 'MERGED', readyToMerge: false }
        : {
            pendingReview: false,
            pendingResponse: false,
            reviewedByMe: true,
            reviewedCurrentHead: true,
          };
    PullOverrides((old) => ({ ...old, [key]: { ...pr, ...change } }));
    D((old) => ({
      ...old,
      prs: old.prs.map((item) =>
        pullUrlKey(item.url) === key ? { ...item, ...change } : item,
      ),
    }));
    void refresh();
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate('focus')}
          aria-label="Opus Desk home"
        >
          <span className="brandmark">
            <img src={opusMark} alt="" width="36" height="36" />
          </span>
          <strong>Opus Desk</strong>
        </button>
        <nav aria-label="Main navigation">
          {[
            ['focus', 'Focus', LayoutDashboard],
            ['sessions', 'Orchestrator', MessagesSquare],
            ['prs', 'Pull requests', GitPullRequest],
            ['issues', 'Issues', CircleDot],
            ['cleanup', 'Cleanup', Trash2],
            ...(status.settings.sprintRepo && status.settings.sprintProjectId
              ? [['sprint', 'Sprint', CircleDot]]
              : []),
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              className={page === key ? 'nav active' : 'nav'}
              aria-label={label}
              aria-current={page === key ? 'page' : undefined}
              title={label}
              onClick={() => navigate(key)}
            >
              <Icon size={17} />
              <span>{label}</span>
              {key === 'prs' && unread.length > 0 && <i>{unread.length}</i>}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <button
            className={page === 'settings' ? 'nav active' : 'nav'}
            aria-label="Settings"
            aria-current={page === 'settings' ? 'page' : undefined}
            title="Settings"
            onClick={() => navigate('settings')}
          >
            <Settings size={17} />
            <span>Settings</span>
          </button>
          <div className="local-badge">
            <span className="pulse" />{' '}
            <div>
              <b>Running locally</b>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <header className="top">
          <div className="top-actions">
            <button
              className={'auto-toggle ' + (status.autoEnabled ? 'on' : '')}
              disabled={!statusLoaded}
              aria-pressed={!!status.autoEnabled}
              title="Run configured workflows automatically"
              onClick={() =>
                guard(async () => {
                  await post('/auto', { enabled: !status.autoEnabled });
                })
              }
            >
              <span className="auto-indicator" /> Auto{' '}
              {statusLoaded ? (status.autoEnabled ? 'on' : 'off') : '…'}
            </button>
            <button
              className="icon-btn"
              title={
                theme === 'dark'
                  ? 'Switch to light mode'
                  : 'Switch to dark mode'
              }
              onClick={() => Theme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <div className="notification-anchor" ref={notificationAnchor}>
              <button
                className="icon-btn notification-button"
                aria-label="Notifications"
                aria-expanded={noticeOpen}
                aria-controls="notification-inbox"
                title={
                  desktop
                    ? 'Desktop notifications enabled'
                    : 'Desktop notifications disabled'
                }
                onClick={() => NoticeOpen(!noticeOpen)}
              >
                {desktop ? <Bell size={17} /> : <BellOff size={17} />}
                {notices.length > 0 && <span className="notice-dot" />}
              </button>
              {noticeOpen && (
                <div className="notification-popover" id="notification-inbox">
                  <div className="notice-head">
                    <b>Notifications</b>
                    <button className="text-btn" onClick={() => Notices([])}>
                      Clear all
                    </button>
                  </div>
                  <div className="notice-controls">
                    <span>Desktop notifications</span>
                    <button
                      className="text-btn"
                      onClick={async () => {
                        if (desktop) {
                          Desktop(false);
                          return;
                        }
                        if (!('Notification' in window)) {
                          E(
                            'Desktop notifications are not supported in this browser',
                          );
                          return;
                        }
                        const p = await Notification.requestPermission();
                        Desktop(p === 'granted');
                        if (p === 'denied')
                          E(
                            'Enable notifications for this site in your browser settings',
                          );
                      }}
                    >
                      {desktop ? 'On' : 'Off'}
                    </button>
                  </div>
                  <div className="notice-list">
                    {notices.length ? (
                      notices.map((n) => (
                        <button
                          className="notice-item"
                          key={n.id}
                          onClick={() => {
                            NoticeOpen(false);
                            if (n.threadId) {
                              C(n.threadId);
                              navigate('sessions');
                            } else if (n.url) {
                              window.open(n.url, '_blank', 'noopener');
                              navigate('prs');
                            }
                          }}
                        >
                          <b>{n.title}</b>
                          <span>{n.body}</span>
                          <small>{age(n.at / 1000)}</small>
                        </button>
                      ))
                    ) : (
                      <div className="notice-empty">No notifications yet</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              className="button primary"
              onClick={() => Modal({ type: 'new' })}
            >
              <Plus size={15} /> New chat
            </button>
          </div>
        </header>
        <div
          className={
            'content ' + (page === 'sessions' ? 'orchestrator-content' : '')
          }
        >
          {error && (
            <div className="error">
              <CircleAlert size={17} />
              {error}
              <button onClick={() => E('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {data.errors?.length > 0 && (
            <div className="error">
              GitHub refresh: {data.errors.join(' · ')}
            </div>
          )}
          {page === 'focus' && (
            <FocusPage
              data={data}
              jobs={pullJobs}
              links={pullLinks}
              approvals={approvals}
              showPulls={() => navigate('prs')}
              showIssues={() => navigate('issues')}
              openChat={openChat}
              {...pullActions}
            />
          )}
          {page === 'prs' && (
            <PullRequestPage
              pulls={data.prs}
              jobs={pullJobs}
              links={pullLinks}
              overrides={pullOverrides}
              api={api}
              post={post}
              onTrack={trackPull}
              {...pullActions}
            />
          )}

          {page === 'issues' && (
            <>
              <div className="compact-title">
                <h1>Issues</h1>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!allIssues}
                    onChange={(e) =>
                      guard(async () => {
                        if (e.target.checked) {
                          const x = await api('/issues/local');
                          AllIssues(x.issues);
                          if (x.errors)
                            E(
                              `Could not load issues for ${x.errors} repositories`,
                            );
                        } else AllIssues(null);
                      })
                    }
                  />{' '}
                  All open issues in local repositories
                </label>
              </div>
              <div className="toolbar">
                <SearchBox
                  value={query}
                  set={Q}
                  placeholder="Search issues, repositories, or people"
                />
              </div>
              <div className="filter-pills">
                {[
                  ['all', 'All'],
                  ['reply', 'Needs reply'],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    className={filter === v ? 'selected' : ''}
                    onClick={() => F(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <section className="panel list-panel">
                <div className="list-head">
                  <span>
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          issue.length > 0 &&
                          issue.every((x) => selectedIssues.includes(x.url))
                        }
                        onChange={(e) =>
                          SelectIssues(
                            e.target.checked
                              ? [
                                  ...new Set([
                                    ...selectedIssues,
                                    ...issue.map((x) => x.url),
                                  ]),
                                ]
                              : selectedIssues.filter(
                                  (u) => !issue.some((x) => x.url === u),
                                ),
                          )
                        }
                      />{' '}
                      {allIssues ? 'LOCAL REPOSITORIES' : 'ASSIGNED TO YOU'}
                    </label>{' '}
                    <b>{issue.length}</b>
                  </span>
                </div>
                {issue.length ? (
                  issue.map((x) => (
                    <IssueRow
                      key={x.url}
                      item={x}
                      selected={selectedIssues.includes(x.url)}
                      onSelect={(checked) =>
                        SelectIssues(
                          checked
                            ? [...selectedIssues, x.url]
                            : selectedIssues.filter((u) => u !== x.url),
                        )
                      }
                      age={age}
                      job={jobsByUrl[x.url]}
                      linked={status.links?.[x.url]}
                      onAddress={(item) => Modal({ type: 'issue', item })}
                      onDescribe={(item) => Modal({ type: 'describe', item })}
                      onComment={(item) => Modal({ type: 'comment', item })}
                    />
                  ))
                ) : (
                  <Empty text="No matching issues." />
                )}
              </section>
              {selectedIssues.length > 0 && (
                <div className="bulk-bar">
                  <b>{selectedIssues.length} selected</b>
                  <button className="text-btn" onClick={() => SelectIssues([])}>
                    Clear
                  </button>
                  <button
                    className="button primary"
                    onClick={() =>
                      Modal({ type: 'bulk', urls: selectedIssues })
                    }
                  >
                    Address selected <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </>
          )}
          {page === 'sprint' && (
            <SprintPage
              settings={status.settings}
              api={api}
              revision={data.updated}
              jobs={jobsByUrl}
              links={status.links}
              onSettings={() => navigate('settings')}
              onAddress={(item) => Modal({ type: 'issue', item })}
              onDescribe={(item) => Modal({ type: 'describe', item })}
              onComment={(item) => Modal({ type: 'comment', item })}
            />
          )}
          {page === 'cleanup' && (
            <>
              <div className="compact-title">
                <div>
                  <h1>Cleanup</h1>
                  <p>Open items with no updates in the selected period.</p>
                </div>
                <label className="inline-label">
                  Inactive for{' '}
                  <select
                    value={staleDays}
                    onChange={(e) => {
                      StaleDays(Number(e.target.value));
                      CleanupSelected([]);
                    }}
                  >
                    <option value={30}>30 days</option>
                    <option value={60}>60 days</option>
                    <option value={90}>90 days</option>
                    <option value={180}>180 days</option>
                  </select>
                </label>
              </div>
              <p className="muted compact-note">
                PRs you are involved in and issues in your local repositories or
                assigned to you. Results are limited by GitHub search and your
                access.
              </p>
              <div className="cleanup-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={
                      cleanupItems.length > 0 &&
                      cleanupSelected.length === cleanupItems.length
                    }
                    onChange={(e) =>
                      CleanupSelected(
                        e.target.checked ? cleanupItems.map((x) => x.url) : [],
                      )
                    }
                  />{' '}
                  Select all ({cleanupItems.length})
                </label>
                <div className="cleanup-buttons">
                  <button
                    className="button"
                    disabled={
                      !cleanupItems.length || cleanupJob?.status === 'running'
                    }
                    onClick={() =>
                      Modal({
                        type: 'cleanup',
                        urls: cleanupItems.map((x) => x.url),
                      })
                    }
                  >
                    Close all ({cleanupItems.length})
                  </button>
                  <button
                    className="button danger-button"
                    disabled={
                      !cleanupSelected.length ||
                      cleanupJob?.status === 'running'
                    }
                    onClick={() =>
                      Modal({ type: 'cleanup', urls: cleanupSelected })
                    }
                  >
                    Close selected ({cleanupSelected.length})
                  </button>
                </div>
              </div>
              <section className="panel list-panel">
                {cleanupItems.length ? (
                  cleanupItems.map((x) => (
                    <div className="pr-row" key={x.url}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${x.title}`}
                        checked={cleanupSelected.includes(x.url)}
                        onChange={(e) =>
                          CleanupSelected(
                            e.target.checked
                              ? [...cleanupSelected, x.url]
                              : cleanupSelected.filter((u) => u !== x.url),
                          )
                        }
                      />
                      <div
                        className={
                          'row-icon ' +
                          (x.url.includes('/issues/') ? 'issue' : '')
                        }
                      >
                        {x.url.includes('/issues/') ? (
                          <CircleDot size={16} />
                        ) : (
                          <GitPullRequest size={16} />
                        )}
                      </div>
                      <div className="row-main">
                        <a
                          className="item-link"
                          target="_blank"
                          rel="noreferrer"
                          href={x.url}
                        >
                          {x.title}
                        </a>
                        <div className="row-meta">
                          {repo(x)} #{x.number} ·{' '}
                          {x.url.includes('/issues/') ? 'Issue' : 'PR'}
                        </div>
                      </div>
                      <span className="row-time">{age(x.updatedAt)}</span>
                    </div>
                  ))
                ) : (
                  <Empty
                    text={
                      cleanupIssues === null
                        ? 'Loading issues…'
                        : 'No stale items in this view.'
                    }
                  />
                )}
              </section>
            </>
          )}
          {page === 'sessions' && (
            <>
              <h1 className="sr-only">Orchestrator</h1>
              <div className="sessions-layout">
                <SessionNavigator
                  api={api}
                  sessions={sessions}
                  loaded={sessionsLoaded}
                  projects={status.projects}
                  worktrees={status.worktreeProjects || {}}
                  chat={chat}
                  select={C}
                  requests={requests}
                  collapsed={collapsedGroups}
                  setCollapsed={CollapsedGroups}
                  view={sessionView}
                  setView={SessionView}
                  openNew={(target) => Modal({ type: 'new', ...target })}
                  age={age}
                />
                <section className="panel chat-panel">
                  {chat ? (
                    <>
                      <div className="chat-head">
                        <div>
                          <span className="section-kicker">
                            {chatAgent === 'claude' ? 'Claude Code' : 'Codex'}
                          </span>
                          <h2>
                            {currentChat?.name ||
                              currentChat?.preview ||
                              'Conversation'}
                          </h2>
                          <small>{currentChat?.cwd}</small>
                          <div className="chat-links">
                            {Object.entries(status.links || {})
                              .filter(([, id]) => id === chat)
                              .map(([url]) => (
                                <a
                                  key={url}
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {url.includes('/pull/') ? 'PR' : 'Issue'} #
                                  {url.split('/').pop()}{' '}
                                  <ExternalLink size={11} />
                                </a>
                              ))}
                          </div>
                        </div>
                        <ChatControls
                          key={chat}
                          active={activeChat}
                          agent={chatAgent}
                          options={
                            chatControls?.id === chat
                              ? chatControls.options
                              : null
                          }
                          models={models}
                          loading={loading}
                          stop={() =>
                            guard(async () => {
                              await post(
                                '/session/' +
                                  encodeURIComponent(chat) +
                                  '/interrupt',
                              );
                              await loadChat(chat);
                            })
                          }
                          save={(options) =>
                            guard(async () => {
                              await post(
                                '/session/' +
                                  encodeURIComponent(chat) +
                                  '/options',
                                options,
                              );
                              await loadChat(chat);
                            })
                          }
                          archive={
                            !archivedChat &&
                            (chatAgent === 'codex' || chat.startsWith('draft:'))
                              ? () =>
                                  guard(async () => {
                                    await post(
                                      '/session/' +
                                        encodeURIComponent(chat) +
                                        '/archive',
                                    );
                                    C(null);
                                    Thread(null);
                                  })
                              : null
                          }
                        />
                      </div>
                      <div
                        className="chat-body"
                        ref={chatBody}
                        onScroll={(e) => {
                          const x = e.currentTarget;
                          followBottom.current =
                            x.scrollHeight - x.scrollTop - x.clientHeight < 80;
                        }}
                      >
                        {currentChat?.turns
                          ?.flatMap((t) => t.items || [])
                          .map((item, i) => (
                            <ChatItem
                              key={item.id || i}
                              item={item}
                              agent={
                                chatAgent === 'claude' ? 'Claude' : 'Codex'
                              }
                            />
                          ))}
                        {activeReq.map((r) => (
                          <Request
                            key={r.id}
                            request={r}
                            onSubmit={(result) =>
                              guard(async () => {
                                await post('/requests/' + r.id, { result });
                                await loadChat(chat);
                              })
                            }
                          />
                        ))}
                      </div>
                      {currentChat &&
                        externalCheck &&
                        (externalCheck.blocked || !externalCheck.available) && (
                          <div className="external-warning">
                            {externalCheck.blocked
                              ? 'A terminal is using this project. Close that session before sending here.'
                              : 'Unable to check whether another terminal is using this project.'}
                          </div>
                        )}
                      <ChatInput
                        key={chat}
                        active={activeChat}
                        agent={chatAgent}
                        disabled={
                          loading ||
                          !currentChat ||
                          !externalCheck ||
                          externalCheck.blocked ||
                          !externalCheck.available
                        }
                        send={(text) =>
                          guard(async () => {
                            const result = await post(
                              '/session/' +
                                encodeURIComponent(chat) +
                                '/message',
                              { text, mode: activeChat ? 'steer' : 'send' },
                            );
                            if (result.id !== chat) {
                              followBottom.current = true;
                              C(result.id);
                            } else await loadChat(chat);
                          })
                        }
                      />
                    </>
                  ) : (
                    <div className="chat-empty">
                      <div className="empty-art">
                        <MessagesSquare size={24} />
                      </div>
                      <h2>Choose a chat</h2>
                      <button
                        className="button"
                        onClick={() => Modal({ type: 'new' })}
                      >
                        <Plus size={15} /> New chat
                      </button>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
          {page === 'settings' && !statusLoaded && (
            <>
              <div className="compact-title">
                <h1>Settings</h1>
              </div>
              <p className="muted" role="status">
                Loading settings…
              </p>
            </>
          )}
          {page === 'settings' && statusLoaded && (
            <SettingsPage
              settings={status.settings}
              available={status.available}
              models={models}
              status={status}
              api={api}
              save={async (patch) => {
                const settings = await post('/settings', patch);
                S((prev) => ({ ...prev, settings }));
                if (
                  ['root', 'repoPaths', 'githubUsername'].some(
                    (key) => key in patch,
                  )
                )
                  S(await api('/status'));
                return settings;
              }}
            />
          )}
        </div>
      </main>
      {approvalKey && (
        <ApprovalPreview
          taskKey={approvalKey}
          api={api}
          post={post}
          close={() => ApprovalKey(null)}
          onChanged={refresh}
          openChat={(id) => {
            ApprovalKey(null);
            C(id);
            navigate('sessions');
          }}
        />
      )}
      {pullAction && (
        <PullActionDialog
          action={pullAction}
          close={() => PullAction(null)}
          post={post}
          onChanged={pullActionChanged}
        />
      )}
      {cleanupJob && (
        <div className="cleanup-progress" role="status">
          <span className={cleanupJob.status === 'running' ? 'spinner' : ''} />
          {cleanupJob.status === 'running'
            ? `Closing ${cleanupJob.completed} / ${cleanupJob.total}…`
            : `Cleanup ${cleanupJob.status} · ${cleanupJob.results?.filter((x) => x.ok).length || 0} closed`}
          <button
            className="icon-btn"
            aria-label="Dismiss"
            onClick={() => CleanupJob(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {modal && (
        <SessionModal
          modal={modal}
          close={() => Modal(null)}
          status={status}
          models={models}
          start={start}
          job={job}
          loading={loading}
          bulkIssues={bulkIssues}
          closeCleanup={closeCleanup}
          commentIssue={(item, body) =>
            guard(async () => {
              await post('/issues/comment', { url: item.url, body });
              Modal(null);
              D((prev) => ({
                ...prev,
                issues: prev.issues.map((i) =>
                  i.url === item.url ? { ...i, needsReply: false } : i,
                ),
              }));
              if (allIssues)
                AllIssues((prev) =>
                  prev.map((i) =>
                    i.url === item.url ? { ...i, needsReply: false } : i,
                  ),
                );
            })
          }
        />
      )}
    </div>
  );
}
function SearchBox({ value, set, placeholder }) {
  return (
    <label className="search">
      <Search size={16} />
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
function Empty({ text }) {
  return (
    <div className="empty">
      <CircleCheck size={22} />
      <p>{text}</p>
    </div>
  );
}
function ChatItem({ item, agent = 'Codex' }) {
  let text;
  let type = item.type || '';
  if (type === 'userMessage')
    text = item.content?.map((x) => x.text || '').join('\n');
  else if (type === 'agentMessage') text = item.text;
  else if (type === 'plan') text = item.text;
  else return null;
  text = (text || '').trim();
  if (!text) return null;
  return (
    <div className={'message ' + (type === 'userMessage' ? 'user' : 'agent')}>
      <div className="message-label">
        {type === 'userMessage' ? 'YOU' : agent.toUpperCase()}
      </div>
      <div>{text}</div>
    </div>
  );
}
function Request({ request, onSubmit }) {
  const [answers, A] = useState({});
  const qs = request.params?.questions;
  if (!qs) {
    const supported = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ].includes(request.method);
    return (
      <div className="request">
        <b>Approval requested</b>
        <p>{request.params?.reason || request.method}</p>
        {request.params?.command && (
          <pre className="approval-command">{request.params.command}</pre>
        )}
        {supported ? (
          <>
            <button
              className="button"
              onClick={() => onSubmit({ decision: 'accept' })}
            >
              Approve
            </button>{' '}
            <button
              className="button"
              onClick={() => onSubmit({ decision: 'decline' })}
            >
              Decline
            </button>
          </>
        ) : (
          <p>Open this session in Codex to respond to this request type.</p>
        )}
      </div>
    );
  }
  return (
    <div className="request">
      <b>Codex has questions</b>
      {qs.map((q) => (
        <label key={q.id}>
          {q.question}
          {q.options?.length > 0 && (
            <select onChange={(e) => A({ ...answers, [q.id]: e.target.value })}>
              <option value="">Choose an answer</option>
              {q.options.map((o) => (
                <option key={o.label}>{o.label}</option>
              ))}
            </select>
          )}
          <input
            placeholder="Or type an answer"
            value={answers[q.id] || ''}
            onChange={(e) => A({ ...answers, [q.id]: e.target.value })}
          />
        </label>
      ))}
      <button
        className="button primary"
        disabled={qs.some((q) => !answers[q.id])}
        onClick={() =>
          onSubmit({
            answers: Object.fromEntries(
              qs.map((q) => [q.id, { answers: [answers[q.id]] }]),
            ),
          })
        }
      >
        Submit answers
      </button>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
