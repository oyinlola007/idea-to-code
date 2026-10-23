// Plan files open as a chart, like markdown's preview but as the editor
// itself. "Show YAML" (or Reopen Editor With…) switches back to text.
import * as vscode from 'vscode';
import { ChartSession } from './chartSession.js';
import { rootOfPlanFile, startLevelFor } from './planRoot.js';
import { webviewHtml, webviewOptions } from './webviewHtml.js';

export const EDITOR_VIEW_TYPE = 'ideaToCode.planEditor';

let counter = 0;

export class PlanEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = webviewOptions(this.context.extensionUri);
    const root = rootOfPlanFile(document.uri.fsPath);
    if (!root) {
      panel.webview.html = `<!doctype html><body style="font-family: var(--vscode-font-family); padding: 24px">This file isn't inside a plan folder with plan/map.yaml.</body>`;
      return;
    }
    // Refreshes come from the file watcher on save; unsaved edits aren't shown (display only).
    const session = new ChartSession(`editor-${++counter}`, panel.webview, root, this.context.extensionUri, this.log, startLevelFor(document.uri.fsPath));
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    panel.onDidDispose(() => session.dispose());
  }
}

export function registerPlanEditor(context: vscode.ExtensionContext, log: vscode.LogOutputChannel) {
  return vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, new PlanEditorProvider(context, log), {
    webviewOptions: { retainContextWhenHidden: false },
    supportsMultipleEditorsPerDocument: true,
  });
}

function activeResource(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups?.activeTabGroup.activeTab;
  const input = tab?.input as { uri?: vscode.Uri } | undefined;
  return input?.uri ?? vscode.window.activeTextEditor?.document.uri;
}

export async function openPreviewToSide(uri?: vscode.Uri) {
  const target = uri ?? activeResource();
  if (target) await vscode.commands.executeCommand('vscode.openWith', target, EDITOR_VIEW_TYPE, vscode.ViewColumn.Beside);
}

export async function showSource(uri?: vscode.Uri) {
  const target = uri ?? activeResource();
  if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
}
