// The "Open Plan" tab: one webview panel for the workspace's plan.
import * as vscode from 'vscode';
import { ChartSession } from './chartSession.js';
import { planRoot } from './planRoot.js';
import { webviewHtml, webviewOptions } from './webviewHtml.js';

export const PANEL_VIEW_TYPE = 'ideaToCode.plan';

let current: { panel: vscode.WebviewPanel; session: ChartSession } | undefined;

export function currentPanel() {
  return current;
}

function attach(panel: vscode.WebviewPanel, root: string, context: vscode.ExtensionContext, log: vscode.LogOutputChannel, start?: string) {
  panel.webview.options = webviewOptions(context.extensionUri);
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity.svg');
  const session = new ChartSession('panel', panel.webview, root, context.extensionUri, log, start);
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri);
  current = { panel, session };
  panel.onDidDispose(() => {
    session.dispose();
    if (current?.panel === panel) current = undefined;
  });
}

export function openPlanPanel(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, start?: string) {
  const root = planRoot();
  if (!root) {
    void vscode.window.showWarningMessage('No plan found: open a folder that contains plan/map.yaml.');
    return;
  }
  if (current) {
    current.panel.reveal();
    if (start) current.session.navigate(start);
    return;
  }
  const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, 'Plan', vscode.ViewColumn.Active, {
    ...webviewOptions(context.extensionUri),
    retainContextWhenHidden: false,
  });
  attach(panel, root, context, log, start);
}

export function closePlanPanel() {
  current?.panel.dispose();
}

/** Brings the tab back after a window reload; the webview restores its own level. */
export function registerPanelSerializer(context: vscode.ExtensionContext, log: vscode.LogOutputChannel) {
  return vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
    async deserializeWebviewPanel(panel) {
      const root = planRoot();
      if (!root) {
        panel.dispose();
        return;
      }
      attach(panel, root, context, log);
    },
  });
}
