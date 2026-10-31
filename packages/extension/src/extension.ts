// The idea-to-code extension: wires the plan host to the views, tabs and commands.
import * as vscode from 'vscode';
import { AppPanel } from './appPanel.js';
import { detectOptionalApis, type OptionalApis } from './detect.js';
import { initPlan, type InitOptions } from './initPlan.js';
import { PlanEditor, reopenAsText } from './planEditor.js';
import { ProjectHost } from './projectHost.js';
import { FeatureTree, registerSidebar, SessionTree } from './sidebar.js';
import { WorkspaceTrust } from './trust.js';
import { WebviewEvents } from './webviewConnection.js';

/** Returned from activate() for the in-editor tests. */
export interface ExtensionApi {
  host: ProjectHost;
  trust: WorkspaceTrust;
  events: WebviewEvents;
  trees: { features: FeatureTree; sessions: SessionTree };
  optionalApis: OptionalApis;
  closeApp(): void;
  showLevel(level: string): void;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const log = vscode.window.createOutputChannel('idea-to-code', { log: true });
  const optionalApis = detectOptionalApis();
  log.info(`activated in ${vscode.env.appName} ${vscode.version}; optional APIs: ${JSON.stringify(optionalApis)}`);

  const trust = new WorkspaceTrust();
  const host = new ProjectHost(log, trust);
  const events = new WebviewEvents();
  const app = new AppPanel(context, host, events, log);
  const editor = new PlanEditor(context, host, events, log);
  const trees = { features: new FeatureTree(host), sessions: new SessionTree(host) };

  context.subscriptions.push(
    log,
    trust,
    host,
    events,
    registerSidebar(host, trees),
    app.register(),
    editor.register(),
    vscode.commands.registerCommand('ideaToCode.openApp', () => {
      app.show();
    }),
    vscode.commands.registerCommand('ideaToCode.initPlan', async (options?: InitOptions) => {
      await initPlan(host, trust, options);
      if (host.state.kind === 'plan') app.show();
    }),
    vscode.commands.registerCommand('ideaToCode.reopenAsText', (uri?: vscode.Uri) => reopenAsText(uri)),
    vscode.commands.registerCommand('ideaToCode.openPreviewToSide', (uri?: vscode.Uri) => editor.openToSide(uri)),
  );
  void host.refresh();
  return {
    host,
    trust,
    events,
    trees,
    optionalApis,
    closeApp: () => {
      app.close();
    },
    showLevel: (level) => {
      app.showLevel(level);
    },
  };
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
