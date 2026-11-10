// Settings, shown in the chat's place in the sidebar. Models are the only settings
// for now; a Chart tab comes with chart direction (ITC-33).
import type { ModelSettingsView, ModelTestResult } from '@idea-to-code/core';
import { ModelSettings } from './ModelSettings.js';

export interface SettingsProps {
  onBack: () => void;
  trusted: boolean;
  models: ModelSettingsView | null;
  test: ModelTestResult[] | 'running' | null;
  onTest: () => void;
}

export function Settings({ onBack, trusted, models, test, onTest }: SettingsProps) {
  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="settings__bar">
        <button type="button" className="chat__icon-button" onClick={onBack} aria-label="Back to the chat" title="Back to the chat">
          <span className="codicon codicon-arrow-left" aria-hidden="true" />
        </button>
        <h2 className="settings__title" id="settings-title">
          Models
        </h2>
      </header>
      <div className="settings__pane">
        <ModelSettings view={models} trusted={trusted} test={test} onTest={onTest} />
      </div>
    </section>
  );
}
