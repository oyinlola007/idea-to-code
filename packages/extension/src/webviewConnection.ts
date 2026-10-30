// One webview's side of the bridge. Every message is parsed in both directions: a
// bad one from the page is logged and dropped, and a bad one of ours fails loudly here.
import { HostMessage, WebviewMessage, type AppState } from '@idea-to-code/core';
import { checkProjectPath } from '@idea-to-code/store';
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';

export interface Rendered {
  kind: 'no-plan' | 'plan';
  features: number;
  problems: number;
}

/** What the pages report back; the in-editor tests read these. */
export class WebviewEvents implements vscode.Disposable {
  private readonly renderedEmitter = new vscode.EventEmitter<Rendered>();
  readonly onRendered = this.renderedEmitter.event;
  readonly errors: string[] = [];

  fireRendered(rendered: Rendered): void {
    this.renderedEmitter.fire(rendered);
  }

  dispose(): void {
    this.renderedEmitter.dispose();
  }
}

async function openProblem(host: ProjectHost, file: string, line: number, log: vscode.LogOutputChannel): Promise<void> {
  const folder = host.activeFolder;
  if (!folder) return;
  try {
    checkProjectPath(file);
  } catch (err) {
    log.warn(`refused to open a file from the webview: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, ...file.split('/'));
  const position = new vscode.Position(line - 1, 0);
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { selection: new vscode.Range(position, position) });
}

export function connectWebview(
  webview: vscode.Webview,
  host: ProjectHost,
  events: WebviewEvents,
  log: vscode.LogOutputChannel,
): vscode.Disposable {
  const send = (state: AppState) => {
    void webview.postMessage(HostMessage.parse({ type: 'state', state }));
  };
  return vscode.Disposable.from(
    host.onDidChange(send),
    webview.onDidReceiveMessage(async (raw: unknown) => {
      const parsed = WebviewMessage.safeParse(raw);
      if (!parsed.success) {
        log.warn(`dropped a bad message from the webview: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        return;
      }
      const message = parsed.data;
      switch (message.type) {
        case 'ready':
          await host.settled();
          send(host.state);
          break;
        case 'log':
          if (message.level === 'error') {
            events.errors.push(message.message);
            log.error(`webview: ${message.message}`);
          } else log.info(`webview: ${message.message}`);
          break;
        case 'rendered':
          events.fireRendered({ kind: message.kind, features: message.features, problems: message.problems });
          break;
        case 'init-plan':
          await vscode.commands.executeCommand('ideaToCode.initPlan');
          break;
        case 'open-problem':
          await openProblem(host, message.file, message.line, log);
          break;
      }
    }),
  );
}
