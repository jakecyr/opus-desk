import { useState, useEffect, useRef } from 'react';
import { ModelPicker, ReasoningPicker } from './ModelPicker.jsx';
import { createAutosave } from './autosave.js';
import { SprintSettings } from './Sprint.jsx';
import { SettingsLayout } from './SettingsLayout.jsx';
import {
  autoActionDefaults,
  getAutoActionMode,
  getReviewCriteria,
  reviewCriteria,
  reviewPresets,
  validateReviewSettings,
} from '../server/review-policy.js';
import './review-settings.css';

const toneHelp = {
  constructive: 'Calm and practical: explain the impact and suggest a fix.',
  direct:
    'Straight to the point: state the problem and the smallest useful fix.',
  supportive:
    'Friendly and respectful: clearly explain problems without softening what needs fixing.',
};
const workflows = [
  ['review', 'First review'],
  ['rereview', 'Re-review'],
  ['conflicts', 'Resolve conflicts'],
  ['ci', 'Fix CI'],
  ['comments', 'Address comments'],
  ['issue', 'Address issue'],
  ['describe', 'Write issue description'],
];
const modeLabels = { off: 'Off', draft: 'Draft', publish: 'Publish' };

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
    modelKey = agent === 'claude' ? 'claudeModel' : 'codexModel',
    criteria = getReviewCriteria(form.reviewCriteria, form.reviewScope),
    preset =
      Object.keys(reviewPresets).find(
        (key) => reviewPresets[key].join() === criteria.join(),
      ) || 'custom';
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
      <SettingsLayout>
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
          <h2>Defaults</h2>
          <label>
            GitHub hostname
            <input
              value={form.githubHost || 'github.com'}
              onChange={(e) => set('githubHost', e.target.value)}
              placeholder="github.com"
            />
          </label>
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
            Provider
            <select
              value={agent}
              onChange={(e) => set('defaultAgent', e.target.value)}
            >
              <option value="codex">OpenAI Codex</option>
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
            label="Model"
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
          <h2>Workflows</h2>
          <p className="muted">
            Drafts wait for approval. Publish automatically submits reviews or
            pushes fixes while Auto mode is running.
          </p>
          {workflows.map(([key, label]) => (
            <WorkflowSetting
              key={key}
              label={label}
              value={form.workflows?.[key] || {}}
              inherited={
                key === 'rereview' ? form.workflows?.review : undefined
              }
              change={(v) => set('workflows', { ...form.workflows, [key]: v })}
              mode={
                Object.hasOwn(autoActionDefaults, key)
                  ? getAutoActionMode(form, key)
                  : undefined
              }
              changeMode={(mode) =>
                set('autoActions', { ...form.autoActions, [key]: mode })
              }
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
                value={preset}
                onChange={(e) => {
                  const selected = e.target.value;
                  change({
                    reviewScope: selected,
                    reviewCriteria: reviewPresets[selected],
                  });
                }}
              >
                <option value="blocking">Important fixes only</option>
                <option value="balanced">
                  Important fixes and useful improvements
                </option>
                <option value="thorough">Include useful nits</option>
                {preset === 'custom' && <option value="custom">Custom</option>}
              </select>
            </label>
            <fieldset className="wide review-criteria">
              <legend>Check for</legend>
              {Object.entries(reviewCriteria).map(([key, { label }]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={criteria.includes(key)}
                    onChange={(e) =>
                      set(
                        'reviewCriteria',
                        e.target.checked
                          ? [...criteria, key]
                          : criteria.filter((item) => item !== key),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <RelatedRepositories
              key={(form.reviewRelatedRepos || []).join('\n')}
              value={(form.reviewRelatedRepos || []).join('\n')}
              change={(value) => set('reviewRelatedRepos', value)}
            />
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
        </section>
      </SettingsLayout>
    </>
  );
}

function RelatedRepositories({ value, change }) {
  const [error, setError] = useState('');
  return (
    <label className="wide">
      Related repositories
      <textarea
        className="review-related-repositories"
        defaultValue={value}
        placeholder="owner/repository"
        onChange={() => setError('')}
        onBlur={(e) => {
          const input = e.target.value
            .trim()
            .split(/[\s,]+/)
            .filter(Boolean);
          if (input.join('\n') === value) return;
          try {
            change(
              validateReviewSettings({ reviewRelatedRepos: input })
                .reviewRelatedRepos,
            );
          } catch (error) {
            setError(error.message);
          }
        }}
        aria-invalid={!!error}
        aria-describedby="review-repositories-help"
      />
      <small
        className={error ? 'field-error' : 'hint'}
        id="review-repositories-help"
      >
        {error ||
          'Add repositories with related dependencies or shared interfaces, one per line.'}
      </small>
    </label>
  );
}

function WorkflowSetting({
  label,
  value,
  inherited,
  change,
  mode,
  changeMode,
  available,
  models,
  settings,
}) {
  const config = { ...inherited, ...value };
  const agent = config.agent || settings.defaultAgent || 'codex',
    model =
      config.model ||
      (agent === 'claude' ? settings.claudeModel : settings.codexModel);
  return (
    <details className="workflow">
      <summary>
        {label}
        {mode && (
          <span
            className={
              'workflow-mode tag ' + (mode === 'publish' ? 'green' : '')
            }
          >
            {modeLabels[mode]}
          </span>
        )}
      </summary>
      <div className="form-grid">
        {mode && (
          <label>
            Auto mode
            <select
              value={mode}
              onChange={(e) => changeMode(e.target.value)}
              aria-label={label + ' Auto mode'}
            >
              <option value="off">Off</option>
              <option value="draft">Draft · wait for approval</option>
              <option value="publish">Publish to GitHub automatically</option>
            </select>
          </label>
        )}
        <label>
          Provider
          <select
            value={value.agent || ''}
            onChange={(e) =>
              change({ ...value, agent: e.target.value, model: '', effort: '' })
            }
          >
            <option value="">Default</option>
            <option value="codex">OpenAI Codex</option>
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
          emptyLabel="Default"
        />
        <ReasoningPicker
          agent={agent}
          model={model}
          models={models}
          value={value.effort || ''}
          onChange={(effort) => change({ ...value, effort })}
          emptyLabel="Default"
        />
        <label>
          Manual permissions
          <select
            value={value.permission || ''}
            onChange={(e) => change({ ...value, permission: e.target.value })}
          >
            <option value="">Default</option>
            <option value="sandbox">Sandbox / CLI default</option>
            <option value="danger">Dangerous full access</option>
          </select>
        </label>
      </div>
    </details>
  );
}
