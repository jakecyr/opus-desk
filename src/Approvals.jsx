import { useState, useEffect } from 'react';
import { X, MessagesSquare, ArrowUpRight } from 'lucide-react';
export function ApprovalBoard({ tasks = [], openChat, openPreview }) {
  if (!tasks.length) return null;
  return (
    <section className="panel approval-board">
      <div className="panel-head">
        <h2>
          Needs your approval{' '}
          <span className="count">
            {tasks.filter((t) => t.status === 'pending').length}
          </span>
        </h2>
      </div>
      {tasks.map((t) => (
        <div className="approval-row" key={t.key}>
          <div className="row-main">
            <a
              className="item-link"
              href={t.url}
              target="_blank"
              rel="noreferrer"
            >
              {t.title ||
                {
                  review: 'Preparing review',
                  describe: 'Writing description',
                  issue: 'Working on issue',
                  conflicts: 'Resolving conflicts',
                  comments: 'Addressing comments',
                  ci: 'Fixing CI',
                }[t.kind]}
            </a>
            <div className="row-meta">
              {t.url.replace('https://github.com/', '')} · {t.status}
            </div>
            {t.summary && (
              <small className="approval-summary">{t.summary}</small>
            )}
            {t.error && <small className="field-error">{t.error}</small>}
          </div>
          <button className="button small" onClick={() => openChat(t.id)}>
            <MessagesSquare size={13} /> Chat
          </button>
          {!['running', 'collecting', 'publishing'].includes(t.status) && (
            <button
              className="button small primary"
              onClick={() => openPreview(t.key)}
            >
              {t.status === 'pending' ? 'Review & publish' : 'View result'}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
export function ApprovalPreview({
  taskKey,
  api,
  post,
  close,
  onChanged,
  openChat,
}) {
  const [task, Task] = useState(null),
    [error, ErrorText] = useState(''),
    [busy, Busy] = useState(false),
    [published, Published] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api('/approvals/' + taskKey)
      .then((t) => {
        if (!cancelled) Task(t);
      })
      .catch((e) => ErrorText(e.message));
    return () => {
      cancelled = true;
    };
  }, [taskKey, api]);
  async function act(action) {
    Busy(true);
    ErrorText('');
    try {
      const result = await post('/approvals/' + taskKey + '/' + action);
      if (action === 'refresh') Task(result);
      else if (action === 'publish') Published(result);
      else close();
      onChanged();
    } catch (e) {
      ErrorText(e.message);
    } finally {
      Busy(false);
    }
  }
  return (
    <div className="scrim centered" onClick={close}>
      <section
        className="modal publication-preview"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="close" aria-label="Close preview" onClick={close}>
          <X size={18} />
        </button>
        <h2>
          {published ? 'Published to GitHub' : task?.title || 'Prepared work'}
        </h2>
        {error && <div className="error">{error}</div>}
        {task?.error && <p className="field-error">{task.error}</p>}
        {!task && !error && <p>Loading…</p>}
        {published ? (
          <a
            className="button primary"
            target="_blank"
            rel="noreferrer"
            href={published.url}
          >
            Open on GitHub <ArrowUpRight size={14} />
          </a>
        ) : (
          task && (
            <>
              <a
                className="text-btn"
                href={task.url}
                target="_blank"
                rel="noreferrer"
              >
                {task.url.replace('https://github.com/', '')} ↗
              </a>
              <p className="muted">
                {task.status === 'failed'
                  ? 'Open the chat to inspect the result. Refresh it here when the work is ready.'
                  : task.type === 'review'
                    ? 'Publishes this pending review as comments, without approving or requesting changes. The entire pending review below will be submitted, including any drafts you added.'
                    : task.type === 'description'
                      ? 'Updates the issue only if its description is still empty.'
                      : task.metadata
                        ? 'Pushes these commits and creates the PR shown below.'
                        : 'Pushes these local commits to the PR branch.'}
              </p>
              {task.summary && (
                <pre className="publication-text">{task.summary}</pre>
              )}
              {task.body && <pre className="publication-text">{task.body}</pre>}
              {task.comments?.map((c, i) => (
                <div className="draft-comment" key={i}>
                  <b>
                    {c.path}:{c.line}
                  </b>
                  <pre className="publication-text">{c.body}</pre>
                </div>
              ))}
              {task.metadata && (
                <>
                  <h3>{task.metadata.title}</h3>
                  <pre className="publication-text">{task.metadata.body}</pre>
                </>
              )}
              {task.diff && (
                <details open>
                  <summary>Code changes</summary>
                  <pre className="publication-diff">{task.diff}</pre>
                </details>
              )}
              {task.diffTruncated && (
                <p className="field-error">
                  This preview is truncated. Inspect the complete diff locally
                  before publishing.
                </p>
              )}
              <div className="publication-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => openChat(task.id)}
                >
                  Open chat
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => act('refresh')}
                >
                  Refresh result
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => act('dismiss')}
                >
                  Dismiss
                </button>
                <button
                  className="button primary"
                  disabled={busy || task.status !== 'pending'}
                  onClick={() => act('publish')}
                >
                  {busy ? 'Working…' : 'Publish to GitHub'}
                </button>
              </div>
            </>
          )
        )}
      </section>
    </div>
  );
}
