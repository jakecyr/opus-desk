import { useState, useEffect, useRef } from 'react';
import { ModelPicker, ReasoningPicker } from './ModelPicker.jsx';
import { createAutosave } from './autosave.js';
import { SprintSettings } from './Sprint.jsx';

const toneHelp = {
  constructive: 'Calm and practical: explain the impact and suggest a fix.',
  direct:
    'Straight to the point: state the problem and the smallest useful fix.',
  supportive:
    'Friendly and respectful: clearly explain problems without softening what needs fixing.',
};
const scopeHelp = {
  blocking:
    'Bugs, security risks, breaking changes, and serious design problems that should be fixed before merging.',
  balanced:
    'Everything in important fixes, plus actionable improvements to simplicity and maintainability. Cosmetic nits are skipped.',
  thorough:
    'Everything in the other two levels, plus a few useful, clearly optional nits. Avoids flooding the PR with minor comments.',
};
export function SettingsPage({
  settings,
  available,
  models,
  status,
  api,
  save,
}) {
  const [form, Form] = useState(settings),
    [saving, Saving] = useState('saved'),
    [error, ErrorText] = useState('');
  const saveRef = useRef(save);
  saveRef.current = save;
  const active = useRef(true),
    queue = useRef(null);
  if (!queue.current)
    queue.current = createAutosave(
      (patch) => saveRef.current(patch),
      (state, message) => {
        if (active.current) {
          Saving(state);
          ErrorText(message || '');
        }
      },
    );
  useEffect(() => {
    if (!queue.current.dirty) Form(settings);
  }, [settings]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      queue.current.dispose();
    };
  }, []);
  const change = (patch) => {
    Form((old) => ({ ...old, ...patch }));
    queue.current.change(patch);
  };
  const set = (key, value) => change({ [key]: value });
  const agent = form.defaultAgent || 'codex',
    modelKey = agent === 'claude' ? 'claudeModel' : 'codexModel';
  return (
    <>
      <div className="compact-title">
        <h1>Settings</h1>
        <span
          className={
            'autosave-status ' + (saving === 'error' ? 'save-error' : '')
          }
          role="status"
        >
          {saving === 'pending' || saving === 'saving' ? (
            'Saving…'
          ) : saving === 'error' ? (
            <>
              Couldn’t save{' '}
              <button
                className="text-btn"
                onClick={() => queue.current.flush()}
              >
                Retry
              </button>
            </>
          ) : (
            'Saved automatically'
          )}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="settings-grid">
        <section className="panel settings-card">
          <h2>Local tools</h2>
          {[
            ['GitHub CLI', 'gh'],
            ['Codex CLI', 'codex'],
            ['Claude Code', 'claude'],
          ].map(([name, id]) => (
            <div className="setting-line" key={id}>
              <div>
                <b>{name}</b>
                <small>
                  {id === 'gh'
                    ? 'Existing gh authentication'
                    : id === 'claude'
                      ? 'Local CLI · noninteractive turns'
                      : 'Existing Codex sign-in'}
                </small>
              </div>
              <span className={'tag ' + (available[id] ? 'green' : '')}>
                {available[id] ? 'Detected' : 'Not found'}
              </span>
            </div>
          ))}
        </section>
        <section className="panel settings-card">
          <h2>Workspace defaults</h2>
          <label>
            Code root folder
            <input
              value={form.root || ''}
              onChange={(e) => set('root', e.target.value)}
            />
          </label>
          <small className="hint">
            Git repositories in immediate subfolders are discovered
            automatically.
          </small>
          <label>
            GitHub username
            <input
              value={form.githubUsername || ''}
              placeholder={status.detectedUsername || 'Detected from gh'}
              onChange={(e) => set('githubUsername', e.target.value)}
            />
          </label>
          <small className="hint">
            Leave blank to use{' '}
            {status.detectedUsername || 'the account signed into gh'}.
          </small>
          <label>
            GitHub refresh interval
            <select
              value={form.interval || 120}
              onChange={(e) => set('interval', Number(e.target.value))}
            >
              <option value={60}>Every minute</option>
              <option value={120}>Every 2 minutes</option>
              <option value={300}>Every 5 minutes</option>
            </select>
          </label>
          <label>
            Default agent
            <select
              value={agent}
              onChange={(e) => set('defaultAgent', e.target.value)}
            >
              <option value="codex">Codex</option>
              <option value="claude" disabled={!available.claude}>
                Claude Code {available.claude ? '' : '(not found)'}
              </option>
            </select>
          </label>
          <ModelPicker
            key={agent}
            agent={agent}
            value={form[modelKey] || ''}
            onChange={(v) => set(modelKey, v)}
            models={models}
            label="Default model"
          />
          <ReasoningPicker
            agent={agent}
            model={form[modelKey]}
            models={models}
            value={form.effort || ''}
            onChange={(v) => set('effort', v)}
          />
          <label>
            Permissions
            <select
              value={form.permission || 'danger'}
              onChange={(e) => set('permission', e.target.value)}
            >
              <option value="sandbox">Sandbox / CLI default</option>
              <option value="danger">
                Dangerous · full access without approval
              </option>
            </select>
          </label>
        </section>
        <section className="panel settings-card">
          <h2>Workflow overrides</h2>
          <p className="muted">
            Blank values inherit workspace defaults. Linked sessions keep their
            agent and model.
          </p>
          {[
            ['review', 'Code review'],
            ['comments', 'Address comments'],
            ['conflicts', 'Resolve conflicts'],
            ['ci', 'Fix CI'],
            ['issue', 'Address issue'],
            ['describe', 'Write issue description'],
          ].map(([key, label]) => (
            <WorkflowSetting
              key={key}
              label={label}
              value={form.workflows?.[key] || {}}
              change={(v) => set('workflows', { ...form.workflows, [key]: v })}
              available={available}
              models={models}
              settings={form}
            />
          ))}
        </section>
        <SprintSettings
          form={form}
          change={change}
          projects={status.projects}
          api={api}
        />
        <section className="panel settings-card review-settings">
          <h2>Code reviews</h2>
          <div className="setting-line">
            <b>Publishing approval</b>
            <span className="tag green">Always required</span>
          </div>
          <p className="muted">
            Agents prepare local commits and draft reviews. Review the result on
            Focus and click Publish to send it to GitHub. Auto mode follows the
            same rule.
          </p>
          <div className="form-grid">
            <label>
              Tone
              <select
                aria-describedby="review-tone-help"
                value={form.reviewTone || 'constructive'}
                onChange={(e) => set('reviewTone', e.target.value)}
              >
                <option value="constructive">Constructive</option>
                <option value="direct">Direct</option>
                <option value="supportive">Supportive</option>
              </select>
              <small id="review-tone-help" className="hint review-help">
                {toneHelp[form.reviewTone || 'constructive']}
              </small>
            </label>
            <label>
              Review depth
              <select
                aria-describedby="review-depth-help"
                value={form.reviewScope || 'balanced'}
                onChange={(e) => set('reviewScope', e.target.value)}
              >
                <option value="blocking">Important fixes only</option>
                <option value="balanced">
                  Important fixes + useful improvements
                </option>
                <option value="thorough">
                  Everything, including useful nits
                </option>
              </select>
              <small id="review-depth-help" className="hint review-help">
                {scopeHelp[form.reviewScope || 'balanced']}
              </small>
            </label>
            <label className="wide">
              Additional review preferences
              <textarea
                maxLength={8000}
                value={form.reviewPreferences || ''}
                onChange={(e) => set('reviewPreferences', e.target.value)}
                placeholder="Optional: team conventions, priorities, or criteria"
              />
            </label>
          </div>
          <p className="muted">
            Reviews consider the description, linked issues, discussions, prior
            feedback, and code. Comments use concise, simple language and
            suggestions where useful.
          </p>
        </section>
      </div>
    </>
  );
}
function WorkflowSetting({
  label,
  value,
  change,
  available,
  models,
  settings,
}) {
  const agent = value.agent || settings.defaultAgent || 'codex',
    model =
      value.model ||
      (agent === 'claude' ? settings.claudeModel : settings.codexModel);
  return (
    <details className="workflow">
      <summary>{label}</summary>
      <div className="form-grid">
        <label>
          Agent
          <select
            value={value.agent || ''}
            onChange={(e) =>
              change({ ...value, agent: e.target.value, model: '', effort: '' })
            }
          >
            <option value="">Workspace default</option>
            <option value="codex">Codex</option>
            <option value="claude" disabled={!available.claude}>
              Claude Code
            </option>
          </select>
        </label>
        <ModelPicker
          key={agent}
          agent={agent}
          value={value.model || ''}
          onChange={(model) => change({ ...value, model })}
          models={models}
          emptyLabel="Workspace default"
        />
        <ReasoningPicker
          agent={agent}
          model={model}
          models={models}
          value={value.effort || ''}
          onChange={(effort) => change({ ...value, effort })}
          emptyLabel="Workspace default"
        />
        <label>
          Permissions
          <select
            value={value.permission || ''}
            onChange={(e) => change({ ...value, permission: e.target.value })}
          >
            <option value="">Workspace default</option>
            <option value="sandbox">Sandbox / CLI default</option>
            <option value="danger">Dangerous full access</option>
          </select>
        </label>
      </div>
    </details>
  );
}
