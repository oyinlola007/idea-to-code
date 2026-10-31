// Which models the built-in chat uses. A key is entered in the editor's own password
// box, so this page never holds one: it only hears whether one is saved.
import type { ModelSettingsPatch, ModelSettingsView, ModelTestResult, ModelTier } from '@idea-to-code/core';
import { useEffect, useRef, useState } from 'react';
import { send } from '../bridge.js';

interface Props {
  view: ModelSettingsView | null;
  test: ModelTestResult[] | 'running' | null;
  onTest: () => void;
  onClose: () => void;
}

const TIERS: Record<ModelTier, { label: string; hint: string }> = {
  large: { label: 'Main model', hint: 'Plans features and answers in the chat.' },
  small: { label: 'Small model', hint: 'Quick steps and small edits, to save cost.' },
};

const update = (patch: ModelSettingsPatch) => {
  send({ type: 'model-settings-set', patch });
};

/** Text that's saved when you leave the box or press Enter, not on each key. */
function DraftInput({
  id,
  value,
  list,
  placeholder,
  onSave,
}: {
  id: string;
  value: string;
  list?: string;
  placeholder?: string;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const save = () => {
    if (draft.trim() !== value) onSave(draft);
  };
  return (
    <input
      id={id}
      className="models__field"
      value={draft}
      spellCheck={false}
      {...(list === undefined ? {} : { list })}
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

function ModelField({ tier, view }: { tier: ModelTier; view: ModelSettingsView }) {
  const id = `model-${tier}`;
  const { label, hint } = TIERS[tier];
  const value = view[tier];
  if (view.source === 'editor') {
    return (
      <div className="models__group">
        <label className="models__label" htmlFor={id}>
          {label}
        </label>
        <select
          id={id}
          className="models__field"
          value={value}
          onChange={(event) => {
            update({ [tier]: event.target.value });
          }}
        >
          {view.editorModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <p className="models__hint">{hint}</p>
      </div>
    );
  }
  const provider = view.providers.find((candidate) => candidate.id === view.provider);
  const suggestions = provider?.[tier] ?? [];
  const known = suggestions.find((model) => model.id === value);
  return (
    <div className="models__group">
      <label className="models__label" htmlFor={id}>
        {label}
      </label>
      <DraftInput
        key={`${view.provider}:${value}`}
        id={id}
        value={value}
        list={`${id}-list`}
        placeholder="Model ID"
        onSave={(text) => {
          update({ [tier]: text });
        }}
      />
      <datalist id={`${id}-list`}>
        {suggestions.map((model) => (
          <option key={model.id} value={model.id} />
        ))}
      </datalist>
      <p className="models__hint">
        {hint}{' '}
        {known?.tested === true ? (
          <span className="models__tested">Tested with idea-to-code.</span>
        ) : value !== '' ? (
          'Not tested with idea-to-code yet.'
        ) : null}
      </p>
    </div>
  );
}

function KeyRow({ provider }: { provider: ModelSettingsView['providers'][number] }) {
  const ask = () => {
    send({ type: 'model-key', provider: provider.id, action: 'set' });
  };
  return (
    <div className="models__group">
      <span className="models__label">API key{provider.keyRequired ? '' : ' (optional)'}</span>
      <div className="models__key">
        {provider.hasKey ? (
          <>
            <span>Saved in your system keychain.</span>
            <button type="button" className="button button--secondary" onClick={ask}>
              Replace
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                send({ type: 'model-key', provider: provider.id, action: 'remove' });
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <button type="button" className="button button--secondary" onClick={ask}>
            Add key…
          </button>
        )}
      </div>
    </div>
  );
}

function TestResults({ results }: { results: ModelTestResult[] }) {
  // They land at the bottom of the panel, which may be below what's showing.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.scrollIntoView({ block: 'nearest' });
  }, [results]);
  return (
    <ul ref={list} className="models__results">
      {results.map((result) => (
        <li key={result.tier}>
          <span className={`codicon codicon-${result.ok ? 'pass' : 'error'}`} aria-hidden="true" />
          <span>
            {TIERS[result.tier].label}: {result.ok ? `${result.model} answered.` : result.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ModelSettingsPanel({ view, test, onTest, onClose }: Props) {
  const provider = view?.providers.find((candidate) => candidate.id === view.provider);
  const hasEditorModels = (view?.editorModels.length ?? 0) > 0;
  return (
    <aside className="details models" aria-label="Model settings">
      <header className="details__header">
        <span className="details__kind">
          <span className="codicon codicon-settings-gear" aria-hidden="true" />
          Models
        </span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close model settings" title="Close (Esc)">
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      {!view ? (
        <p className="models__hint">Loading…</p>
      ) : (
        <>
          <p className="models__notice">
            When you use the built-in chat, your plan and your messages are sent to the provider you choose here.
          </p>

          <fieldset className="models__group">
            <legend>Use</legend>
            <label className="models__choice">
              <input
                type="radio"
                name="model-source"
                checked={view.source === 'editor'}
                disabled={!hasEditorModels}
                onChange={() => {
                  update({ source: 'editor' });
                }}
              />
              <span>Your editor's models</span>
            </label>
            {!hasEditorModels && <p className="models__hint">Your editor doesn't offer any models right now, so use your own API key.</p>}
            <label className="models__choice">
              <input
                type="radio"
                name="model-source"
                checked={view.source === 'key'}
                onChange={() => {
                  update({ source: 'key' });
                }}
              />
              <span>Your own API key</span>
            </label>
          </fieldset>

          {view.source === 'key' && (
            <>
              <div className="models__group">
                <label className="models__label" htmlFor="model-provider">
                  Provider
                </label>
                <select
                  id="model-provider"
                  className="models__field"
                  value={view.provider}
                  onChange={(event) => {
                    update({ provider: event.target.value });
                  }}
                >
                  {view.providers.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </div>
              {view.provider === 'custom' && (
                <div className="models__group">
                  <label className="models__label" htmlFor="model-address">
                    Address
                  </label>
                  <DraftInput
                    key={view.baseUrl}
                    id="model-address"
                    value={view.baseUrl}
                    placeholder="http://localhost:11434/v1"
                    onSave={(text) => {
                      update({ baseUrl: text });
                    }}
                  />
                  {view.baseUrlProblem !== undefined && <p className="models__warning">{view.baseUrlProblem}</p>}
                  {view.sendsKeyInClear === true && (
                    <p className="models__warning">
                      This address uses plain http, so your key could be read on the way. Use https, or remove the key.
                    </p>
                  )}
                </div>
              )}
              {provider && <KeyRow provider={provider} />}
            </>
          )}

          <ModelField tier="large" view={view} />
          <ModelField tier="small" view={view} />

          <div className="models__test">
            <button type="button" className="button button--secondary" disabled={test === 'running'} onClick={onTest}>
              {test === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            <p className="models__hint">Sends one short message to each model, which uses a few tokens.</p>
            {test !== null && test !== 'running' && <TestResults results={test} />}
          </div>
        </>
      )}
    </aside>
  );
}
