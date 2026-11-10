// Plan files open as a chart, like markdown's preview but as the editor itself. Only
// real plan files stay: anything else quietly reopens as text.
import * as vscode from 'vscode';
import { featureOfPlanFile } from './planPaths.js';
import type { ProjectHost } from './projectHost.js';
import { connectWebview, type WebviewEvents } from './webviewConnection.js';
import { webviewHtml, webviewOptions } from './webviewHtml.js';

export const EDITOR_VIEW_TYPE = 'ideaToCode.planEditor';

export class PlanEditor implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ProjectHost,
    private readonly events: WebviewEvents,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    await this.host.settled();
    const planFile = this.host.planFile(document.uri);
    if (planFile === undefined) {
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', panel.viewColumn);
      panel.dispose();
      return;
    }
    panel.webview.options = webviewOptions(this.context.extensionUri);
    const connection = connectWebview(panel.webview, this.host, this.events, this.log, featureOfPlanFile(planFile));
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    panel.onDidDispose(() => {
      connection.dispose();
    });
  }

  async openToSide(uri: vscode.Uri | undefined): Promise<void> {
    const target = uri ?? activeResource();
    if (!target) return;
    await vscode.commands.executeCommand('vscode.openWith', target, EDITOR_VIEW_TYPE, vscode.ViewColumn.Beside);
  }

  register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, this, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    });
  }
}

function activeResource(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

/** Swaps the chart tab for text, leaving a chart open in another group alone. */
export async function reopenAsText(uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? activeResource();
  if (!target) return;
  await vscode.commands.executeCommand('vscode.openWith', target, 'default');
  // Looked up only now: opening the text makes a Tab object from before it stale in older cores.
  const chart = vscode.window.tabGroups.activeTabGroup.tabs.find(
    ({ input }) =>
      input instanceof vscode.TabInputCustom && input.viewType === EDITOR_VIEW_TYPE && input.uri.toString() === target.toString(),
  );
  if (chart) await vscode.window.tabGroups.close(chart);
}
