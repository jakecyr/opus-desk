import { useState } from 'react';
export function ModelPicker({
  agent,
  value = '',
  onChange,
  models = {},
  label = 'Model',
  emptyLabel = 'CLI default',
}) {
  const catalog = models[agent] || {},
    choices = catalog.data || [];
  const known = choices.some((m) => (m.model || m.id) === value);
  const [other, Other] = useState(false);
  return (
    <label>
      {label}
      <select
        value={other || (value && !known) ? '__other' : value}
        onChange={(e) => {
          if (e.target.value === '__other') {
            Other(true);
            return;
          }
          Other(false);
          onChange(e.target.value);
        }}
      >
        <option value="">{emptyLabel}</option>
        {choices.map((m) => (
          <option key={m.id} value={m.model || m.id}>
            {m.displayName || m.model || m.id}
          </option>
        ))}
        <option value="__other">Other…</option>
      </select>
      {(other || (value && !known)) && (
        <input
          aria-label={label + ' custom name'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter model name"
        />
      )}
      {catalog.error && (
        <small className="hint">
          Couldn’t load models from {agent === 'claude' ? 'Claude' : 'Codex'}.
          You can enter a model name.
        </small>
      )}
    </label>
  );
}
export function ReasoningPicker({
  agent,
  model,
  models = {},
  value = '',
  onChange,
  emptyLabel = 'CLI default',
  label = 'Reasoning',
}) {
  const choices = models[agent]?.data || [],
    selected =
      choices.find((m) => (m.model || m.id) === model) ||
      (!model && choices.find((m) => m.isDefault));
  const supported = selected?.supportedReasoningEfforts
    ?.map((e) => (typeof e === 'string' ? e : e.reasoningEffort))
    .filter(Boolean);
  const levels = supported?.length
    ? supported
    : agent === 'claude'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : ['minimal', 'low', 'medium', 'high', 'xhigh'];
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {value && !levels.includes(value) && (
          <option value={value}>{value} (saved)</option>
        )}
        {levels.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
    </label>
  );
}
