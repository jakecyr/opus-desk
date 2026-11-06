import { useState, useEffect } from 'react';
import { X, ArrowRight, MessagesSquare } from 'lucide-react';
import { ModelPicker, ReasoningPicker } from './ModelPicker.jsx';
const canonical = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' &&
      u.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(u.pathname)
      ? u.origin + u.pathname.replace(/\/$/, '')
      : '';
  } catch {
    return '';
  }
};
export function SessionModal({
  modal,
  close,
  status,
  models,
  prs,
  start,
  job,
  loading,
  openChat,
  bulkIssues,
  closeCleanup,
  commentIssue,
  api,
}) {
  const kind =
    modal.type === 'describe'
      ? 'describe'
      : modal.type === 'issue' || modal.type === 'bulk'
        ? 'issue'
        : modal.type;
  const config = status.settings.workflows?.[kind] || {};
  const defaultAgent = config.agent || status.settings.defaultAgent || 'codex';
  const target = modal.item?.url?.split('/').slice(3, 5).join('/');
  const localProjects =
    modal.type === 'new'
      ? status.projects
      : status.projects.filter(
          (p) => p.repo?.toLowerCase() === target?.toLowerCase(),
        );
  const initialProject = localProjects[0]?.path || '';
  const [agent, Agent] = useState(defaultAgent),
    [project, Project] = useState(initialProject),
    [model, Model] = useState(
      config.model ||
        (defaultAgent === 'claude'
          ? status.settings.claudeModel
          : status.settings.codexModel) ||
        '',
    ),
    [effort, Effort] = useState(config.effort || status.settings.effort || ''),
    [permission, Permission] = useState(
      config.permission || status.settings.permission || 'danger',
    ),
    [url, Url] = useState(''),
    [outcome, Outcome] = useState('local changes only'),
    [worktree, Worktree] = useState(
      modal.type === 'bulk' ||
        !!status.settings.worktreePreferences?.[initialProject],
    ),
    [body, Body] = useState(''),
    [reviewState, ReviewState] = useState(null);
  const normalized = canonical(url.trim());
  useEffect(() => {
    ReviewState(null);
    if (modal.type !== 'review' || !normalized) return;
    let cancelled = false;
    const timer = setTimeout(
      () =>
        api('/github/review-state?url=' + encodeURIComponent(normalized))
          .then((x) => {
            if (!cancelled) ReviewState(x);
          })
          .catch(() => {}),
      300,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [normalized, modal.type, api]);
  const rereview =
    reviewState?.reviewedByMe ||
    prs?.some(
      (p) =>
        p.url.toLowerCase() === normalized.toLowerCase() &&
        (p.reviewedByMe || p.roles?.includes('reviewed')),
    );
  const linked = Object.entries(status.links || {}).find(
    ([key]) => key.toLowerCase() === normalized.toLowerCase(),
  )?.[1];
  const options = {
    agent,
    model,
    effort,
    permission,
    isolated: worktree,
    forceNew: true,
    ...(modal.type !== 'bulk' ? { project } : {}),
  };
  const fields = (
    <div className="form-grid">
      <label>
        Agent
        <select
          value={agent}
          onChange={(e) => {
            Agent(e.target.value);
            Model(
              (e.target.value === 'claude'
                ? status.settings.claudeModel
                : status.settings.codexModel) || '',
            );
            Effort('');
          }}
        >
          <option value="codex">
            Codex {status.available.codex ? '' : '(not found)'}
          </option>
          <option value="claude" disabled={!status.available.claude}>
            Claude Code {status.available.claude ? '' : '(not found)'}
          </option>
        </select>
      </label>
      {modal.type !== 'bulk' && (
        <label>
          Project
          <select
            value={project}
            onChange={(e) => {
              Project(e.target.value);
              Worktree(!!status.settings.worktreePreferences?.[e.target.value]);
            }}
          >
            {!project && <option value="">No matching local checkout</option>}
            {localProjects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ModelPicker
        key={agent}
        agent={agent}
        value={model}
        onChange={Model}
        models={models}
      />
      <ReasoningPicker
        agent={agent}
        model={model}
        models={models}
        value={effort}
        onChange={Effort}
      />
      <label className="wide">
        Permissions
        <select value={permission} onChange={(e) => Permission(e.target.value)}>
          <option value="sandbox">
            {agent === 'claude'
              ? 'CLI default permissions (noninteractive)'
              : 'Sandbox · ask for approval'}
          </option>
          <option value="danger">
            Dangerous · full access without approval
          </option>
        </select>
      </label>
      <label className="worktree-check wide">
        <input
          type="checkbox"
          checked={worktree}
          onChange={(e) => Worktree(e.target.checked)}
        />{' '}
        Use{' '}
        {modal.type === 'bulk' ? 'separate Git worktrees' : 'a Git worktree'}
      </label>
    </div>
  );
  return (
    <div className="scrim centered" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={close} aria-label="Close dialog">
          <X size={18} />
        </button>
        {modal.type === 'new' ? (
          <>
            <h2>Start a session</h2>
            {fields}
            <button
              className="button primary modal-submit"
              disabled={!project || loading}
              onClick={() =>
                start({ agent, project, model, effort, permission, worktree })
              }
            >
              Start session <ArrowRight size={15} />
            </button>
          </>
        ) : modal.type === 'review' ? (
          <>
            <h2>{rereview ? 'Re-review a PR' : 'Review a PR'}</h2>
            <label>
              Pull request URL
              <input
                value={url}
                onChange={(e) => Url(e.target.value)}
                placeholder="https://github.com/owner/repo/pull/123"
              />
            </label>
            {linked && (
              <div className="linked-chat">
                <MessagesSquare size={16} />
                <span>Linked session found</span>
                <button className="text-btn" onClick={() => openChat(linked)}>
                  Open chat <ArrowRight size={14} />
                </button>
              </div>
            )}
            <p className="muted">
              {linked
                ? 'Continue in the linked session or start a separate review.'
                : 'Starts in the matching local repository. Comments stay in a draft until you publish.'}
            </p>
            <button
              className="button primary modal-submit"
              disabled={!normalized || loading}
              onClick={() => job(normalized, 'review')}
            >
              {rereview ? 'Re-review' : 'Review'}
              {linked ? ' in linked session' : ''} <ArrowRight size={15} />
            </button>
            {linked && (
              <button
                className="button modal-submit"
                disabled={loading}
                onClick={() =>
                  job(normalized, 'review', undefined, { forceNew: true })
                }
              >
                Start a new review
              </button>
            )}
          </>
        ) : modal.type === 'cleanup' ? (
          <>
            <h2>
              Close {modal.urls.length}{' '}
              {modal.urls.length === 1 ? 'item' : 'items'}?
            </h2>
            <p className="muted">
              These PRs and issues will be closed on GitHub.
            </p>
            <div className="confirm-list">
              {modal.urls.map((url) => (
                <div key={url}>{url.replace('https://github.com/', '')}</div>
              ))}
            </div>
            <button
              className="button danger-button modal-submit"
              disabled={loading}
              onClick={() => closeCleanup(modal.urls)}
            >
              Close on GitHub
            </button>
          </>
        ) : modal.type === 'comment' ? (
          <>
            <h2>Comment on #{modal.item.number}</h2>
            <p className="muted">{modal.item.title}</p>
            <label>
              Comment
              <textarea
                rows={6}
                maxLength={10000}
                value={body}
                onChange={(e) => Body(e.target.value)}
                autoFocus
              />
            </label>
            <button
              className="button primary modal-submit"
              disabled={!body.trim() || loading}
              onClick={() => commentIssue(modal.item, body)}
            >
              Post comment on GitHub
            </button>
          </>
        ) : (
          <>
            <h2>
              {modal.type === 'bulk'
                ? 'Address ' + modal.urls.length + ' issues'
                : modal.type === 'describe'
                  ? 'Write issue description'
                  : 'Address issue'}
            </h2>
            {modal.item && <p className="muted">{modal.item.title}</p>}
            {fields}
            {modal.type !== 'describe' && (
              <label>
                Outcome
                <select
                  value={outcome}
                  onChange={(e) => Outcome(e.target.value)}
                >
                  <option>local changes only</option>
                  <option>implement and commit</option>
                  <option>implement, commit and push</option>
                  <option>
                    implement, commit, push and create a pull request
                  </option>
                </select>
              </label>
            )}
            <p className="muted">
              {modal.type === 'bulk' && !worktree
                ? 'Parallel agents in the same project share files. Use worktrees to keep changes separate.'
                : modal.type === 'describe'
                  ? 'The agent will prepare a description for your approval.'
                  : 'Worktrees start at committed HEAD. Publishing requires your approval.'}
            </p>
            <button
              className="button primary modal-submit"
              disabled={loading || (modal.type !== 'bulk' && !project)}
              onClick={() =>
                modal.type === 'bulk'
                  ? bulkIssues(modal.urls, outcome, options)
                  : job(modal.item.url, kind, outcome, options)
              }
            >
              {modal.type === 'bulk'
                ? 'Start parallel sessions'
                : modal.type === 'describe'
                  ? 'Generate description'
                  : 'Start session'}{' '}
              <ArrowRight size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
