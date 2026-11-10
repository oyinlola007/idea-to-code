// "Initialize Plan in This Workspace": creates the map and writes the guide. Never
// overwrites: a plan already there just gets its guide refreshed.
import { newPlanMap } from '@idea-to-code/core';
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';
import type { WorkspaceTrust } from './trust.js';
import { VsCodePlanFiles } from './vscodePlanFiles.js';

/** Starts a plan in the workspace, if there isn't one. True when a plan is there afterwards. */
export async function initPlan(host: ProjectHost, trust: WorkspaceTrust): Promise<boolean> {
  if (!trust.isTrusted) {
    void vscode.window.showWarningMessage('Trust this folder to create a plan: Restricted Mode is view-only.');
    return false;
  }
  await host.settled();
  if (!host.activeFolder) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder =
      folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Create the plan in which folder?' }) : folders[0];
    if (!folder) {
      if (folders.length === 0) void vscode.window.showInformationMessage('Open a folder first, then create its plan.');
      return false;
    }
    const files = new VsCodePlanFiles(folder.uri);
    if ((await files.read('plan/map.yaml')) !== null) {
      void vscode.window.showWarningMessage(`${folder.name}/plan/map.yaml already exists and isn't a plan, so it was left alone.`);
      return false;
    }
    await files.write('plan/map.yaml', newPlanMap(folder.name));
    await host.refresh();
  }
  const service = host.service;
  if (!service) return false;
  await service.writeGuide();
  return true;
}
