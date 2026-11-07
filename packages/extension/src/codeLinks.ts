// The card's Code section, on the editor's side: open a linked file or folder, and
// link files picked in the editor. Only links the plan really has are opened, and
// only picks inside the project are linked.
import { checkCodeLinkPath, type VNode } from '@idea-to-code/core';
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';

export async function openCode(host: ProjectHost, path: string, log: vscode.LogOutputChannel): Promise<void> {
  const folder = host.activeFolder;
  if (!folder) return;
  if (checkCodeLinkPath(path) !== null || !host.isLinkedPath(path)) {
    log.warn(`refused to open "${path}" from the page: it isn't one of the plan's code links`);
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, ...path.replace(/\/$/, '').split('/'));
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    void vscode.window.showWarningMessage(`${path} doesn't exist.`);
    return;
  }
  if (stat.type & vscode.FileType.Directory) await vscode.commands.executeCommand('revealInExplorer', uri);
  else await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

/** The card with this id on any level, if it can link to code: a step or component without a child flow. */
function linkable(host: ProjectHost, nodeId: string): VNode | undefined {
  if (host.state.kind !== 'plan') return undefined;
  for (const level of Object.values(host.state.model.levels)) {
    const node = level.nodes.find((n) => n.id === nodeId && (n.kind === 'step' || n.kind === 'component') && n.opens === undefined);
    if (node) return node;
  }
  return undefined;
}

/** A picked file as the plan writes it: relative to the project, with "/". Null outside it. */
export function relativeLink(root: vscode.Uri, picked: vscode.Uri): string | null {
  if (picked.scheme !== root.scheme || !picked.path.startsWith(`${root.path}/`)) return null;
  const path = picked.path.slice(root.path.length + 1);
  return checkCodeLinkPath(path) === null ? path : null;
}

export async function linkCode(host: ProjectHost, nodeId: string): Promise<void> {
  const folder = host.activeFolder;
  const node = linkable(host, nodeId);
  if (!folder || !node) return;
  const picked = await vscode.window.showOpenDialog({
    defaultUri: folder.uri,
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Link',
    title: `Link code to “${node.label}”`,
  });
  if (!picked || picked.length === 0) return;
  const inside = picked.flatMap((uri) => relativeLink(folder.uri, uri) ?? []);
  if (inside.length < picked.length) void vscode.window.showWarningMessage('Only files and folders inside this project can be linked.');
  if (inside.length === 0) return;
  const existing = (node.code ?? []).map((c) => c.path);
  const result = await host.applyEdit('link_code', { id: nodeId, paths: [...existing, ...inside] });
  if (!result.ok) void vscode.window.showErrorMessage(result.message ?? "Couldn't link the code.");
}
