import { useState } from 'react';
import { X, ArrowRight } from 'lucide-react';
import { ModelPicker, ReasoningPicker } from './ModelPicker.jsx';
export function SessionModal({
  modal,
  close,
  status,
  models,
  start,
  job,
  loading,
  bulkIssues,
  closeCleanup,
  commentIssue,
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
  const initialProject =
    modal.type === 'new' && modal.folder
      ? '__folder'
      : modal.project ||
        localProjects[0]?.path ||
        (modal.type === 'new' ? '__folder' : '');
  const [agent, Agent] = useState(defaultAgent),
    [project, Project] = useState(initialProject),
    [folder, Folder] = useState(modal.folder || ''),
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
    [outcome, Outcome] = useState('local changes only'),
    [worktree, Worktree] = useState(
      modal.type === 'bulk' ||
        !!status.settings.worktreePreferences?.[initialProject],
    ),
    [body, Body] = useState('');
  const customFolder = modal.type === 'new' && project === '__folder';
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
            {modal.type === 'new' && (
              <option value="__folder">Other folder…</option>
            )}
          </select>
        </label>
      )}
      {customFolder && (
        <label className="wide">
          Folder path
          <input
            value={folder}
            onChange={(e) => Folder(e.target.value)}
            placeholder="/path/to/folder"
          />
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
      {!customFolder && (
        <label className="worktree-check wide">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(e) => Worktree(e.target.checked)}
          />{' '}
          Use{' '}
          {modal.type === 'bulk' ? 'separate Git worktrees' : 'a Git worktree'}
        </label>
      )}
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
            <h2>New chat</h2>
            {fields}
            <button
              className="button primary modal-submit"
              disabled={loading || !project || (customFolder && !folder.trim())}
              onClick={() =>
                start({
                  agent,
                  model,
                  effort,
                  permission,
                  ...(customFolder
                    ? { folder: folder.trim() }
                    : { project, worktree }),
                })
              }
            >
              Start chat <ArrowRight size={15} />
            </button>
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
