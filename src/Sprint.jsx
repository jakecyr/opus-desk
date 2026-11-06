import { useState, useEffect } from 'react';
import {
  CircleDot,
  MessageCircle,
  GitPullRequest,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
const repository = (item) =>
  item.repository?.nameWithOwner ||
  item.url?.split('/').slice(3, 5).join('/') ||
  '';
export function IssueLinks({ item }) {
  return (
    <>
      {item.needsReply && (
        <span
          className="tag warning"
          title="The latest human comment on an issue you own or are assigned to is from someone else"
        >
          Needs reply
        </span>
      )}
      {item.linkedPRs?.map((pr) => (
        <a
          className="issue-pr-link"
          key={pr.url}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={pr.title}
        >
          <GitPullRequest size={12} /> #{pr.number} · {pr.state.toLowerCase()}
        </a>
      ))}
    </>
  );
}
export function IssueActions({ item, onAddress, onDescribe, onComment }) {
  return (
    <div className="issue-actions">
      <button className="button small" onClick={() => onAddress(item)}>
        Address issue <ArrowRight size={12} />
      </button>
      {typeof item.body === 'string' && !item.body.trim() && (
        <button
          className="button small"
          title="Use an agent to write and save a description from the title, discussion, and code"
          onClick={() => onDescribe(item)}
        >
          <Sparkles size={12} /> Add description
        </button>
      )}
      <button className="button small" onClick={() => onComment(item)}>
        <MessageCircle size={12} /> Comment
      </button>
    </div>
  );
}
export function IssueRow({
  item,
  selected,
  onSelect,
  onAddress,
  onDescribe,
  onComment,
  age,
}) {
  return (
    <div className="pr-row issue-row">
      <input
        type="checkbox"
        aria-label={'Select ' + item.title}
        checked={selected}
        onChange={(e) => onSelect(e.target.checked)}
      />
      <div className="row-icon issue">
        <CircleDot size={17} />
      </div>
      <div className="row-main">
        <a
          className="item-link"
          href={item.url}
          target="_blank"
          rel="noreferrer"
        >
          {item.title}
        </a>
        <div className="row-meta">
          {repository(item)} #{item.number}
          <IssueLinks item={item} />
        </div>
      </div>
      <IssueActions
        item={item}
        onAddress={onAddress}
        onDescribe={onDescribe}
        onComment={onComment}
      />
      <span className="row-time">{age(item.updatedAt)}</span>
    </div>
  );
}

export function SprintSettings({ form, change, projects = [], api }) {
  const [repository, Repository] = useState(form.sprintRepo || ''),
    [linked, Linked] = useState([]),
    [loading, Loading] = useState(false),
    [error, ErrorText] = useState(''),
    [directory, Directory] = useState('');
  const valid = /^[-\w.]+\/[-\w.]+$/.test(repository);
  useEffect(() => {
    Directory(form.repoPaths?.[repository] || '');
  }, [repository, form.repoPaths]);
  useEffect(() => {
    Linked([]);
    ErrorText('');
    if (!valid) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      Loading(true);
      try {
        const r = await api(
          '/sprint/projects?repo=' + encodeURIComponent(repository),
        );
        if (!cancelled) Linked(r.projects);
      } catch (e) {
        if (!cancelled) ErrorText(e.message);
      } finally {
        if (!cancelled) Loading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      Loading(false);
    };
  }, [repository, valid, api]);
  function chooseRepo(value) {
    Repository(value);
    if (value === '' || /^[-\w.]+\/[-\w.]+$/.test(value))
      change({
        sprintRepo: value,
        sprintProjectId: '',
        sprintProjectTitle: '',
        sprintProjectUrl: '',
      });
  }
  function chooseProject(id) {
    const project = linked.find((p) => p.id === id);
    change({
      sprintProjectId: id,
      sprintProjectTitle: project?.title || '',
      sprintProjectUrl: project?.url || '',
    });
  }
  const currentMissing =
    form.sprintProjectId && !linked.some((p) => p.id === form.sprintProjectId);
  return (
    <section className="panel settings-card">
      <h2>Sprint</h2>
      <p className="muted">
        Choose a linked GitHub Project to enable the Sprint page.
      </p>
      <label>
        Repository
        <input
          list="sprint-repositories"
          value={repository}
          placeholder="owner/repository"
          onChange={(e) => chooseRepo(e.target.value.trim())}
        />
        <datalist id="sprint-repositories">
          {projects
            .filter((p) => p.repo)
            .map((p) => (
              <option key={p.path} value={p.repo} />
            ))}
        </datalist>
      </label>
      <label>
        GitHub Project
        <select
          value={form.sprintProjectId || ''}
          disabled={!valid || loading}
          onChange={(e) => chooseProject(e.target.value)}
        >
          <option value="">{loading ? 'Loading projects…' : 'Disabled'}</option>
          {currentMissing && (
            <option value={form.sprintProjectId}>
              {form.sprintProjectTitle || 'Selected project'}
            </option>
          )}
          {linked.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} (#{p.number})
            </option>
          ))}
        </select>
      </label>
      {error && <p className="field-error">{error}</p>}
      {valid && !loading && !linked.length && !error && (
        <small className="hint">
          No open projects linked to this repository.
        </small>
      )}
      {valid && (
        <>
          <label>
            Repository folder override
            <input
              value={directory}
              placeholder={
                projects.find(
                  (p) => p.repo?.toLowerCase() === repository.toLowerCase(),
                )?.path || '/absolute/path/to/repository'
              }
              onChange={(e) => {
                const value = e.target.value;
                Directory(value);
                if (value && !value.startsWith('/')) return;
                const paths = { ...form.repoPaths };
                delete paths[repository];
                if (value) paths[repository] = value;
                change({ repoPaths: paths });
              }}
              onBlur={() => {
                if (directory && !directory.startsWith('/')) {
                  ErrorText('Use an absolute repository folder path');
                  return;
                }
              }}
            />
          </label>
          <small className="hint">
            Optional. Its GitHub origin must match this repository. Other
            project repositories use the code root folder.
          </small>
        </>
      )}
    </section>
  );
}

