// The app tab: one per window, restored after a reload by the serializer.
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';
import { connectWebview, type WebviewConnection, type WebviewEvents } from './webviewConnection.js';
import { webviewHtml, webviewOptions } from './webviewHtml.js';

export const APP_VIEW_TYPE = 'ideaToCode.app';

export class AppPanel {
  private panel: vscode.WebviewPanel | undefined;
  private connection: WebviewConnection | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ProjectHost,
    private readonly events: WebviewEvents,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tab-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tab-dark.svg'),
    };
    panel.webview.options = webviewOptions(this.context.extensionUri);
    const connection = connectWebview(panel.webview, this.host, this.events, this.log);
    this.connection = connection;
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    panel.onDidDispose(() => {
      connection.dispose();
      this.panel = undefined;
      this.connection = undefined;
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

  /** Shows the tab at a level. */
  showLevel(level: string): void {
    this.show();
    this.connection?.showLevel(level);
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
