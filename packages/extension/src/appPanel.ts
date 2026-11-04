// The app tab: one per window, restored after a reload by the serializer.
import type { HostMessage, Reveal } from '@idea-to-code/core';
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

  private attach(panel: vscode.WebviewPanel, startLevel?: string): void {
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tab-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'tab-dark.svg'),
    };
    panel.webview.options = webviewOptions(this.context.extensionUri);
    const connection = connectWebview(panel.webview, this.host, this.events, this.log, startLevel);
    this.connection = connection;
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    // The sidebar's Open Plan icon only shows while the tab isn't on screen.
    const onScreen = (visible: boolean) => {
      void vscode.commands.executeCommand('setContext', 'ideaToCode.planVisible', visible);
    };
    onScreen(panel.visible);
    panel.onDidChangeViewState(() => {
      onScreen(panel.visible);
    });
    panel.onDidDispose(() => {
      onScreen(false);
      connection.dispose();
      this.panel = undefined;
      this.connection = undefined;
    });
  }

  show(startLevel?: string): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(APP_VIEW_TYPE, 'Plan', vscode.ViewColumn.Active, {
      ...webviewOptions(this.context.extensionUri),
      retainContextWhenHidden: false,
    });
    this.attach(panel, startLevel);
  }

  /** Shows the tab at a level. */
  showLevel(level: string): void {
    // A tab that's only now opening isn't listening yet, so it starts at the level instead.
    if (this.panel) {
      this.panel.reveal();
      this.connection?.showLevel(level);
    } else {
      this.show(level);
    }
  }

  /** Shows the tab with the history panel open. */
  showHistory(session?: string): void {
    this.deliver({ type: 'show-history', ...(session === undefined ? {} : { session }) });
  }

  /** Points out changes on the chart: in the tab if it's on screen, or bringing it forward. */
  reveal(reveal: Reveal, bringForward: boolean): void {
    const message: HostMessage = { type: 'reveal', reveal };
    if (bringForward) this.deliver(message);
    else if (this.panel?.visible === true) this.connection?.deliver(message, false);
  }

  private deliver(message: HostMessage): void {
    // A hidden tab reloads when revealed, and a new one is still loading, so neither is listening yet.
    const listening = this.panel?.visible === true;
    this.show();
    this.connection?.deliver(message, !listening);
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
