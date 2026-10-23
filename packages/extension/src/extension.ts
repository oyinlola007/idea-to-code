// The idea-to-code extension. The shell (views, plan tab, custom editor)
// arrives in ITC-9; for now it only logs that it started.
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('idea-to-code', { log: true });
  context.subscriptions.push(log);
  log.info(`activated in ${vscode.env.appName} ${vscode.version}`);
}

export function deactivate(): void {
  // Nothing to clean up yet.
}
