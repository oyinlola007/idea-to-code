// The app tab: one per window, restored after a reload by the serializer.
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';
import { connectWebview, type WebviewEvents } from './webviewConnection.js';
import { webviewHtml, webviewOptions } from './webviewHtml.js';

export const APP_VIEW_TYPE = 'ideaToCode.app';

export class AppPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ProjectHost,
    private readonly events: WebviewEvents,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.options = webviewOptions(this.context.extensionUri);
    const connection = connectWebview(panel.webview, this.host, this.events, this.log);
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    panel.onDidDispose(() => {
      connection.dispose();
      this.panel = undefined;
    });
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(APP_VIEW_TYPE, 'Plan', vscode.ViewColumn.Active, {
      ...webviewOptions(this.context.extensionUri),
      retainContextWhenHidden: false,
    });
    this.attach(panel);
  }

  close(): void {
    this.panel?.dispose();
  }

  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(APP_VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        this.attach(panel);
        return Promise.resolve();
      },
    });
  }
}
