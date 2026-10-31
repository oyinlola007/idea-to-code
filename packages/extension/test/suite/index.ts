// Runs inside a real editor. Every step is attempted, so one failure doesn't hide
// the rest, and all of them are printed at the end.
import { appendFile, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { VsCodePlanFiles } from '../../src/vscodePlanFiles.js';
import type { ChartRendered } from '../../src/webviewConnection.js';

const failures: string[] = [];

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL ${name}: ${message}`);
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function nextRender(
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

function nextChart(api: ExtensionApi, level: string, ms = 30_000): Promise<ChartRendered> {
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

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

function tabsFor(uri: vscode.Uri) {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => {
      const input = tab.input;
      return (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) && input.uri.toString() === uri.toString();
    });
}

const closeAll = async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(200);
};

function planState(api: ExtensionApi) {
  const state = api.host.state;
  if (state.kind !== 'plan') throw new Error(`expected a plan, got ${state.kind}`);
  return state;
}

function noWebviewErrors(api: ExtensionApi): void {
  check(api.events.errors.length === 0, `webview reported: ${api.events.errors.join(' | ')}`);
}

async function planScenario(api: ExtensionApi, rootUri: vscode.Uri, root: string): Promise<void> {
  const map = vscode.Uri.joinPath(rootUri, 'plan', 'map.yaml');
  const bookings = vscode.Uri.joinPath(rootUri, 'plan', 'features', 'bookings.yaml');
  const bookingsPath = join(root, 'plan', 'features', 'bookings.yaml');
  const files = new VsCodePlanFiles(rootUri);

  await step('finds the plan and summarizes it', async () => {
    await until('a plan', () => api.host.state.kind === 'plan');
    const state = planState(api);
    check(state.folder === 'toolshed', `folder ${state.folder}`);
    check(state.plan.features.length === 5, `${String(state.plan.features.length)} features`);
    check(state.plan.done === 7 && state.plan.total === 15, `progress ${String(state.plan.done)}/${String(state.plan.total)}`);
  });

  await step('sidebar lists features and shows the views', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.ideaToCode');
    const features = api.trees.features.getChildren();
    check(features.length === 5, `${String(features.length)} features`);
    check(api.trees.features.getTreeItem(features[0] ?? never()).command?.command === 'ideaToCode.openApp', 'opens the app');
    await until('an activity session', async () => (await api.trees.sessions.getChildren()).length > 0);
  });

  await step('app tab renders through the validated bridge, with no CSP errors', async () => {
    const rendered = nextRender(api, (r) => r.kind === 'plan' && r.features === 5);
    await vscode.commands.executeCommand('ideaToCode.openApp');
    await rendered;
    noWebviewErrors(api);
    api.closeApp();
    await closeAll();
  });

  await step('the chart draws every level through the blob worker, within 960px', async () => {
    const levels = Object.keys(planState(api).model.levels);
    check(levels.length > 3, `${String(levels.length)} levels`);
    const first = nextChart(api, 'overview');
    await vscode.commands.executeCommand('ideaToCode.openApp');
    const seen = [await first];
    for (const level of levels.filter((l) => l !== 'overview')) {
      const rendered = nextChart(api, level);
      api.showLevel(level);
      seen.push(await rendered);
    }
    for (const r of seen) {
      check(r.workerMode === 'blob', `${r.level} used ${r.workerMode}`);
      check(r.width > 0 && r.width <= 960, `${r.level} is ${String(r.width)}px wide`);
      check(r.nodes > 0, `${r.level} has no nodes`);
    }
    noWebviewErrors(api);
    const history = api.host.service?.projectHistory;
    const last = levels.at(-1);
    await until('the current level in view.json', async () => (await history?.readView())?.level === last);
    api.closeApp();
    await closeAll();
  });

  await step('opening a feature file shows that feature', async () => {
    const rendered = nextChart(api, 'bookings');
    await vscode.commands.executeCommand('vscode.open', bookings);
    await rendered;
    noWebviewErrors(api);
    await closeAll();
  });

  await step('a plan file opens as a chart by default', async () => {
    const rendered = nextRender(api, (r) => r.features === 5);
    await vscode.commands.executeCommand('vscode.open', map);
    await rendered;
    const tabs = tabsFor(map);
    check(tabs.length === 1 && tabs[0]?.input instanceof vscode.TabInputCustom, 'not a custom editor tab');
  });

  await step('"Reopen as text" switches to text', async () => {
    await vscode.commands.executeCommand('ideaToCode.reopenAsText', map);
    await until('a text tab', () => tabsFor(map).some((t) => t.input instanceof vscode.TabInputText));
    await sleep(300);
    const tabs = tabsFor(map);
    check(tabs.length === 1, `${String(tabs.length)} tabs`);
  });

  await step('"Open preview to the side" opens the chart beside the text', async () => {
    const rendered = nextRender(api, (r) => r.features === 5);
    await vscode.commands.executeCommand('ideaToCode.openPreviewToSide', map);
    await rendered;
    const tabs = tabsFor(map);
    check(
      tabs.some((t) => t.input instanceof vscode.TabInputText),
      'text tab gone',
    );
    check(
      tabs.some((t) => t.input instanceof vscode.TabInputCustom),
      'no chart tab',
    );
    await closeAll();
  });

  await step('the "text" setting opens plan files as text, but an explicit preview still works', async () => {
    const config = vscode.workspace.getConfiguration('ideaToCode.planFiles');
    await config.update('openAs', 'text', vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('vscode.open', bookings);
      await until('a text tab', () => tabsFor(bookings).some((t) => t.input instanceof vscode.TabInputText));
      await sleep(300);
      check(tabsFor(bookings).length === 1, `${String(tabsFor(bookings).length)} tabs`);
      const rendered = nextRender(api, (r) => r.features === 5);
      await vscode.commands.executeCommand('ideaToCode.openPreviewToSide', bookings);
      await rendered;
      check(
        tabsFor(bookings).some((t) => t.input instanceof vscode.TabInputCustom),
        'preview was undone',
      );
    } finally {
      await config.update('openAs', undefined, vscode.ConfigurationTarget.Global);
      await closeAll();
    }
  });

  await step('a folder called plan with no real plan quietly opens as text', async () => {
    await mkdir(join(root, 'notes', 'plan', 'features'), { recursive: true });
    const strayPath = join(root, 'notes', 'plan', 'map.yaml');
    await writeFile(strayPath, 'routes: []\n');
    const stray = vscode.Uri.file(strayPath);
    await vscode.commands.executeCommand('vscode.open', stray);
    await until('a text tab', () => tabsFor(stray).some((t) => t.input instanceof vscode.TabInputText));
    await sleep(300);
    check(tabsFor(stray).length === 1, `${String(tabsFor(stray).length)} tabs`);
    await closeAll();
  });

  await step('validation errors become diagnostics, the app updates, and fixing clears them', async () => {
    const original = await readFile(bookingsPath, 'utf8');
    const rendered = nextRender(api, (r) => r.problems > 0);
    const panel = nextRender(api, (r) => r.kind === 'plan');
    await vscode.commands.executeCommand('ideaToCode.openApp');
    await panel;
    await writeFile(bookingsPath, `${original}\nstauts: oops\n`);
    const errors = () => vscode.languages.getDiagnostics(bookings).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    await until('an error diagnostic', () => errors().length > 0);
    check(errors()[0]?.source === 'idea-to-code', 'wrong source');
    await rendered;
    await writeFile(bookingsPath, original);
    await until('the error to clear', () => errors().length === 0);
    api.closeApp();
    await closeAll();
  });

  await step('an outside edit is recorded in history', async () => {
    const history = api.host.service?.projectHistory;
    check(history !== null && history !== undefined, 'no history');
    const before = (await history?.listSnapshots())?.length ?? 0;
    const original = await readFile(bookingsPath, 'utf8');
    await writeFile(bookingsPath, `${original}# a note\n`);
    await until('an external snapshot', async () => ((await history?.listSnapshots())?.length ?? 0) > before);
    check((await history?.listSnapshots())?.at(-1)?.source === 'external', 'not external');
  });

  await step('VsCodePlanFiles: an edit through the service writes the file and records it', async () => {
    const service = api.host.service;
    const result = await service?.apply(
      { name: 'set_status', input: { id: 'record-deposit', status: 'done' } },
      { source: 'ui', actor: 'test' },
    );
    check(result?.ok === true, `apply failed: ${JSON.stringify(result)}`);
    const text = await readFile(bookingsPath, 'utf8');
    check(text.includes('# a note'), 'comment lost');
    const last = (await service?.projectHistory?.listSnapshots())?.at(-1);
    check(last?.source === 'ui' && last.actor === 'test', 'not recorded');
    await until('progress to update', () => planState(api).plan.done === 8);
  });

  await step('VsCodePlanFiles: reads, lists, writes atomically, removes', async () => {
    const listed = await files.listPlanFiles();
    check(listed[0] === 'plan/map.yaml' && listed.includes('plan/features/bookings.yaml'), `listed ${listed.join(',')}`);
    check((await files.read('plan/nope.yaml')) === null, 'missing file read');
    await files.write('plan/features/scratch.yaml', 'x: 1\n');
    check((await files.read('plan/features/scratch.yaml')) === 'x: 1\n', 'not written');
    const names = await readdir(join(root, 'plan', 'features'));
    check(!names.some((n) => n.includes('.tmp-')), `temp file left: ${names.join(',')}`);
    await files.remove('plan/features/scratch.yaml');
    await files.remove('plan/features/scratch.yaml');
    check((await files.read('plan/features/scratch.yaml')) === null, 'not removed');
  });

  await step('VsCodePlanFiles: refuses paths outside the plan and symlinks', async () => {
    const refused = async (path: string) => {
      const outcome = await files.write(path, 'x').then(
        () => 'written',
        () => 'refused',
      );
      check(outcome === 'refused', `${path} was written`);
    };
    await refused('../escape.yaml');
    await refused('src/main.ts');
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(root, 'plan', 'linked'));
    await refused('plan/linked/x.yaml');
    check(!(await exists(join(root, 'elsewhere', 'x.yaml'))), 'written through the link');
  });

  await step('connectors write and remove through the editor', async () => {
    const service = api.host.service;
    check(service !== undefined, 'no service');
    await writeFile(join(root, 'AGENTS.md'), '# Rules\n');
    await service?.setConnector('agents-md', true);
    check((await readFile(join(root, 'AGENTS.md'), 'utf8')).includes('plan/GUIDE.md'), 'not added');
    await service?.setConnector('agents-md', false);
    check((await readFile(join(root, 'AGENTS.md'), 'utf8')) === '# Rules\n', 'not restored');
    await service?.setConnector('cursor-rule', true);
    check(await exists(join(root, '.cursor', 'rules', 'plan.mdc')), 'rule not added');
    await service?.setConnector('cursor-rule', false);
    check(!(await exists(join(root, '.cursor', 'rules', 'plan.mdc'))), 'rule not removed');
  });
}

