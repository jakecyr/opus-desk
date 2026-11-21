import { useEffect, useState } from 'react';
import {
  Archive,
  ChevronRight,
  FolderGit2,
  Plus,
  Search,
  Send,
  Settings2,
  Square,
} from 'lucide-react';
import { ModelPicker, ReasoningPicker } from './ModelPicker.jsx';
import { groupSessions } from './session-groups.js';
import './orchestrator.css';

export function SessionNavigator({
  api,
  sessions,
  loaded,
  projects,
  worktrees,
  chat,
  select,
  requests,
  collapsed,
  setCollapsed,
  view,
  setView,
  openNew,
  age,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searchCollapsed, setSearchCollapsed] = useState({});
  const [sort, setSort] = useState(
    () => localStorage.getItem('opusdesk-session-sort') || 'recent-desc',
  );
  const term = query.trim();
  const searchKey = term && view + '\n' + term;
  const searching = !!term && results?.key !== searchKey;
  const current = term
    ? results?.key === searchKey
      ? results.data
      : []
    : sessions.filter(
        (session) =>
          view === 'all' || Boolean(session.archived) === (view === 'archived'),
      );
  const groupState = term ? searchCollapsed : collapsed;
  const setGroupState = term ? setSearchCollapsed : setCollapsed;
  const groups = groupSessions(current, projects, worktrees, sort);
  const allClosed =
    groups.length > 0 && groups.every(({ key }) => groupState[key]);

  useEffect(() => {
    if (!term) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ q: term });
      if (view !== 'active')
        params.set('archived', view === 'archived' ? 'true' : 'all');
      const result = await api('/sessions?' + params, {
        signal: abort.signal,
      }).catch((error) => ({
        data: [],
        errors: [error.message],
      }));
      if (!abort.signal.aborted) setResults({ ...result, key: searchKey });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [api, searchKey, term, view, sessions]);

  return (
    <section className="panel session-list" aria-label="Chat history">
      <div className="session-toolbar">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search chats"
            placeholder="Search chats and messages"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchCollapsed({});
              setResults(null);
            }}
          />
        </label>
        <div className="session-toolbar-options">
          <select
            className="session-filter"
            aria-label="Chat visibility"
            value={view}
            onChange={(e) => setView(e.target.value)}
          >
            <option value="all">All chats</option>
            <option value="active">Unarchived</option>
            <option value="archived">Archived</option>
          </select>
          <select
            className="session-filter"
            aria-label="Sort chats"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              localStorage.setItem('opusdesk-session-sort', e.target.value);
            }}
          >
            <option value="recent-desc">Newest first</option>
            <option value="recent-asc">Oldest first</option>
            <option value="alpha-asc">Name A–Z</option>
            <option value="alpha-desc">Name Z–A</option>
          </select>
          {groups.length > 1 && (
            <button
              className="text-btn"
              onClick={() =>
                setGroupState((prev) => ({
                  ...prev,
                  ...Object.fromEntries(
                    groups.map(({ key }) => [key, !allClosed]),
                  ),
                }))
              }
            >
              {allClosed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
        </div>
      </div>
      <div className="session-scroll" aria-busy={searching || !loaded}>
        {term && results?.key === searchKey && results.errors?.length > 0 && (
          <p className="chat-list-status" role="status">
            Some chat history could not be searched.
          </p>
        )}
        {!groups.length && (
          <p className="chat-list-status" role="status">
            {searching
              ? 'Searching chats…'
              : !loaded
                ? 'Loading chats…'
                : 'No chats found.'}
          </p>
        )}
        {groups.map(({ key, name, project, items }) => (
          <section className="session-group" key={key} aria-label={name}>
            <div className="session-group-head">
              <button
                className="group-title"
                aria-expanded={!groupState[key]}
                title={key || name}
                onClick={() =>
                  setGroupState((prev) => ({ ...prev, [key]: !prev[key] }))
                }
              >
                <ChevronRight
                  className={
                    'group-chevron' + (groupState[key] ? '' : ' expanded')
                  }
                  size={13}
                />
                <FolderGit2 size={13} />
                <span className="group-name">{name}</span>
                <span>{items.length}</span>
              </button>
              {key && (
                <button
                  className="icon-btn new-group-chat"
                  title={`New chat in ${name}`}
                  aria-label={`New chat in ${name}`}
                  onClick={() =>
                    openNew(project ? { project } : { folder: key })
                  }
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            {!groupState[key] &&
              items.map((session) => {
                const claude =
                  session.agent === 'claude' ||
                  session.id.startsWith('claude:');
                const waiting =
                  requests.some(
                    (request) => request.params?.threadId === session.id,
                  ) || session.status?.activeFlags?.length;
                const state = waiting
                  ? ['waiting', 'Needs input']
                  : session.status?.type === 'active'
                    ? ['running', 'Running']
                    : session.status?.type === 'systemError'
                      ? ['error', 'Error']
                      : null;
                return (
                  <button
                    key={session.id}
                    className={
                      'session-row' + (chat === session.id ? ' chosen' : '')
                    }
                    aria-current={chat === session.id ? 'true' : undefined}
                    onClick={() => select(session.id)}
                  >
                    <span
                      className={'agent-icon ' + (claude ? 'claude' : 'codex')}
                      aria-label={claude ? 'Claude Code' : 'Codex'}
                      title={claude ? 'Claude Code' : 'Codex'}
                    >
                      {claude ? '✳' : '✣'}
                    </span>
                    <div className="row-main">
                      <strong>
                        {session.name || session.preview || 'Untitled chat'}
                      </strong>
                      {(state || session.archived) && (
                        <div className="row-meta">
                          {state && (
                            <>
                              <span
                                className={'session-status ' + state[0]}
                                aria-hidden="true"
                              />
                              {state[1]}
                            </>
                          )}
                          {session.archived && 'Archived'}
                        </div>
                      )}
                    </div>
                    <span className="row-time">
                      {age(session.recencyAt || session.updatedAt)}
                    </span>
                  </button>
                );
              })}
          </section>
        ))}
      </div>
    </section>
  );
}

export function ChatControls({
  active,
  agent,
  options,
  models,
  loading,
  stop,
  save,
  archive,
}) {
  const [editing, setEditing] = useState(null);
  return (
    <div className="chat-controls">
      {active && (
        <button
          type="button"
          className="button"
          onClick={stop}
          disabled={loading}
        >
          <Square size={12} /> Stop
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label="Chat model and reasoning"
        title={
          [options?.model, options?.effort].filter(Boolean).join(' · ') ||
          'Chat model and reasoning'
        }
        aria-expanded={!!editing}
        disabled={!options}
        onClick={() => setEditing((value) => (value ? null : options))}
      >
        <Settings2 size={17} />
      </button>
      {archive && !active && (
        <button
          type="button"
          className="icon-btn"
          title="Archive chat"
          aria-label="Archive chat"
          onClick={archive}
          disabled={loading || !options}
        >
          <Archive size={16} />
        </button>
      )}
      {editing && (
        <form
          className="panel chat-model-options"
          aria-label="Chat model and reasoning"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await save(editing)) setEditing(null);
          }}
        >
          <ModelPicker
            agent={agent}
            models={models}
            value={editing.model}
            emptyLabel="Current default"
            onChange={(model) => setEditing({ ...editing, model, effort: '' })}
          />
          <ReasoningPicker
            agent={agent}
            models={models}
            model={editing.model}
            value={editing.effort}
            emptyLabel="Current default"
            onChange={(effort) => setEditing({ ...editing, effort })}
          />
          <button className="button primary" disabled={loading}>
            Save
          </button>
        </form>
      )}
    </div>
  );
}

export function ChatInput({ send, disabled, active, agent }) {
  const [text, setText] = useState('');
  const submitLabel = active
    ? agent === 'claude'
      ? 'Stop and send'
      : 'Steer'
    : 'Send';
  return (
    <form
      className="chat-input"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!disabled && text.trim() && (await send(text))) setText('');
      }}
    >
      <textarea
        aria-label="Chat message"
        disabled={disabled}
        placeholder={active ? 'Steer this chat…' : 'Write a message…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form.requestSubmit();
          }
        }}
      />
      <button
        className={'send' + (active ? ' send-steer' : '')}
        aria-label={submitLabel}
        title={submitLabel}
        disabled={disabled || !text.trim()}
      >
        {active ? submitLabel : <Send size={16} />}
      </button>
    </form>
  );
}