const date = (value) =>
  new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
export function SprintPage({
  settings,
  api,
  revision,
  onAddress,
  onDescribe,
  onComment,
  onSettings,
}) {
  const [data, Data] = useState(null),
    [error, ErrorText] = useState(''),
    [mine, Mine] = useState(true),
    [query, Query] = useState(''),
    [iteration, Iteration] = useState(null),
    [reply, Reply] = useState(false);
  const configured = !!settings.sprintRepo && !!settings.sprintProjectId;
  useEffect(() => {
    if (!configured) return;
    let stopped = false,
      busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const r = await api('/sprint');
        if (!stopped) {
          Data(r);
          ErrorText('');
          Iteration(
            (old) =>
              old ??
              r.iterations.find(
                (i) =>
                  Date.parse(i.start) <= Date.now() &&
                  Date.parse(i.end) > Date.now(),
              )?.id ??
              'all',
          );
        }
      } catch (e) {
        if (!stopped) ErrorText(e.message);
      } finally {
        busy = false;
      }
    }
    load();
    const timer = setInterval(
      load,
      Math.max(30, settings.interval || 120) * 1000,
    );
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [
    configured,
    settings.sprintProjectId,
    settings.sprintRepo,
    settings.interval,
    api,
    revision,
  ]);
  if (!configured)
    return (
      <div className="panel settings-card">
        <h2>Sprint is not configured</h2>
        <button className="button" onClick={onSettings}>
          Choose a project in Settings
        </button>
      </div>
    );
  const selected = data?.iterations.find((i) => i.id === iteration),
    username = data?.username || '';
  const items = (data?.items || []).filter(
    (i) =>
      (!mine ||
        (username &&
          i.assignees.some(
            (a) => a.login.toLowerCase() === username.toLowerCase(),
          ))) &&
      (iteration === 'all' || i.iterationId === iteration) &&
      (!reply || i.needsReply) &&
      JSON.stringify(i).toLowerCase().includes(query.toLowerCase()),
  );
  const statuses = [
    ...new Set([...(data?.statuses || []), ...items.map((i) => i.status)]),
  ];
  return (
    <>
      <div className="compact-title">
        <h1>Sprint</h1>
        {data && (
          <a
            className="text-btn"
            href={data.project.url}
            target="_blank"
            rel="noreferrer"
          >
            {data.project.title} ↗
          </a>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="sprint-toolbar">
        <input
          type="search"
          aria-label="Search sprint tasks"
          placeholder="Search tasks, repositories, or people"
          value={query}
          onChange={(e) => Query(e.target.value)}
        />
        <label>
          Iteration
          <select
            value={iteration || 'all'}
            onChange={(e) => Iteration(e.target.value)}
          >
            <option value="all">All iterations</option>
            {data?.iterations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => Mine(e.target.checked)}
          />{' '}
          Assigned to me {username && '(' + username + ')'}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={reply}
            onChange={(e) => Reply(e.target.checked)}
          />{' '}
          Needs reply
        </label>
      </div>
      {mine && data && !username && (
        <p className="field-error">
          Couldn’t detect your username. Set it in Settings or uncheck Assigned
          to me.
        </p>
      )}
      {selected && (
        <section className="panel sprint-timeline">
          <div>
            <strong>{selected.title}</strong>
            <span>
              {date(selected.start)} – {date(selected.end)} ·{' '}
              {selected.duration} days
            </span>
            <b>
              {Date.parse(selected.start) > Date.now()
                ? 'Starts ' + date(selected.start)
                : selected.daysLeft
                  ? selected.daysLeft + ' days left'
                  : 'Ended'}
            </b>
          </div>
          <progress
            aria-label="Sprint progress"
            max={100}
            value={selected.progress}
          />
        </section>
      )}
      {!data && !error ? (
        <p className="muted">Loading sprint…</p>
      ) : (
        <div className="pr-board sprint-board">
          {statuses.map((status) => (
            <section className="pr-lane" key={status}>
              <div className="lane-heading">
                <b>{status}</b>
                <span>{items.filter((i) => i.status === status).length}</span>
              </div>
              <div className="lane-cards">
                {items
                  .filter((i) => i.status === status)
                  .map((i) => (
                    <article className="sprint-card panel" key={i.id}>
                      {i.url ? (
                        <a
                          className="item-link"
                          href={i.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {i.title}
                        </a>
                      ) : (
                        <strong>{i.title}</strong>
                      )}
                      <div className="row-meta">
                        {i.kind === 'draft'
                          ? 'Draft task'
                          : repository(i) + ' #' + i.number}
                        {i.assignees.length > 0 && (
                          <span>
                            {i.assignees.map((a) => '@' + a.login).join(', ')}
                          </span>
                        )}
                      </div>
                      <div className="issue-links">
                        <IssueLinks item={i} />
                      </div>
                      {i.kind === 'issue' && (
                        <IssueActions
                          item={i}
                          onAddress={onAddress}
                          onDescribe={onDescribe}
                          onComment={onComment}
                        />
                      )}
                    </article>
                  ))}
                {!items.some((i) => i.status === status) && (
                  <div className="lane-empty">No tasks</div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      {data?.truncated && (
        <p className="muted">Showing the first 1,000 project items.</p>
      )}
    </>
  );
}
