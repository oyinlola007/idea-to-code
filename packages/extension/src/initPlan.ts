// "Initialize plan in this workspace": creates the map, writes the guide and offers
// the agent connectors. Never overwrites: a plan already there just gets its guide
// refreshed and connectors offered again, so this is also how to change them later.
import { CONNECTORS, newPlanMap, type ConnectorId } from '@idea-to-code/core';
import type { ProjectService } from '@idea-to-code/store';
import * as vscode from 'vscode';
import type { ProjectHost } from './projectHost.js';
import type { WorkspaceTrust } from './trust.js';
import { VsCodePlanFiles } from './vscodePlanFiles.js';

export interface InitOptions {
  /** Which connectors to set, skipping the prompt. */
  connectors?: ConnectorId[];
}

async function chooseConnectors(service: ProjectService): Promise<ConnectorId[] | undefined> {
  const states = new Map((await service.connectorStates()).map((s) => [s.id, s.state]));
  const items = CONNECTORS.filter((c) => c.available).map((c) => {
    const state = states.get(c.id);
    return {
      label: c.label,
      description: c.path,
      ...(state === 'blocked' ? { detail: "This file already exists and wasn't created by idea-to-code, so it will be left alone." } : {}),
      picked: state === 'absent' ? c.defaultOn : state !== 'blocked',
      id: c.id,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Which coding agents should know about this plan?',
    placeHolder: 'Each adds a small pointer to the plan. Nothing else in your files changes.',
  });
  return picked?.map((p) => p.id);
}

async function applyConnectors(service: ProjectService, chosen: ConnectorId[]): Promise<void> {
  for (const connector of CONNECTORS.filter((c) => c.available)) {
    const result = await service.setConnector(connector.id, chosen.includes(connector.id));
    // Only something the user asked for is worth interrupting them about.
    if (result.status === 'refused' && chosen.includes(connector.id))
      void vscode.window.showWarningMessage(`${connector.label}: ${result.reason}`);
  }
}

export async function initPlan(host: ProjectHost, trust: WorkspaceTrust, options: InitOptions = {}): Promise<void> {
  if (!trust.isTrusted) {
    void vscode.window.showWarningMessage('Trust this folder to create a plan: Restricted Mode is view-only.');
    return;
  }
  await host.settled();
  if (!host.activeFolder) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder =
      folders.length > 1 && !options.connectors
        ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Create the plan in which folder?' })
        : folders[0];
    if (!folder) {
      if (folders.length === 0) void vscode.window.showInformationMessage('Open a folder first, then create its plan.');
      return;
    }
    const files = new VsCodePlanFiles(folder.uri);
    if ((await files.read('plan/map.yaml')) !== null) {
      void vscode.window.showWarningMessage(`${folder.name}/plan/map.yaml already exists and isn't a plan, so it was left alone.`);
      return;
    }
    await files.write('plan/map.yaml', newPlanMap(folder.name));
    await host.refresh();
  }
  const service = host.service;
  if (!service) return;
  await service.writeGuide();
  const chosen = options.connectors ?? (await chooseConnectors(service));
  if (chosen) await applyConnectors(service, chosen);
}
