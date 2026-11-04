// The Models tab: where the chat sends your plan, and which models it uses. A key is
// entered in the editor's own password box, so this page never holds one: it only
// hears whether one is saved.
import type { ModelSettingsPatch, ModelSettingsView, ModelTestResult, ModelTier } from '@idea-to-code/core';
import { useState } from 'react';
import { send } from '../bridge.js';

const EDITOR = 'editor';
const LABELS: Record<ModelTier, string> = { large: 'Model', small: 'Fast model' };

const update = (patch: ModelSettingsPatch) => {
  send({ type: 'model-settings-set', patch });
};

/** Text that's saved when you leave the box or press Enter, not on each key. */
function DraftInput({
  id,
  value,
  label,
  placeholder,
  focus,
  onSave,
}: {
  id: string;
  value: string;
  label?: string;
  placeholder?: string;
  focus?: boolean;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const save = () => {
    if (draft.trim() !== value) onSave(draft);
  };
  return (
    <input
      id={id}
      className="field"
      value={draft}
      spellCheck={false}
      autoFocus={focus === true}
      {...(label === undefined ? {} : { 'aria-label': label })}
      {...(placeholder === undefined ? {} : { placeholder })}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') save();
      }}
    />
  );
}

const OTHER = '\u0000other';

/** A short list of suggested models, with "Other…" for typing any model ID. */
function ModelField({ tier, view }: { tier: ModelTier; view: ModelSettingsView }) {
  const id = `model-${tier}`;
  const value = view[tier];
  const suggestions =
    view.source === 'editor'
      ? view.editorModels.map((model) => ({ id: model.id, label: model.label }))
      : (view.providers.find((candidate) => candidate.id === view.provider)?.[tier] ?? []).map((model) => ({ id: model, label: model }));
  // The editor's models are all there is, so only your own key can name another.
  const canType = view.source === 'key';
  const listed = suggestions.some((model) => model.id === value);
  const [typing, setTyping] = useState(false);
  const showInput = canType && (typing || suggestions.length === 0 || (!listed && value !== ''));
  return (
    <div className="setting">
      <label htmlFor={id}>{LABELS[tier]}</label>
      {suggestions.length > 0 && (
        <select
          id={id}
          className="field"
          value={showInput ? OTHER : value}
          onChange={(event) => {
            if (event.target.value === OTHER) {
              setTyping(true);
              return;
            }
            setTyping(false);
            update({ [tier]: event.target.value });
          }}
        >
          {!listed && !showInput && <option value={value}>{value === '' ? 'Choose…' : value}</option>}
          {suggestions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          {canType && <option value={OTHER}>Other…</option>}
        </select>
      )}
      {showInput && (
        <div className={suggestions.length > 0 ? 'setting__under' : undefined}>
          <DraftInput
            key={`${view.provider}:${value}`}
            id={suggestions.length > 0 ? `${id}-other` : id}
            value={listed ? '' : value}
            label={`${LABELS[tier]} ID`}
            placeholder="Model ID"
            focus={typing}
            onSave={(text) => {
              if (text.trim() !== '') update({ [tier]: text });
            }}
          />
        </div>
      )}
    </div>
  );
}

function KeyField({ provider }: { provider: ModelSettingsView['providers'][number] }) {
  const ask = () => {
    send({ type: 'model-key', provider: provider.id, action: 'set' });
  };
  return (
    <div className="setting">
      <span className="setting__label">API key</span>
      {provider.hasKey ? (
        <div className="key">
          <span className="key__dots" aria-label="Saved">
            ••••••••••••
          </span>
          <button type="button" className="chat__icon-button" title="Replace" aria-label="Replace the key" onClick={ask}>
            <span className="codicon codicon-edit" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="chat__icon-button"
            title="Remove"
            aria-label="Remove the key"
            onClick={() => {
              send({ type: 'model-key', provider: provider.id, action: 'remove' });
            }}
          >
            <span className="codicon codicon-trash" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button type="button" className="button button--secondary setting__button" onClick={ask}>
          Add key…
        </button>
      )}
    </div>
  );
}

function Results({ results }: { results: ModelTestResult[] }) {
  return (
    <ul className="results">
      {results.map((result) => (
        <li key={result.tier} className={result.ok ? undefined : 'results__failed'}>
          <span className={`codicon codicon-${result.ok ? 'pass' : 'error'}`} aria-hidden="true" />
          <span>{result.ok ? result.model : `${LABELS[result.tier]}: ${result.message ?? 'failed'}`}</span>
        </li>
      ))}
    </ul>
  );
}

export function ModelSettings({
  view,
  trusted,
  test,
  onTest,
}: {
  view: ModelSettingsView | null;
  trusted: boolean;
  test: ModelTestResult[] | 'running' | null;
  onTest: () => void;
}) {
  if (!trusted) return <p className="settings__empty">Trust this folder to use the chat.</p>;
  if (!view) return null;
  const provider = view.providers.find((candidate) => candidate.id === view.provider);
  const hasEditorModels = view.editorModels.length > 0;
  return (
    <>
      <div className="setting">
        {/* The label says where the plan goes, so there's nothing else to explain. */}
        <label htmlFor="model-provider">Send your plan to</label>
        <select
          id="model-provider"
          className="field"
          value={view.source === 'editor' ? EDITOR : view.provider}
          onChange={(event) => {
            const choice = event.target.value;
            update(choice === EDITOR ? { source: 'editor' } : { source: 'key', provider: choice });
          }}
        >
          {hasEditorModels && <option value={EDITOR}>Your editor's models</option>}
          {view.providers.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </div>

      {view.source === 'key' && view.provider === 'custom' && (
        <div className="setting">
          <label htmlFor="model-address">Address</label>
          <DraftInput
            key={view.baseUrl}
            id="model-address"
            value={view.baseUrl}
            placeholder="http://localhost:11434/v1"
            onSave={(text) => {
              update({ baseUrl: text });
            }}
          />
          {view.baseUrlProblem !== undefined && view.baseUrl !== '' && <p className="setting__warning">{view.baseUrlProblem}</p>}
          {view.sendsKeyInClear === true && <p className="setting__warning">Plain http: your key could be read on the way.</p>}
        </div>
      )}
      {view.source === 'key' && provider && <KeyField provider={provider} />}

      <ModelField key={`large:${view.source}:${view.provider}`} tier="large" view={view} />
      <ModelField key={`small:${view.source}:${view.provider}`} tier="small" view={view} />

      <div className="setting">
        <button
          type="button"
          className="button button--secondary setting__button"
          title="Sends one short message to each model, which uses a few tokens."
          disabled={test === 'running'}
          onClick={onTest}
        >
          {test === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        {test !== null && test !== 'running' && <Results results={test} />}
      </div>
    </>
  );
}
