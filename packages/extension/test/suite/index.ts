// Runs inside a real editor, one scenario per run. Every step is attempted, so one
// failure doesn't hide the rest, and all of them are printed at the end.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { OwnKeyProvider } from '../../src/models/ownKey.js';
import { ModelError, type ChatRequest } from '../../src/models/provider.js';
import { VsCodePlanFiles } from '../../src/vscodePlanFiles.js';
import { startFakeModelServer } from './fakeModelServer.js';
import { codeLinkSteps } from './codeLinks.js';
import { exportPageSteps } from './exportPage.js';
import { journeyScenario } from './journey.js';
import {
  failures,
  step,
  check,
  sleep,
  until,
  nextRender,
  nextChart,
  exists,
  tabsFor,
  closeAll,
  planState,
  noWebviewErrors,
  collect,
} from './helpers.js';

async function planScenario(api: ExtensionApi, rootUri: vscode.Uri, root: string): Promise<void> {
  const map = vscode.Uri.joinPath(rootUri, 'plan', 'map.yaml');
  const bookings = vscode.Uri.joinPath(rootUri, 'plan', 'features', 'bookings.yaml');
  const bookingsPath = join(root, 'plan', 'features', 'bookings.yaml');
  const files = new VsCodePlanFiles(rootUri);

  await step(`the AI SDK streams in this editor's runtime (Node ${process.version})`, async () => {
    const key = 'sk-test-secret-value';
    const server = await startFakeModelServer(key);
    try {
      const request: ChatRequest = { model: 'fake', system: 'Be brief.', messages: [{ role: 'user', text: 'Hi' }], tools: [] };
      const provider = new OwnKeyProvider({ provider: 'custom', key, baseUrl: server.baseUrl });
      const text = await collect(provider.chat(request));
      check(text.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('') === 'OK', `text: ${JSON.stringify(text)}`);
      check(text.at(-1)?.type === 'finish', 'no finish event');
      check(server.authorizations[0] === `Bearer ${key}`, 'the key was not sent');

      const tools = [
        { name: 'add_feature', description: 'Add a feature', inputSchema: { type: 'object', properties: { label: { type: 'string' } } } },
      ];
      const calls = await collect(provider.chat({ ...request, tools }));
      const call = calls.find((e) => e.type === 'tool-call');
      check(
        call?.type === 'tool-call' && call.call.name === 'add_feature' && JSON.stringify(call.call.input) === '{"label":"Fees"}',
        `calls: ${JSON.stringify(calls)}`,
      );

      const wrong = new OwnKeyProvider({ provider: 'custom', key: 'sk-wrong-secret', baseUrl: server.baseUrl });
      const rejected = await collect(wrong.chat(request)).catch((err: unknown) => err);
      check(rejected instanceof ModelError && rejected.code === 'key-rejected', `rejected: ${String(rejected)}`);
      check(rejected instanceof Error && !rejected.message.includes('sk-wrong-secret'), 'the key is in the error');
    } finally {
      await server.close();
    }
  });

  await step('model settings: the fallback, keys in secret storage, a real connection test, user-level settings only', async () => {
    const key = 'sk-test-secret-value';
    const server = await startFakeModelServer(key);
    const { service } = api.host.models;
    try {
      const fresh = await service.view();
      // None of the test profiles has Copilot, so every editor here must offer the own-key route.
      check(fresh.source === 'key' && fresh.editorModels.length === 0, `fallback: ${JSON.stringify(fresh.source)}`);

      await service.update({ provider: 'custom', baseUrl: server.baseUrl, large: 'fake', small: 'missing' });
      await service.saveKey('custom', key);
      const saved = await service.view();
      check(saved.providers.find((p) => p.id === 'custom')?.hasKey === true, 'the key was not saved');
      check(!JSON.stringify(saved).includes(key), 'the key reached the view');
      const onDisk = await readFile(join(rootUri.fsPath, '.vscode', 'settings.json'), 'utf8').catch(() => '');
      check(!onDisk.includes(key) && !onDisk.includes('ideaToCode.models'), 'model settings reached the workspace');

      const [large, small] = await service.test();
      check(large?.ok === true && large.model === 'fake', `large: ${JSON.stringify(large)}`);
      check(small?.ok === false && small.message?.includes("doesn't have this model") === true, `small: ${JSON.stringify(small)}`);
      check(server.authorizations[0] === `Bearer ${key}`, 'the key did not reach its endpoint');

      // A cloned project must not be able to send the key somewhere else.
      const settings = vscode.workspace.getConfiguration('ideaToCode.models');
      await settings.update('baseUrl', 'http://attacker.example/v1', vscode.ConfigurationTarget.Workspace).then(
        () => undefined,
        () => undefined,
      );
      check((await service.view()).baseUrl === server.baseUrl, 'a workspace setting changed the address');

      await service.removeKey('custom');
      check((await service.view()).providers.find((p) => p.id === 'custom')?.hasKey === false, 'the key was not removed');
    } finally {
      await server.close();
      const settings = vscode.workspace.getConfiguration('ideaToCode.models');
      for (const name of ['provider', 'baseUrl', 'tiers']) await settings.update(name, undefined, vscode.ConfigurationTarget.Global);
    }
  });

  await step('finds the plan and summarizes it', async () => {
    await until('a plan', () => api.host.state.kind === 'plan');
    const state = planState(api);
    check(state.folder === 'toolshed', `folder ${state.folder}`);
    check(state.plan.features.length === 5, `${String(state.plan.features.length)} features`);
    check(state.plan.done === 7 && state.plan.total === 15, `progress ${String(state.plan.done)}/${String(state.plan.total)}`);
  });

  await step('the sidebar opens, and opening the plan was recorded as a first version', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.ideaToCode');
    await until('an activity session', () => (planState(api).history?.sessions.length ?? 0) > 0);
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

  await step('an outside process edits a file: the chart updates in place and a snapshot is recorded', async () => {
    const opened = nextChart(api, 'bookings');
    api.showLevel('bookings');
    await opened;
    const history = api.host.service?.projectHistory;
    const before = (await history?.listSnapshots())?.length ?? 0;
    const nodes = planState(api).model.levels.bookings?.nodes.length ?? 0;
    const redrawn = nextChart(api, 'bookings');
    const script = `const fs=require('fs');const f=process.argv[1];const t=fs.readFileSync(f,'utf8');fs.writeFileSync(f,t.replace('    edges:\\n','      - id: added-outside\\n        type: step\\n        label: Added by another tool\\n    edges:\\n'))`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, bookingsPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`outside process exited with ${String(code)}`));
      });
    });
    const rendered = await redrawn;
    check(rendered.nodes === nodes + 1, `${String(rendered.nodes)} nodes, was ${String(nodes)}`);
    check(planState(api).model.levels.bookings?.nodes.some((n) => n.id === 'added-outside') === true, 'not in the model');
    await until('a snapshot of the outside edit', async () => ((await history?.listSnapshots())?.length ?? 0) > before);
    check((await history?.listSnapshots())?.at(-1)?.source === 'external', 'not recorded as external');
    check((await history?.readView())?.level === 'bookings', 'lost the level');
    noWebviewErrors(api);
  });

  await step('a broken file: the rest still draws, the feature is marked, and fixing it recovers', async () => {
    const original = await readFile(bookingsPath, 'utf8');
    const redrawn = nextChart(api, 'overview');
    await writeFile(bookingsPath, 'feature: bookings\nflows: [oops');
    await redrawn;
    const feature = planState(api).model.levels.overview?.nodes.find((n) => n.id === 'bookings');
    check(feature?.broken === true && feature.problems?.[0]?.severity === 'error', JSON.stringify(feature));
    check(
      planState(api).model.levels.overview?.nodes.some((n) => n.id === 'handover' && n.opens === 'handover') === true,
      'other features lost',
    );
    check(
      vscode.languages.getDiagnostics(bookings).some((d) => d.severity === vscode.DiagnosticSeverity.Error),
      'no diagnostic',
    );
    noWebviewErrors(api);
    await writeFile(bookingsPath, original);
    await until('recovery', () => planState(api).model.levels.overview?.nodes.find((n) => n.id === 'bookings')?.broken !== true);
    api.closeApp();
    await closeAll();
  });

  await step('edits from the UI go through operations, are recorded, and refusals explain why', async () => {
    const before = (await api.host.service?.projectHistory?.listSnapshots())?.length ?? 0;
    const added = await api.host.applyEdit('add_feature', { label: 'Added from the app' });
    check(added.ok && added.created?.featureId === 'added-from-the-app', JSON.stringify(added));
    check(
      planState(api).plan.features.some((f) => f.id === 'added-from-the-app'),
      'state not updated by the time the edit answers',
    );
    const last = (await api.host.service?.projectHistory?.listSnapshots())?.at(-1);
    check(
      last?.source === 'ui' && last.actor === 'user' && ((await api.host.service?.projectHistory?.listSnapshots())?.length ?? 0) > before,
      'not recorded',
    );
    const refused = await api.host.applyEdit('set_status', { id: 'nope', status: 'done' });
    check(!refused.ok && (refused.message ?? '').includes('nope'), JSON.stringify(refused));
    check((await api.host.applyEdit('remove_feature', { id: 'added-from-the-app' })).ok, 'not removed');
  });

  await step('history lists changes; restore and undo change the files and update the state', async () => {
    const original = await readFile(bookingsPath, 'utf8');
    check((await api.host.applyEdit('set_status', { id: 'join-waitlist', status: 'done' })).ok, 'edit failed');
    const edited = await readFile(bookingsPath, 'utf8');
    check(edited !== original, 'the edit changed nothing');

    const afterEdit = planState(api).history;
    const newest = afterEdit?.sessions[0]?.entries[0];
    const previous = afterEdit?.sessions.flatMap((s) => s.entries)[1];
    check(newest?.who === 'You' && newest.source === 'ui', `newest change: ${JSON.stringify(newest)}`);
    check(afterEdit?.undo?.latest === newest?.id, 'undo does not point at the newest change');

    check((await api.host.restoreVersion(previous?.id ?? '')).ok, 'restore failed');
    check((await readFile(bookingsPath, 'utf8')) === original, 'restore did not put the file back');
    check(planState(api).history?.sessions[0]?.entries[0]?.source === 'restore', 'no restore entry');

    const stale = await api.host.undo(newest?.id ?? '');
    check(!stale.ok && (await readFile(bookingsPath, 'utf8')) === original, 'undo went ahead on a plan that had moved on');

    const latest = planState(api).history?.undo?.latest ?? '';
    check((await api.host.undo(latest)).ok, 'undoing the restore failed');
    check((await readFile(bookingsPath, 'utf8')) === edited, 'undo did not reverse the restore');

    check((await api.host.undo(planState(api).history?.undo?.latest ?? '')).ok, 'second undo failed');
    check((await readFile(bookingsPath, 'utf8')) === original, 'second undo did not go further back');
  });

  await step('History opens at a session', async () => {
    const [session] = planState(api).history?.sessions ?? [];
    check(session !== undefined, 'no session in history');
    if (!session) return;
    await vscode.commands.executeCommand('ideaToCode.showHistory', session.id);
    check(api.events.errors.length === 0, `page errors: ${api.events.errors.join('; ')}`);
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

  await step('Settings opens from a menu, whatever argument the menu passes', async () => {
    await vscode.commands.executeCommand('ideaToCode.openSettings', { viewId: 'ideaToCode.chat' });
    await vscode.commands.executeCommand('ideaToCode.openSettings', 'chart');
    await vscode.commands.executeCommand('ideaToCode.openSettings', 'models');
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

  await step('VsCodePlanFiles: a reader never finds a file missing while it is rewritten', async () => {
    await files.write('plan/features/scratch.yaml', 'x: 0\n');
    const writes = { done: false };
    let missing = 0;
    const reading = (async () => {
      while (!writes.done) if ((await files.read('plan/features/scratch.yaml')) === null) missing++;
    })();
    for (let i = 1; i <= 100; i++) await files.write('plan/features/scratch.yaml', `x: ${String(i)}\n`);
    writes.done = true;
    await reading;
    await files.remove('plan/features/scratch.yaml');
    check(missing === 0, `missing ${String(missing)} times`);
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

  await step('the chat sidebar opens with no page errors', async () => {
    await vscode.commands.executeCommand('ideaToCode.chat.focus');
    await sleep(1500);
    noWebviewErrors(api);
  });

  await step('the chat plans through tools: one agent version per turn, kept in this editor, chart edits paused meanwhile', async () => {
    const key = 'sk-test-secret-value';
    const server = await startFakeModelServer(key);
    const models = api.host.models.service;
    const history = () => api.host.service?.projectHistory?.listSnapshots() ?? Promise.resolve([]);
    try {
      // One model for both tiers, so no deciding call is made.
      await models.update({ provider: 'custom', baseUrl: server.baseUrl, large: 'fake', small: 'fake' });
      await models.saveKey('custom', key);
      await until('a model', () => api.chat.view().status === 'ready');
      const before = (await history()).length;
      server.script.push(
        {
          text: 'Planning it.',
          calls: [
            {
              name: 'fill_flow',
              input: { flowId: 'reminders', nodes: [{ key: 'a', type: 'step', label: 'Text the borrower' }], edges: [] },
            },
          ],
        },
        { text: 'Reminders is planned.', delayMs: 2000 },
      );
      const turn = api.chat.send('Plan the reminders');
      await until('the change on the chart, before it is written', () => {
        const state = planState(api);
        return state.agentBusy === true && state.plan.features.find((f) => f.id === 'reminders')?.planned === false;
      });
      check(!(await exists(join(root, 'plan', 'features', 'reminders.yaml'))), 'written before the turn ended');
      const refused = await api.host.applyEdit('set_status', { id: 'pick-dates', status: 'done' });
      check(!refused.ok && (refused.message ?? '').includes('agent is working'), `an edit during the turn: ${JSON.stringify(refused)}`);
      await turn;
      const after = await history();
      check(after.length === before + 1, `${String(after.length - before)} versions recorded`);
      check(after.at(-1)?.source === 'agent' && after.at(-1)?.actor === 'built-in agent', `recorded as ${after.at(-1)?.source ?? '?'}`);
      check((await readFile(join(root, 'plan', 'features', 'reminders.yaml'), 'utf8')).includes('Text the borrower'), 'not written');
      await until('edits back on', () => planState(api).agentBusy !== true);
      const index = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(api.chatStorage, 'chats', 'index.json')),
      );
      check(index.includes('Planning'), `chat not kept: ${index}`);
      check(!(await readdir(root)).includes('chats'), 'chats written into the project');
      const items = api.chat.view().items;
      check(items.at(-1)?.kind === 'changes', `items: ${items.map((i) => i.kind).join(', ')}`);

      // Stopped midway: what was done is kept, as one version.
      server.script.push(
        { calls: [{ name: 'set_status', input: { id: 'pick-dates', status: 'in_progress' } }] },
        { text: 'slow', delayMs: 15_000 },
      );
      const stopped = api.chat.send('Start on pick dates');
      await until('the change made', () => planState(api).agentBusy === true && server.bodies.length >= 4);
      await sleep(500);
      api.chat.cancel();
      await stopped;
      const last = (await history()).at(-1);
      check(last?.source === 'agent' && (last.summary ?? '').includes('Pick dates'), `after stopping: ${last?.summary ?? 'nothing'}`);
      noWebviewErrors(api);
    } finally {
      await server.close();
      await models.removeKey('custom');
      const settings = vscode.workspace.getConfiguration('ideaToCode.models');
      for (const name of ['provider', 'baseUrl', 'tiers']) await settings.update(name, undefined, vscode.ConfigurationTarget.Global);
    }
  });
}

function never(): never {
  throw new Error('missing value');
}

async function emptyScenario(api: ExtensionApi, root: string): Promise<void> {
  await step('with no plan, nothing is created and the page offers to start', async () => {
    await api.host.settled();
    check(api.host.state.kind === 'no-plan', api.host.state.kind);
    const rendered = nextRender(api, (r) => r.kind === 'no-plan');
    await vscode.commands.executeCommand('ideaToCode.openApp');
    await rendered;
    noWebviewErrors(api);
    check(!(await exists(join(root, 'plan'))), 'plan folder created');
    api.closeApp();
    await closeAll();
  });

  await step('Initialize creates the map and the guide, only inside plan/, then records history', async () => {
    const rendered = nextRender(api, (r) => r.kind === 'plan');
    await vscode.commands.executeCommand('ideaToCode.initPlan');
    await rendered;
    check((await readFile(join(root, 'plan', 'map.yaml'), 'utf8')).includes('project: toolshed'), 'no map');
    check(await exists(join(root, 'plan', 'GUIDE.md')), 'no guide');
    check((await readdir(root)).join() === 'plan', `wrote outside plan/: ${(await readdir(root)).join(', ')}`);
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
    await vscode.commands.executeCommand('ideaToCode.initPlan');
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
    // The fixture's deliberately missing code link is always there; this is about the typo.
    const typo = () =>
      vscode.languages.getDiagnostics().some(([, list]) => list.some((d) => d.source === 'idea-to-code' && d.code !== 'code-link-missing'));
    await until('diagnostics', typo);
    await writeFile(bookings, original);
    await until('diagnostics to clear', () => !typo());
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
    check(planState(api).history === null, 'history was sent to the page');
    const refused = await api.host.undo('anything');
    check(!refused.ok, 'undo ran in Restricted Mode');
    check(!(await api.host.restoreVersion('anything')).ok, 'restore ran in Restricted Mode');
  });

  await step('edits are refused in Restricted Mode, even if asked for directly', async () => {
    const before = await readFile(join(root, 'plan', 'map.yaml'), 'utf8');
    const result = await api.host.applyEdit('add_feature', { label: 'Sneaky' });
    check(!result.ok, JSON.stringify(result));
    check((await readFile(join(root, 'plan', 'map.yaml'), 'utf8')) === before, 'the map changed');
  });

  await step('Initialize refuses, even when called directly', async () => {
    const before = await readdir(root);
    await vscode.commands.executeCommand('ideaToCode.initPlan').then(
      () => undefined,
      () => undefined,
    );
    check((await readdir(root)).join() === before.join(), 'files were created');
    check(!(await exists(join(root, 'plan', 'GUIDE.md'))), 'guide written');
  });

  await step('the chat is off in Restricted Mode, and takes no message', async () => {
    await until('the chat to see Restricted Mode', () => api.chat.view().status === 'untrusted');
    await api.chat.send('Plan something');
    check(api.chat.view().items.length === 0, 'a message was taken');
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

  const extension = vscode.extensions.getExtension<ExtensionApi>('oyinlola-ojelere.idea-to-code');
  if (!extension) throw new Error('extension not found');
  const api = await extension.activate();
  await api.host.settled();
  console.log(`  optional APIs: ${JSON.stringify(api.optionalApis)}`);

  if (scenario === 'empty') await emptyScenario(api, folder.uri.fsPath);
  else if (scenario === 'restricted') await restrictedScenario(api, folder.uri, folder.uri.fsPath);
  else if (scenario === 'journey') await journeyScenario(api, folder.uri.fsPath);
  else {
    await planScenario(api, folder.uri, folder.uri.fsPath);
    await codeLinkSteps(api, folder.uri.fsPath);
    await exportPageSteps(api, folder.uri.fsPath);
  }

  if (failures.length > 0) throw new Error(`${String(failures.length)} step(s) failed:\n${failures.join('\n')}`);
}
