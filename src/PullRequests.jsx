import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CircleCheck,
  GitMerge,
  GitPullRequest,
  Link2,
  MessageCircle,
  MessagesSquare,
  Search,
  Sparkles,
} from 'lucide-react';
import { ApprovalBoard } from './Approvals.jsx';
import { isJobBusy, JobStatus } from './JobStatus.jsx';
import {
  hasConflict,
  hasFailedChecks,
  hasPreparedReview,
  hasUnaddressedComments,
  isMine,
  isOpen,
  isReadyToMerge,
  matchesPullFilter,
  needsFocus,
  pullFilters,
  pullQueues,
  pullUrl,
  pullUrlKey,
  queueForPull,
  wasReviewed,
} from './pull-queues.js';
import './pull-requests.css';

const repository = (pr) =>
  pr.repository?.nameWithOwner ||
  pr.url?.split('/').slice(3, 5).join('/') ||
  '';
const previewLabel = {
  review: 'Review & publish',
  ci: 'Preview CI fix',
  conflicts: 'Preview conflict resolution',
  comments: 'Preview comment fixes',
};

function PullRow({
  pr,
  job,
  linked,
  runJob,
  preview,
  confirmAction,
  age,
  chatLabel,
  inspected,
}) {
  const busy = isJobBusy(job);
  const pending = job?.pendingTasks || (job?.status === 'pending' ? [job] : []);
  const draftReview = hasPreparedReview(job);
  return (
    <article className="pr-row pull-row">
      <div className="row-icon">
        <GitPullRequest size={16} />
      </div>
      <div className="pull-main">
        <a className="item-link" href={pr.url} target="_blank" rel="noreferrer">
          {pr.title}
        </a>
        <div className="pull-meta row-meta">
          <span>
            {repository(pr)} #{pr.number}
          </span>
          {pr.author?.login && <span>@{pr.author.login}</span>}
          {pr.updatedAt && (
            <time dateTime={pr.updatedAt}>{age(pr.updatedAt)}</time>
          )}
        </div>
        <div className="pull-badges">
          {pr.isDraft && <span className="tag">Draft PR</span>}
          {!isOpen(pr) && (
            <span className="tag">
              {pr.state === 'MERGED' ? 'Merged' : 'Closed'}
            </span>
          )}
          {pr.pendingReview && <span className="tag">Draft comments</span>}
          {pr.pendingResponse && (
            <span className="tag warning">Needs your response</span>
          )}
          {isMine(pr) && hasUnaddressedComments(pr) && (
            <span className="tag warning">
              {pr.unaddressedComments > 0
                ? pr.unaddressedComments + ' unresolved'
                : 'Unresolved comments'}
            </span>
          )}
          {hasConflict(pr) && <span className="tag warning">Conflicts</span>}
          {hasFailedChecks(pr) && (
            <span
              className="tag warning"
              title={pr.failedChecks?.join('\n') || undefined}
            >
              {pr.failedChecks?.length
                ? `${pr.failedChecks.length} checks failing`
                : 'Checks failing'}
            </span>
          )}
          {isReadyToMerge(pr) && (
            <span className="tag green">Ready to merge</span>
          )}
        </div>
      </div>
      <div className="inline-actions pull-actions">
        <JobStatus job={job} linked={linked} chatLabel={chatLabel} />
        {pending
          .filter((task) => task.key)
          .map((task) => (
            <button
              key={task.key}
              className="button small primary"
              onClick={() => preview(task.key)}
            >
              {previewLabel[task.kind] || 'Preview changes'}
            </button>
          ))}
        {isOpen(pr) && (
          <>
            {pr.pendingReview && !draftReview && (
              <button
                className="button small primary"
                disabled={busy || !pr.headRefOid}
                onClick={() => confirmAction({ kind: 'submit-review', pr })}
              >
                Submit review
              </button>
            )}
            {inspected && !pr.isDraft && !pr.pendingReview && !draftReview && (
              <button
                className="inline-action"
                disabled={busy || !pr.headRefOid}
                onClick={() =>
                  confirmAction({
                    kind: 'submit-review',
                    pr,
                    writeReview: true,
                  })
                }
              >
                <MessageCircle size={14} /> Write review
              </button>
            )}
            {hasConflict(pr) && (
              <button
                className="inline-action"
                disabled={busy}
                onClick={() => runJob(pr.url, 'conflicts')}
              >
                <GitMerge size={14} /> Resolve conflicts
              </button>
            )}
            {hasFailedChecks(pr) && (
              <button
                className="inline-action"
                disabled={busy}
                onClick={() => runJob(pr.url, 'ci')}
              >
                <CircleCheck size={14} /> Fix CI
              </button>
            )}
            {isMine(pr) && hasUnaddressedComments(pr) && (
              <button
                className="inline-action"
                disabled={busy}
                onClick={() => runJob(pr.url, 'comments')}
              >
                <MessageCircle size={14} /> Address comments
              </button>
            )}
            {isReadyToMerge(pr) && (
              <button
                className="inline-action"
                disabled={busy || !pr.headRefOid}
                onClick={() => confirmAction({ kind: 'merge', pr })}
              >
                <GitMerge size={14} /> Merge
              </button>
            )}
            {!pr.pendingReview && !draftReview && (
              <button
                className="inline-action"
                disabled={busy}
                onClick={() =>
                  runJob(
                    pr.url,
                    'review',
                    undefined,
                    wasReviewed(pr) ? { rereview: true } : {},
                  )
                }
              >
                <Sparkles size={14} />{' '}
                {wasReviewed(pr) ? 'Re-review' : 'Review'}
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function PullList({ pulls, jobs, links, ...actions }) {
  return pulls.map((pr) => {
    const key = pullUrlKey(pr.url);
    return (
      <PullRow
        key={key}
        pr={pr}
        linked={links.get(key) || pr.linkedChat}
        job={jobs.get(key)}
        {...actions}
      />
    );
  });
}

export function FocusPage({
  data,
  jobs,
  approvals,
  showPulls,
  showIssues,
  openChat,
  ...actions
}) {
  const active = data.prs.filter((pr) =>
    needsFocus(pr, jobs.get(pullUrlKey(pr.url))),
  );
  const pending = approvals.filter((job) => job.status === 'pending');
  const issues = data.issues.filter((issue) => isOpen(issue));
  const hasFocus = active.length || pending.length || issues.length;
  return (
    <div className="focus-page">
      <header className="queue-page-head">
        <h1>Focus</h1>
        <div className="queue-sync">
          <span className="pulse" />
          {data.updated
            ? 'Synced ' + actions.age(data.updated)
            : 'Syncing GitHub…'}
        </div>
      </header>
      <ApprovalBoard
        tasks={pending}
        openChat={openChat}
        openPreview={actions.preview}
      />
      {!!active.length && (
        <section className="panel queue-group" aria-labelledby="focus-pulls">
          <header className="queue-section-head">
            <h2 id="focus-pulls">
              Actionable pull requests{' '}
              <span className="count">{active.length}</span>
            </h2>
            <button className="text-btn" onClick={showPulls}>
              Pull requests <ArrowRight size={14} />
            </button>
          </header>
          <PullList pulls={active} jobs={jobs} {...actions} />
        </section>
      )}
      {!!issues.length && (
        <section className="panel queue-group" aria-labelledby="focus-issues">
          <header className="queue-section-head">
            <h2 id="focus-issues">
              Assigned issues <span className="count">{issues.length}</span>
            </h2>
            <button className="text-btn" onClick={showIssues}>
              Issues <ArrowRight size={14} />
            </button>
          </header>
          {issues.map((issue) => (
            <article className="focus-issue" key={issue.url}>
              <a
                className="item-link"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
              >
                {issue.title}
              </a>
              <span className="row-meta">
                {repository(issue)} #{issue.number}
              </span>
              {issue.needsReply && (
                <span className="tag warning">Needs your response</span>
              )}
            </article>
          ))}
        </section>
      )}
      {!hasFocus && (
        <div className="panel queue-empty" role="status">
          <CircleCheck size={27} />
          <strong>
            {data.updated && !data.errors?.length
              ? 'Nothing needs your attention.'
              : 'Waiting for GitHub'}
          </strong>
        </div>
      )}
    </div>
  );
}

export function PullRequestPage({
  pulls,
  jobs,
  links,
  overrides,
  api,
  post,
  onTrack,
  ...actions
}) {
  const [query, setQuery] = useState('');
  const [queue, setQueue] = useState('all');
  const [filter, setFilter] = useState('all');
  const [closed, setClosed] = useState(null);
  const [closedBusy, setClosedBusy] = useState(false);
  const [closedError, setClosedError] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [url, setUrl] = useState('');
  const [lookup, setLookup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const target = pullUrl(url.trim());
  const key = target.toLowerCase();
  const inspected =
    lookup?.key === key
      ? pulls.find((pr) => pullUrlKey(pr.url) === key) ||
        overrides[key] ||
        lookup.pr
      : null;
  const inspectedChat =
    links.get(key) || inspected?.linkedChat || (inspected && lookup.chat);
  const matching = new Map(pullQueues.map(([id]) => [id, []]));
  const tokens = query.toLowerCase().trim().split(/\s+/);
  const seen = new Set();
  const closedPulls = includeClosed
    ? [
        ...Object.values(overrides).filter((pr) => !isOpen(pr)),
        ...(closed?.items || []),
      ]
    : [];
  for (const pr of [...pulls, ...closedPulls]) {
    const prKey = pullUrlKey(pr.url);
    if (!prKey || seen.has(prKey) || (inspected && prKey === key)) continue;
    if (!includeClosed && !isOpen(pr)) continue;
    const text =
      `${repository(pr)} #${pr.number} ${pr.title} ${pr.author?.login || ''}`.toLowerCase();
    if (!tokens.every((token) => text.includes(token))) continue;
    const job = jobs.get(prKey);
    if (matchesPullFilter(pr, filter, job)) {
      matching.get(queueForPull(pr, job)).push(pr);
      seen.add(prKey);
    }
  }
  const count = [...matching.values()].reduce(
    (total, items) => total + items.length,
    0,
  );
  const shown = pullQueues.filter(
    ([id]) => (queue === 'all' || queue === id) && matching.get(id).length > 0,
  );

  async function inspect(event) {
    event.preventDefault();
    setError('');
    if (!key) {
      setError('Enter a pull request URL.');
      return;
    }
    setBusy(true);
    try {
      const pr = await post('/github/track', { url: target });
      const canonical = pullUrlKey(pr.url);
      onTrack(pr);
      setLookup({ key: canonical, pr });
      if (!links.get(canonical) && !pr.linkedChat) {
        void api('/sessions?reference=' + encodeURIComponent(pr.url))
          .then((result) => {
            const chat = result?.data?.[0]?.id;
            if (chat)
              setLookup((current) =>
                current?.key === canonical ? { ...current, chat } : current,
              );
          })
          .catch(() => {});
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleClosed(checked) {
    setIncludeClosed(checked);
    if (!checked) {
      if (queue === 'closed') setQueue('all');
      return;
    }
    if (closed) return;
    setClosedBusy(true);
    setClosedError('');
    try {
      setClosed(await api('/github/closed'));
    } catch (error) {
      setClosedError(error.message);
      setIncludeClosed(false);
    } finally {
      setClosedBusy(false);
    }
  }

  return (
    <div className="pull-page">
      <header className="queue-page-head">
        <h1>Pull requests</h1>
      </header>
      <section className="panel pull-lookup" aria-label="Open a pull request">
        <form onSubmit={inspect}>
          <label className="search">
            <Link2 size={17} />
            <input
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError('');
              }}
              placeholder="Paste a pull request URL"
              aria-label="Pull request URL"
              disabled={busy}
              required
            />
          </label>
          <button className="button primary" disabled={busy} type="submit">
            {busy ? 'Opening…' : 'Open PR'}
          </button>
          {inspectedChat && !inspected && (
            <a
              className="button"
              href={'/sessions/' + encodeURIComponent(inspectedChat)}
            >
              <MessagesSquare size={15} /> Open in Orchestrator
            </a>
          )}
        </form>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {inspected && (
          <PullRow
            pr={inspected}
            linked={inspectedChat}
            job={jobs.get(key)}
            chatLabel="Open in Orchestrator"
            inspected
            {...actions}
          />
        )}
      </section>
      <div className="pull-tabs" aria-label="Pull request queues" role="group">
        {[
          ['all', 'All', count],
          ...pullQueues
            .filter(([id]) =>
              id === 'closed'
                ? includeClosed
                : id !== 'other' || queue === id || matching.get(id).length,
            )
            .map(([id, label]) => [id, label, matching.get(id).length]),
        ].map(([id, label, total]) => (
          <button
            key={id}
            aria-pressed={queue === id}
            onClick={() => setQueue(id)}
          >
            {label} <span>{total}</span>
          </button>
        ))}
      </div>
      <div className="pull-filter-bar">
        <label className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search pull requests"
            placeholder="Search pull requests"
          />
        </label>
        <select
          aria-label="Filter by status"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All statuses</option>
          {pullFilters.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <label className="pull-closed-toggle">
          <input
            type="checkbox"
            checked={includeClosed}
            disabled={closedBusy}
            onChange={(event) => toggleClosed(event.target.checked)}
          />{' '}
          Include closed PRs
        </label>
      </div>
      {closedError && (
        <p className="field-error" role="alert">
          {closedError}
        </p>
      )}
      {includeClosed && closed?.limitReached && (
        <p className="muted">
          Showing the 1,000 most recently updated closed PRs.
        </p>
      )}
      {shown.map(([id, label]) => (
        <section
          className="panel queue-group"
          key={id}
          aria-labelledby={'queue-' + id}
        >
          <header className="queue-section-head">
            <h2 id={'queue-' + id}>{label}</h2>
          </header>
          <PullList
            pulls={matching.get(id)}
            jobs={jobs}
            links={links}
            {...actions}
          />
        </section>
      ))}
      {!shown.length && (
        <div className="panel queue-empty" role="status">
          <GitPullRequest size={24} />
          <strong>No pull requests match.</strong>
        </div>
      )}
    </div>
  );
}

export function PullActionDialog({ action, close, post, onChanged }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    ref.current.showModal();
  }, []);
  const [body, setBody] = useState('');
  const { kind, pr, writeReview } = action;
  const merge = kind === 'merge';
  const title = merge ? 'Merge pull request' : 'Submit review';
  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await post('/github/' + kind, {
        url: pr.url,
        headRefOid: pr.headRefOid,
        ...(writeReview ? { body: body.trim() } : {}),
      });
      onChanged(action, result);
      close();
    } catch (error) {
      setError(error.message);
      setBusy(false);
    }
  }
  return (
    <dialog
      className="modal pull-action-dialog"
      ref={ref}
      aria-labelledby="pull-action-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <h2 id="pull-action-title">{title}</h2>
        <p>
          <strong>
            {repository(pr)} #{pr.number}
          </strong>{' '}
          {pr.title}
        </p>
        {writeReview ? (
          <label className="pull-review-body">
            <span>Review feedback</span>
            <textarea
              required
              maxLength={10000}
              rows={5}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
        ) : (
          <p className="muted">
            {merge
              ? 'Merge this pull request on GitHub?'
              : 'Publish your pending review comments on GitHub?'}
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="pull-dialog-actions">
          <button
            className="button"
            type="button"
            onClick={close}
            disabled={busy}
            autoFocus
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || (writeReview && !body.trim())}
          >
            {busy ? 'Working…' : title}
          </button>
        </div>
      </form>
    </dialog>
  );
}
