// What every scenario uses: steps that report and carry on, waits, and the extension's state.
import { stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import type { ChatEvent } from '../../src/models/provider.js';
import type { ChartRendered } from '../../src/webviewConnection.js';

export const failures: string[] = [];

export async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL ${name}: ${message}`);
  }
}

export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(what: string, test: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function nextRender(
  api: ExtensionApi,
  want: (r: { kind: string; features: number; problems: number }) => boolean,
  ms = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error('no matching render from the webview'));
    }, ms);
    const sub = api.events.onRendered((rendered) => {
      if (!want(rendered)) return;
      clearTimeout(timer);
      sub.dispose();
      resolve();
    });
  });
}

export function nextChart(api: ExtensionApi, level: string, ms = 30_000): Promise<ChartRendered> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`the chart didn't draw ${level}`));
    }, ms);
    const sub = api.events.onChartRendered((rendered) => {
      if (rendered.level !== level) return;
      clearTimeout(timer);
      sub.dispose();
      resolve(rendered);
    });
  });
}

export const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export function tabsFor(uri: vscode.Uri) {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => {
      const input = tab.input;
      return (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) && input.uri.toString() === uri.toString();
    });
}

export const closeAll = async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(200);
};

export function planState(api: ExtensionApi) {
  const state = api.host.state;
  if (state.kind !== 'plan') throw new Error(`expected a plan, got ${state.kind}`);
  return state;
}

export function noWebviewErrors(api: ExtensionApi): void {
  check(api.events.errors.length === 0, `webview reported: ${api.events.errors.join(' | ')}`);
}

export async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