function never(): never {
  throw new Error('missing value');
}

async function emptyScenario(api: ExtensionApi, root: string): Promise<void> {
  await step('with no plan, nothing is created and the page offers to start', async () => {
    await api.host.settled();
    check(api.host.state.kind === 'no-plan', api.host.state.kind);
    check(api.trees.features.getChildren().length === 0, 'features listed');
    const rendered = nextRender(api, (r) => r.kind === 'no-plan');
    await vscode.commands.executeCommand('ideaToCode.openApp');
    await rendered;
    noWebviewErrors(api);
    check(!(await exists(join(root, 'plan'))), 'plan folder created');
    api.closeApp();
    await closeAll();
  });

  await step('Initialize creates the map, the guide and the chosen connector, then records history', async () => {
    const rendered = nextRender(api, (r) => r.kind === 'plan');
    await vscode.commands.executeCommand('ideaToCode.initPlan', { connectors: ['claude-skill'] });
    await rendered;
    check((await readFile(join(root, 'plan', 'map.yaml'), 'utf8')).includes('project: toolshed'), 'no map');
    check(await exists(join(root, 'plan', 'GUIDE.md')), 'no guide');
    check(await exists(join(root, '.claude', 'skills', 'plan', 'SKILL.md')), 'no skill');
    check(!(await exists(join(root, 'AGENTS.md'))), 'unasked connector');
    const state = planState(api);
    check(
      state.plan.problems.every((p) => p.severity !== 'error'),
      JSON.stringify(state.plan.problems),
    );
    check(((await api.host.service?.projectHistory?.listSnapshots())?.length ?? 0) === 1, 'no first snapshot');
  });

  await step('Initialize again changes nothing in the plan', async () => {
    const map = join(root, 'plan', 'map.yaml');
    await writeFile(map, 'project: Renamed\nfeatures: []\n');
    await vscode.commands.executeCommand('ideaToCode.initPlan', { connectors: ['claude-skill'] });
    check((await readFile(map, 'utf8')) === 'project: Renamed\nfeatures: []\n', 'overwrote the plan');
  });
}

