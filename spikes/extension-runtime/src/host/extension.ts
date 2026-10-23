// Spike entry point: the activity bar view, the plan tab, the custom editor,
// and two spike commands (runtime report, store stress).
import { join } from 'node:path';
import * as vscode from 'vscode';
import { appDataDir } from '../store/appData.js';
import { sampleFiles, Store } from '../store/cas.js';
import { allSessions, chartEvents } from './chartSession.js';
import { openPreviewToSide, registerPlanEditor, showSource } from './customEditor.js';
import { runtimeReport, saveReport, type RuntimeReport } from './detect.js';
import { closePlanPanel, currentPanel, openPlanPanel, registerPanelSerializer } from './panel.js';
import { registerSidebar } from './sidebar.js';

export interface SpikeApi {
  events: typeof chartEvents;
  currentPanel: typeof currentPanel;
  closePlanPanel: typeof closePlanPanel;
  sessions: typeof allSessions;
  report(): Promise<RuntimeReport>;
}

export function activate(context: vscode.ExtensionContext): SpikeApi {
  const log = vscode.window.createOutputChannel('idea-to-code (spike)', { log: true });
  let firstRender: RuntimeReport['webview'] = {};

  context.subscriptions.push(
    log,
    ...registerSidebar(),
    registerPanelSerializer(context, log),
    registerPlanEditor(context, log),
    chartEvents.rendered.event((r) => {
      if (!firstRender.workerMode) firstRender = { workerMode: r.workerMode, layoutMs: r.layoutMs };
    }),
    vscode.commands.registerCommand('ideaToCode.openPlan', (start?: string) => openPlanPanel(context, log, start)),
    vscode.commands.registerCommand('ideaToCode.openPreviewToSide', openPreviewToSide),
    vscode.commands.registerCommand('ideaToCode.showSource', showSource),
    vscode.commands.registerCommand('ideaToCode.spike.runtimeReport', async (opts?: { silent?: boolean }) => {
      const report = await runtimeReport(firstRender);
      const path = await saveReport(report);
      log.info(`runtime report written to ${path}`);
      if (!opts?.silent) {
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
      return report;
    }),
    vscode.commands.registerCommand('ideaToCode.spike.storeStress', async (count = 500, project = 'stress') => {
      const store = new Store(join(appDataDir(), 'store'), project);
      const started = Date.now();
      for (let seq = 0; seq < count; seq++) await store.appendSnapshot(sampleFiles(seq, 'extension'), { writer: 'extension', seq });
      const result = { written: count, ms: Date.now() - started, dir: store.dir };
      log.info(`store stress: ${count} writes in ${result.ms}ms to ${store.dir}`);
      return result;
    }),
  );

  void runtimeReport().then(
    (r) => log.info(`${r.appName} ${r.vscodeVersion}: lm=${r.lm.present} (${r.lm.models.length} models), mcp=${r.mcp.present}`),
    (err) => log.error(`runtime report failed: ${(err as Error).message}`),
  );

  return {
    events: chartEvents,
    currentPanel,
    closePlanPanel,
    sessions: allSessions,
    report: () => runtimeReport(firstRender),
  };
}

export function deactivate() {}
