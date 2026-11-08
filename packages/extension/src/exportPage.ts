// "Export as Web Page": the plan as one .html file to share, saved where the user picks.
import { sharedState } from '@idea-to-code/core';
import * as vscode from 'vscode';
import { pageFileName } from './exportPageName.js';
import type { ProjectHost } from './projectHost.js';
import { sharedPageHtml } from './sharedPage.js';
import { VsCodePlanFiles } from './vscodePlanFiles.js';

const decoder = new TextDecoder();

/** `target` is for the tests: a place to save without asking. */
export async function exportWebPage(extensionUri: vscode.Uri, host: ProjectHost, target?: vscode.Uri): Promise<vscode.Uri | undefined> {
  await host.settled();
  const folder = host.activeFolder;
  if (!folder || host.state.kind !== 'plan') {
    void vscode.window.showInformationMessage('Open a folder with a plan first.');
    return undefined;
  }
  // The plan as saved, never an agent's changes still in progress.
  const files = new VsCodePlanFiles(folder.uri);
  const texts: Record<string, string> = {};
  for (const path of await files.listPlanFiles()) {
    const text = await files.read(path);
    if (text !== null) texts[path] = text;
  }
  const state = sharedState(texts, folder.name);
  const title = state.kind === 'plan' ? (state.plan.project ?? folder.name) : folder.name;
  const uri =
    target ??
    (await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder.uri, pageFileName(title)),
      filters: { 'Web page': ['html'] },
      saveLabel: 'Export',
      title: 'Export the plan as a web page',
    }));
  if (!uri) return undefined;

  const webview = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const read = (name: string) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(webview, name));
  const [script, style, font] = await Promise.all([read('webview.js'), read('style.css'), read('codicon.ttf')]);
  const html = sharedPageHtml({ title, state, script: decoder.decode(script), style: decoder.decode(style), font });
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(html));

  if (!target) {
    const name = uri.path.split('/').pop() ?? 'the page';
    void vscode.window.showInformationMessage(`Saved ${name}.`, 'Open in Browser').then((choice) => {
      if (choice) void vscode.env.openExternal(uri);
    });
  }
  return uri;
}