async function restrictedScenario(api: ExtensionApi, rootUri: vscode.Uri, root: string): Promise<void> {
  const data = process.env.IDEA_TO_CODE_DATA ?? never();
  await step('viewing works: plan, app tab and diagnostics', async () => {
    await until('a plan', () => api.host.state.kind === 'plan');
    check(!planState(api).trusted, 'state says trusted');
    const rendered = nextRender(api, (r) => r.features === 5);
    await vscode.commands.executeCommand('ideaToCode.openApp');
    await rendered;
    noWebviewErrors(api);
    const map = vscode.Uri.joinPath(rootUri, 'plan', 'map.yaml');
    const chart = nextRender(api, (r) => r.features === 5);
    api.closeApp();
    await vscode.commands.executeCommand('vscode.open', map);
    await chart;
    check(tabsFor(map)[0]?.input instanceof vscode.TabInputCustom, 'no chart');
    await closeAll();
    const bookings = join(root, 'plan', 'features', 'bookings.yaml');
    const original = await readFile(bookings, 'utf8');
    await writeFile(bookings, `${original}\nstauts: oops\n`);
    await until('diagnostics', () => vscode.languages.getDiagnostics().some(([, list]) => list.some((d) => d.source === 'idea-to-code')));
    await writeFile(bookings, original);
    await until(
      'diagnostics to clear',
      () => !vscode.languages.getDiagnostics().some(([, list]) => list.some((d) => d.source === 'idea-to-code')),
    );
  });

  await step('no history, no service, no trace', async () => {
    check(api.host.service === undefined, 'a service is running');
    const bookings = join(root, 'plan', 'features', 'bookings.yaml');
    await appendFile(bookings, '# a note\n');
    await sleep(3000);
    check(!(await exists(join(data, 'projects'))), 'history was written');
    await api.host.publishLevel('bookings');
    check(!(await exists(join(data, 'projects'))), 'the level was recorded');
    check(!(await exists(join(data, 'objects'))), 'blobs were written');
    check((await api.trees.sessions.getChildren()).length === 0, 'sessions listed');
  });

  await step('Initialize refuses, even when called directly', async () => {
    const before = await readdir(root);
    await vscode.commands.executeCommand('ideaToCode.initPlan', { connectors: ['claude-skill'] }).then(
      () => undefined,
      () => undefined,
    );
    check((await readdir(root)).join() === before.join(), 'files were created');
    check(!(await exists(join(root, 'plan', 'GUIDE.md'))), 'guide written');
  });

  await step('trusting the folder turns everything on, without reopening', async () => {
    api.trust.simulateGrant();
    await until('a service', () => api.host.service !== undefined && planState(api).trusted);
    await until('history', async () => ((await api.host.service?.projectHistory?.listSnapshots())?.length ?? 0) === 1);
    check(await exists(join(data, 'projects')), 'no history on disk');
  });
}

export async function run(): Promise<void> {
  const scenario = process.env.ITC_SCENARIO ?? 'plan';
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  console.log(`suite: ${scenario} in ${vscode.env.appName} ${vscode.version}`);

  const extension = vscode.extensions.getExtension<ExtensionApi>('idea-to-code.idea-to-code');
  if (!extension) throw new Error('extension not found');
  const api = await extension.activate();
  await api.host.settled();
  console.log(`  optional APIs: ${JSON.stringify(api.optionalApis)}`);

  if (scenario === 'empty') await emptyScenario(api, folder.uri.fsPath);
  else if (scenario === 'restricted') await restrictedScenario(api, folder.uri, folder.uri.fsPath);
  else await planScenario(api, folder.uri, folder.uri.fsPath);

  if (failures.length > 0) throw new Error(`${String(failures.length)} step(s) failed:\n${failures.join('\n')}`);
}
