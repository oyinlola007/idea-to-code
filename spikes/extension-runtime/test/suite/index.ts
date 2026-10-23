// Runs inside each editor (VS Code, Cursor, VSCodium, older VS Code builds)
// via @vscode/test-electron. Every step is recorded, pass or fail, so one
// editor's results form a column of the matrix even when a step breaks.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SpikeApi } from '../../src/host/extension.js';
import type { RuntimeReport } from '../../src/host/detect.js';
import { appDataDir } from '../../src/store/appData.js';
import { Store } from '../../src/store/cas.js';

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

const steps: Step[] = [];
const quick = process.env.ITC_QUICK === '1';

async function step(name: string, fn: () => Promise<unknown>) {
  const started = Date.now();
  await appendFile(join(process.env.ITC_RESULTS_DIR!, 'log.txt'), `  ${process.env.ITC_TARGET}: ${name}…\n`).catch(() => {});
  try {
    const detail = await fn();
    steps.push({ name, ok: true, ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
  }
}

function once<T>(event: vscode.Event<T>, pred: (v: T) => boolean, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`timed out after ${ms}ms waiting for ${what}`));
    }, ms);
    const sub = event((v) => {
      if (pred(v)) {
        clearTimeout(timer);
        sub.dispose();
        resolve(v);
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Rendered = Parameters<Parameters<SpikeApi['events']['rendered']['event']>[0]>[0];
type Failed = Parameters<Parameters<SpikeApi['events']['workerFailed']['event']>[0]>[0];

/** The first rendered (or every mode failing) from the given session. */
function nextRender(api: SpikeApi, session: (s: string) => boolean, ms = 30_000): Promise<Rendered | { failed: Failed[] }> {
  const failed: Failed[] = [];
  return new Promise((resolve, reject) => {
    const subs: vscode.Disposable[] = [];
    const done = (v: Rendered | { failed: Failed[] } | Error) => {
      clearTimeout(timer);
      subs.forEach((s) => s.dispose());
      if (v instanceof Error) reject(v);
      else resolve(v);
    };
    const timer = setTimeout(() => (failed.length ? done({ failed }) : done(new Error(`no render within ${ms}ms`))), ms);
    subs.push(api.events.rendered.event((r) => session(r.session) && done(r)));
    subs.push(
      api.events.workerFailed.event((f) => {
        if (!session(f.session)) return;
        failed.push(f);
        // In a forced mode one failure is final; in auto, wait for the next mode.
        const mode = vscode.workspace.getConfiguration('ideaToCode.spike').get<string>('workerMode');
        if (mode !== 'auto') setTimeout(() => done({ failed }), 200);
      }),
    );
  });
}

async function setSetting(section: string, key: string, value: unknown) {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

async function reopenPanel(api: SpikeApi, start?: string) {
  api.closePlanPanel();
  await sleep(300);
  const pending = nextRender(api, (s) => s === 'panel');
  await vscode.commands.executeCommand('ideaToCode.openPlan', start);
  return pending;
}

export async function run(): Promise<void> {
  const resultsDir = process.env.ITC_RESULTS_DIR!;
  const label = process.env.ITC_TARGET ?? 'unknown';
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let api: SpikeApi | undefined;
  let report: RuntimeReport | undefined;
  await mkdir(resultsDir, { recursive: true });
  await appendFile(join(resultsDir, 'log.txt'), `${label}: suite started in ${vscode.env.appName} ${vscode.version}\n`);

  await step('activate', async () => {
    const ext = vscode.extensions.getExtension<SpikeApi>('idea-to-code.idea-to-code-spike');
    if (!ext) throw new Error('extension not found');
    api = await ext.activate();
    if (!api?.events) throw new Error('activate() returned no API');
    return { workspace: root };
  });
  if (!api) return finish(resultsDir, label, report);
  const a = api;

  await step('runtime report (LM API, MCP API)', async () => {
    report = (await vscode.commands.executeCommand('ideaToCode.spike.runtimeReport', { silent: true })) as RuntimeReport;
    return { app: `${report.appName} ${report.vscodeVersion}`, lm: report.lm, mcp: report.mcp };
  });

  await step('activity bar view', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.ideaToCode');
  });

  await step('plan tab renders (auto worker mode)', async () => {
    const r = await reopenPanel(a);
    if ('failed' in r) throw new Error(`every worker mode failed: ${JSON.stringify(r.failed)}`);
    if (r.nodes === 0) throw new Error('rendered 0 nodes');
    return { level: r.level, nodes: r.nodes, workerMode: r.workerMode, layoutMs: Math.round(r.layoutMs) };
  });

  // Forced modes are findings, not pass/fail: auto mode above is what must work.
  const modes: Record<string, unknown> = {};
  for (const mode of ['blob', 'url', 'main'] as const) {
    await setSetting('ideaToCode.spike', 'workerMode', mode);
    try {
      const r = await reopenPanel(a);
      modes[mode] = 'failed' in r ? { works: false, error: r.failed.map((f) => f.error).join('; ').slice(0, 200) } : { works: true, layoutMs: Math.round(r.layoutMs) };
    } catch (err) {
      modes[mode] = { works: false, error: (err as Error).message };
    }
  }
  steps.push({ name: 'worker modes (finding)', ok: true, ms: 0, detail: modes });
  await setSetting('ideaToCode.spike', 'workerMode', 'auto');

  await step('navigate to a deep level', async () => {
    const pending = nextRender(a, (s) => s === 'panel');
    a.currentPanel()?.session.navigate('pick-template-flow');
    const r = await pending;
    if ('failed' in r || r.level !== 'pick-template-flow') throw new Error(`rendered ${JSON.stringify(r)}`);
    return { level: r.level, nodes: r.nodes };
  });

  await step('custom editor: map.yaml opens as a chart', async () => {
    const uri = vscode.Uri.file(join(root!, 'plan', 'map.yaml'));
    const pending = nextRender(a, (s) => s.startsWith('editor-'));
    await vscode.commands.executeCommand('vscode.openWith', uri, 'ideaToCode.planEditor');
    const r = await pending;
    if ('failed' in r || r.level !== 'overview') throw new Error(`rendered ${JSON.stringify(r)}`);
    return { level: r.level };
  });

  await step('custom editor is the default for feature files', async () => {
    const uri = vscode.Uri.file(join(root!, 'plan', 'features', 'job-search.yaml'));
    const pending = nextRender(a, (s) => s.startsWith('editor-'));
    await vscode.commands.executeCommand('vscode.open', uri);
    const r = await pending;
    if ('failed' in r || r.level !== 'job-search') throw new Error(`rendered ${JSON.stringify(r)}`);
    return { level: r.level };
  });

  await step('"Show YAML" reopens as text', async () => {
    await vscode.commands.executeCommand('ideaToCode.showSource');
    await sleep(800);
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc?.uri.fsPath.endsWith('job-search.yaml')) throw new Error(`active editor is ${doc?.uri.fsPath ?? 'none'}`);
  });

  await step('"Open Chart to the Side" from the text editor', async () => {
    const pending = nextRender(a, (s) => s.startsWith('editor-'));
    await vscode.commands.executeCommand('ideaToCode.openPreviewToSide');
    const r = await pending;
    if ('failed' in r) throw new Error('no render');
    return { level: r.level };
  });

  await step('live reload on save', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await reopenPanel(a);
    const file = join(root!, 'plan', 'features', 'job-search.yaml');
    const text = await readFile(file, 'utf8');
    const pending = nextRender(a, (s) => s === 'panel', 10_000);
    await writeFile(file, text.replace('label: Search jobs', 'label: Search jobs (edited)'));
    const r = await pending;
    if ('failed' in r) throw new Error('no render after the edit');
    return { level: r.level };
  });

  if (!quick) {
    await step('store: 1,000 interleaved writes (extension + Node script)', async () => {
      const storeDir = join(appDataDir(), 'store');
      const writer = join(__dirname, '..', 'store-writer.mjs');
      const child = new Promise<string>((resolve, reject) => {
        const p = spawn(process.execPath, [writer, '--dir', storeDir, '--project', 'stress', '--count', '500', '--tag', 'node-script'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`writer exited ${code}: ${out}`))));
      });
      const [ext, script] = await Promise.all([vscode.commands.executeCommand('ideaToCode.spike.storeStress', 500, 'stress'), child]);
      const store = new Store(storeDir, 'stress');
      const { records } = await store.readIndex();
      const v = await store.verify();
      if (v.problems.length) throw new Error(v.problems.slice(0, 5).join('; '));
      if (v.records !== 1000) throw new Error(`expected 1000 records, got ${v.records}`);
      const switches = records.filter((r, i) => i > 0 && r.writer !== records[i - 1]!.writer).length;
      return { extension: ext, script, records: v.records, blobs: v.blobs, writerSwitches: switches };
    });

    await step('store: stale lock from a dead process is recovered', async () => {
      const storeDir = join(appDataDir(), 'store');
      const store = new Store(storeDir, 'stale');
      await mkdir(store.projectDir, { recursive: true });
      const dead = spawn(process.execPath, ['-e', ''], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      await new Promise((r) => dead.on('exit', r));
      await writeFile(store.lockPath, JSON.stringify({ pid: dead.pid, host: hostname(), at: Date.now(), token: 'planted' }));
      const started = Date.now();
      await vscode.commands.executeCommand('ideaToCode.spike.storeStress', 10, 'stale');
      const v = await store.verify();
      if (v.problems.length) throw new Error(v.problems.join('; '));
      return { recoveredMs: Date.now() - started, records: v.records };
    });
  }

  if (process.env.ITC_DUMP_THEMES === '1') {
    const themes: [string, string][] = [
      ['light', 'Default Light Modern'],
      ['dark', 'Default Dark Modern'],
      ['hc-dark', 'Default High Contrast'],
      ['hc-light', 'Default High Contrast Light'],
    ];
    const out = process.env.ITC_THEMES_DIR!;
    await mkdir(out, { recursive: true });
    for (const [slug, theme] of themes) {
      await step(`theme variables: ${theme}`, async () => {
        await setSetting('workbench', 'colorTheme', theme);
        await sleep(1500);
        const session = a.currentPanel()?.session;
        if (!session) throw new Error('no plan tab');
        const pending = once(a.events.themeVars.event, (t) => t.session === 'panel', 10_000, 'theme variables');
        session.post({ type: 'dumpTheme' });
        const t = await pending;
        await writeFile(join(out, `${slug}.json`), JSON.stringify({ bodyClass: t.bodyClass, vars: t.vars }, null, 2));
        return { bodyClass: t.bodyClass, vars: Object.keys(t.vars).length };
      });
    }
  }

  await finish(resultsDir, label, report);
}

async function finish(dir: string, label: string, report: RuntimeReport | undefined) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${label}.json`), JSON.stringify({ target: label, app: report ? `${report.appName} ${report.vscodeVersion}` : vscode.version, report, steps }, null, 2));
  await appendFile(join(dir, 'log.txt'), `${label}: ${steps.filter((s) => s.ok).length}/${steps.length} steps passed\n`);
  const failed = steps.filter((s) => !s.ok);
  if (failed.length) throw new Error(`${failed.length} step(s) failed: ${failed.map((s) => s.name).join(', ')}`);
}
