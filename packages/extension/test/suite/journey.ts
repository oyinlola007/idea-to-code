// The whole journey in one run, from an empty folder: the first chat message starts
// the plan and plans three levels deep, drill down, mark the deepest step done, an outside agent
// edits through the bundled MCP server, then Undo and restoring an earlier version.
import type { Reveal } from '@idea-to-code/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { startFakeModelServer, type FakeModelServer } from './fakeModelServer.js';
import { check, closeAll, nextChart, noWebviewErrors, planState, step, until } from './helpers.js';

const KEY = 'sk-test-journey';
/** The levels the chat creates, from the overview down. IDs come from labels, so they're known in advance. */
const LEVELS = ['overview', 'bookings', 'pay-deposit-flow', 'charge-the-card-flow'];

function nextReveal(api: ExtensionApi, ms = 15_000): Promise<Reveal> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error('the change was never pointed out on the chart'));
    }, ms);
    const sub = api.host.onDidReveal((reveal) => {
      clearTimeout(timer);
      sub.dispose();
      resolve(reveal);
    });
  });
}

const snapshots = async (api: ExtensionApi) => (await api.host.service?.projectHistory?.listSnapshots()) ?? [];

export async function journeyScenario(api: ExtensionApi, root: string): Promise<void> {
  const read = (path: string) => readFile(join(root, path), 'utf8');
  let server: FakeModelServer | undefined;
  let afterChat: string | undefined;

  await step('1-2. the first chat message in an empty folder starts the plan, then plans three levels in one turn', async () => {
    server = await startFakeModelServer(KEY);
    const models = api.host.models.service;
    // One model for both tiers, so no deciding call is made.
    await models.update({ provider: 'custom', baseUrl: server.baseUrl, large: 'fake', small: 'fake' });
    await models.saveKey('custom', KEY);
    await until('a model', () =>
      models.model('large').then(
        () => true,
        () => false,
      ),
    );
    check(api.chat.view().status === 'no-plan', `the chat shows ${api.chat.view().status}`);
    const node = (key: string, label: string) => ({ key, type: 'step', label });
    server.script.push(
      {
        text: 'Planning it.',
        calls: [
          { name: 'add_feature', input: { label: 'Bookings' } },
          { name: 'add_feature', input: { label: 'Payments' } },
          {
            name: 'fill_flow',
            input: {
              flowId: 'bookings',
              nodes: [node('pick', 'Pick dates'), node('pay', 'Pay deposit')],
              edges: [{ from: 'pick', to: 'pay' }],
            },
          },
        ],
      },
      {
        calls: [
          { name: 'expand_node', input: { id: 'pay-deposit' } },
          {
            name: 'fill_flow',
            input: {
              flowId: 'pay-deposit-flow',
              nodes: [node('card', 'Charge the card'), node('receipt', 'Send a receipt')],
              edges: [{ from: 'card', to: 'receipt' }],
            },
          },
        ],
      },
      {
        calls: [
          { name: 'expand_node', input: { id: 'charge-the-card' } },
          {
            name: 'fill_flow',
            input: {
              flowId: 'charge-the-card-flow',
              nodes: [node('auth', 'Authorise'), node('capture', 'Capture')],
              edges: [{ from: 'auth', to: 'capture' }],
            },
          },
        ],
      },
      { text: 'Bookings is planned three levels deep.' },
    );
    await api.chat.send('Plan bookings with payments');
    check(api.host.state.kind === 'plan', 'no plan started');
    const after = await snapshots(api);
    // The plan's first version, then one for the whole turn.
    check(after.length === 2, `${String(after.length)} versions for a new plan and one turn`);
    check(after.at(-1)?.source === 'agent', `recorded as ${after.at(-1)?.source ?? 'nothing'}`);
    afterChat = after.at(-1)?.id;
    const levels = planState(api).model.levels;
    for (const level of LEVELS) check(level in levels, `no level ${level}: ${Object.keys(levels).join(', ')}`);
    check((await read('plan/map.yaml')).includes('label: Payments'), 'Payments not written');
  });

  await step('3. drilling down three levels draws each one', async () => {
    const first = nextChart(api, 'overview');
    await vscode.commands.executeCommand('ideaToCode.openApp');
    const drawn = [await first];
    for (const level of LEVELS.slice(1)) {
      const rendered = nextChart(api, level);
      api.showLevel(level);
      drawn.push(await rendered);
    }
    for (const r of drawn) check(r.nodes > 0 && r.width > 0, `${r.level}: ${String(r.nodes)} nodes, ${String(r.width)}px`);
    await until('the deepest level in view.json', async () => (await api.host.service?.projectHistory?.readView())?.level === LEVELS[3]);
    noWebviewErrors(api);
  });

  await step('4. marking the deepest step done rolls progress up through every level', async () => {
    const result = await api.host.applyEdit('set_status', { id: 'authorise', status: 'done' });
    check(result.ok, JSON.stringify(result));
    await until('the change in the model', () => planState(api).model.levels[LEVELS[3] ?? '']?.progress.done === 1);
    const levels = planState(api).model.levels;
    for (const level of LEVELS) check((levels[level]?.progress.done ?? 0) >= 1, `${level} shows no progress`);
    const last = (await snapshots(api)).at(-1);
    check(last?.source === 'ui' && last.actor === 'user', `recorded as ${last?.source ?? 'nothing'}`);
  });

  await step('5. an outside agent edits through the bundled MCP server: recorded, pointed out, named', async () => {
    const extension = vscode.extensions.getExtension('oyinlola-ojelere.idea-to-code');
    check(extension !== undefined, 'extension not found');
    const env = { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(extension?.extensionPath ?? '', 'dist', 'mcp.mjs'), '--root', root],
      env,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    const revealed = nextReveal(api);
    await client.connect(transport);
    try {
      const outline = await client.callTool({ name: 'get_outline', arguments: {} });
      check(JSON.stringify(outline.content).includes('Payments'), 'the agent read another plan');
      const edit = await client.callTool({ name: 'update_node', arguments: { id: 'send-a-receipt', label: 'Email a receipt' } });
      check(edit.isError !== true, JSON.stringify(edit.content));
    } finally {
      await client.close();
    }
    const reveal = await revealed;
    check(
      reveal.level === 'pay-deposit-flow' && reveal.ids.join() === 'send-a-receipt',
      `pointed out ${reveal.level}: ${reveal.ids.join(', ')}`,
    );
    const last = (await snapshots(api)).at(-1);
    check(last?.source === 'mcp' && last.actor === 'claude-code', `recorded as ${last?.source ?? '?'} by ${last?.actor ?? '?'}`);
    await until('History to name the agent', () =>
      (planState(api).history?.sessions ?? []).some((s) => s.entries.some((e) => e.who === 'Claude Code')),
    );
  });

  await step('6. Undo reverses the agent’s edit, then restoring goes back to straight after the chat', async () => {
    const latest = planState(api).history?.undo?.latest;
    check(latest !== undefined, 'nothing to undo');
    check((await api.host.undo(latest ?? '')).ok, 'undo failed');
    const flow = await read('plan/features/bookings.yaml');
    check(flow.includes('label: Send a receipt') && !flow.includes('Email a receipt'), 'the agent’s edit is still there');
    await until('the model to follow, with the done mark kept', () => {
      const levels = planState(api).model.levels;
      const receipt = levels['pay-deposit-flow']?.nodes.find((n) => n.id === 'send-a-receipt');
      return receipt?.label === 'Send a receipt' && levels[LEVELS[3] ?? '']?.progress.done === 1;
    });

    check((await api.host.restoreVersion(afterChat ?? '')).ok, 'restore failed');
    const restored = await read('plan/features/bookings.yaml');
    check(!restored.includes('status: done'), 'the done mark is still there');
    check(restored.includes('label: Send a receipt') && restored.includes('charge-the-card-flow'), 'the chat’s plan is gone');
    await until('the chart model to follow', () => planState(api).model.levels[LEVELS[3] ?? '']?.progress.done === 0);
    check(
      planState(api).plan.problems.every((p) => p.severity !== 'error'),
      JSON.stringify(planState(api).plan.problems),
    );
    noWebviewErrors(api);
  });

  await step('7. an outside agent links the code it wrote, and validate finds nothing missing', async () => {
    const extension = vscode.extensions.getExtension('oyinlola-ojelere.idea-to-code');
    await mkdir(join(root, 'src', 'payments'), { recursive: true });
    await writeFile(join(root, 'src', 'payments', 'capture.ts'), 'export function capture(): void {}\n');
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(extension?.extensionPath ?? '', 'dist', 'mcp.mjs'), '--root', root],
        env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: '1' },
        stderr: 'ignore',
      }),
    );
    try {
      const linked = await client.callTool({ name: 'link_code', arguments: { id: 'capture', paths: ['src/payments/capture.ts'] } });
      check(linked.isError !== true, JSON.stringify(linked.content));
      const checked = JSON.stringify((await client.callTool({ name: 'validate', arguments: {} })).content);
      check(!checked.includes('code-link-missing'), checked);
    } finally {
      await client.close();
    }
    await until('the link on the chart', () =>
      (planState(api).model.levels['charge-the-card-flow']?.nodes.find((n) => n.id === 'capture')?.code ?? []).some(
        (c) => c.missing !== true,
      ),
    );
  });

  api.closeApp();
  await closeAll();
  await server?.close();
  await api.host.models.service.removeKey('custom');
  const settings = vscode.workspace.getConfiguration('ideaToCode.models');
  for (const name of ['provider', 'baseUrl', 'tiers']) await settings.update(name, undefined, vscode.ConfigurationTarget.Global);
}
