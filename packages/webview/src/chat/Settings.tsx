// Settings, shown in the chat's place in the sidebar: one tab per area, so new
// settings get a tab of their own instead of crowding the others.
import type { ChartSettings, ModelSettingsView, ModelTestResult, SettingsTab } from '@idea-to-code/core';
import { useRef, type KeyboardEvent } from 'react';
import { send } from '../bridge.js';
import { ModelSettings } from './ModelSettings.js';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'chart', label: 'Chart' },
];

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="setting">
      <span className="setting__label" id={`${label}-label`}>
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${label}-label`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className="segmented__option"
            onClick={() => {
              onChange(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChartTab({ view }: { view: ChartSettings | null }) {
  if (!view) return null;
  return (
    <Segmented
      label="Open plan files as"
      value={view.openAs}
      options={[
        { value: 'chart', label: 'Chart' },
        { value: 'text', label: 'Text' },
      ]}
      onChange={(openAs) => {
        send({ type: 'chart-settings-set', patch: { openAs } });
      }}
    />
  );
}

export interface SettingsProps {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onBack: () => void;
  trusted: boolean;
  models: ModelSettingsView | null;
  test: ModelTestResult[] | 'running' | null;
  onTest: () => void;
  chart: ChartSettings | null;
}

export function Settings({ tab, onTab, onBack, trusted, models, test, onTest, chart }: SettingsProps) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  // Arrow keys move between tabs, as in any tab list.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const at = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(at + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    if (!next) return;
    onTab(next.id);
    tabs.current[TABS.indexOf(next)]?.focus();
  };
  return (
    <section className="settings" aria-label="Settings">
      <header className="settings__bar">
        <button type="button" className="chat__icon-button" onClick={onBack} aria-label="Back to the chat" title="Back to the chat">
          <span className="codicon codicon-arrow-left" aria-hidden="true" />
        </button>
        <div className="tabs" role="tablist" aria-label="Settings" onKeyDown={onKey}>
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={t.id === tab}
              aria-controls={`pane-${t.id}`}
              tabIndex={t.id === tab ? 0 : -1}
              className="tabs__tab"
              onClick={() => {
                onTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div className="settings__pane" role="tabpanel" id={`pane-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'models' ? <ModelSettings view={models} trusted={trusted} test={test} onTest={onTest} /> : <ChartTab view={chart} />}
      </div>
    </section>
  );
}
