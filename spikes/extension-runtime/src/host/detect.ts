// Which optional APIs this editor offers. Everything newer than the engine
// floor is detected at runtime, never assumed (forks lag behind VS Code).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { appDataDir } from '../store/appData.js';

interface LmLike {
  selectChatModels?: (selector?: object) => Thenable<{ vendor: string; family: string; id: string }[]>;
  registerMcpServerDefinitionProvider?: unknown;
}

export interface RuntimeReport {
  appName: string;
  appHost: string;
  uriScheme: string;
  vscodeVersion: string;
  platform: string;
  arch: string;
  at: string;
  lm: { present: boolean; models: { vendor: string; family: string; id: string }[]; error?: string };
  mcp: { present: boolean };
  customEditorApi: boolean;
  webview: { workerMode?: string; layoutMs?: number };
}

const withTimeout = <T>(p: Thenable<T>, ms: number) =>
  Promise.race([Promise.resolve(p), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);

export async function runtimeReport(webview: RuntimeReport['webview'] = {}): Promise<RuntimeReport> {
  const lm = (vscode as unknown as { lm?: LmLike }).lm;
  const report: RuntimeReport = {
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    uriScheme: vscode.env.uriScheme,
    vscodeVersion: vscode.version,
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    lm: { present: typeof lm?.selectChatModels === 'function', models: [] },
    mcp: { present: typeof lm?.registerMcpServerDefinitionProvider === 'function' },
    customEditorApi: typeof vscode.window.registerCustomEditorProvider === 'function',
    webview,
  };
  if (report.lm.present) {
    try {
      // Listing models never prompts; only sending a request asks for consent.
      const models = await withTimeout(lm!.selectChatModels!(), 5_000);
      report.lm.models = models.map((m) => ({ vendor: m.vendor, family: m.family, id: m.id }));
    } catch (err) {
      report.lm.error = (err as Error).message;
    }
  }
  return report;
}

export async function saveReport(report: RuntimeReport): Promise<string> {
  const dir = join(appDataDir(), 'reports');
  await mkdir(dir, { recursive: true });
  const slug = report.appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const path = join(dir, `${slug}-${report.vscodeVersion}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}
