// Where the plan lives: the setting if given, otherwise the first workspace
// folder with plan/map.yaml, or the nearest ancestor of an opened plan file.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';

export function planRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration('ideaToCode.spike').get<string>('planRoot');
  if (configured) return configured;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (existsSync(join(folder.uri.fsPath, 'plan', 'map.yaml'))) return folder.uri.fsPath;
  }
  return undefined;
}

export function rootOfPlanFile(file: string): string | undefined {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'plan', 'map.yaml'))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

/** The level a plan file opens at: the overview for map.yaml, else the feature's main flow. */
export function startLevelFor(file: string): string {
  const m = /[\\/]plan[\\/]features[\\/]([a-z0-9-]+)\.yaml$/.exec(file);
  return m ? m[1]! : 'overview';
}
