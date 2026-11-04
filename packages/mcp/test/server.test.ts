// The server end to end below the transport: a real MCP client over an in-memory
// link, with real plan files and real history in temp folders.
import { OPERATIONS } from '@idea-to-code/core';
import { HistoryStore } from '@idea-to-code/store';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type McpPlanServer } from '../src/server.js';

const TOOLSHED = fileURLToPath(new URL('../../core/test/fixtures/toolshed', import.meta.url));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done();
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'itc-mcp-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(options: { plan?: boolean; clientName?: string } = {}) {
  const root = await temp();
  if (options.plan ?? true) await cp(join(TOOLSHED, 'plan'), join(root, 'plan'), { recursive: true });
  const store = new HistoryStore(await temp());
  const mcp: McpPlanServer = createServer({ root, store, log: () => undefined });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverSide);
  const client = new Client({ name: options.clientName ?? 'claude-code', version: '1.0.0' });
  await client.connect(clientSide);
  cleanup.push(async () => {
    await client.close();
    await mcp.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content.map((c) => c.text).join('\n'), isError: result.isError === true };
  };
  const history = async () => (await store.openProject({ path: root, texts: {} })).project;
  const snapshots = async () => (await history()).listSnapshots();
  const read = (path: string) => readFile(join(root, path), 'utf8');
  return { root, client, call, history, snapshots, read };
}

describe('the tools', () => {
  it('lists reading first, then its own, then every plan operation, each with an object schema', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'list_features',
      'get_outline',
      'get_flow',
      'get_current_view',
      'validate',
      'init_plan',
      ...OPERATIONS.map((op) => op.name),
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('get_flow')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('remove_node')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('add_node')?.annotations?.destructiveHint).toBe(false);
  });

  it('tells the agent how to work with the plan when it connects', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain('get_current_view');
  });
});

describe('reading', () => {
  it('returns the outline as plan data', async () => {
    const { call } = await connect();
    const outline = await call('get_outline');
    expect(outline.isError).toBe(false);
    expect(outline.text).toMatch(/^<plan>\n[\s\S]*Bookings[\s\S]*<\/plan>$/);
  });

  it('answers a bad read with an error the agent can fix', async () => {
    const { call } = await connect();
    const flow = await call('get_flow', {});
    expect(flow.isError).toBe(true);
    expect(flow.text).toContain('flowId');
  });
});

describe('changing the plan', () => {
  it('writes the change and records it under the client’s name', async () => {
    const { call, read, snapshots } = await connect();
    const result = await call('add_node', { flowId: 'bookings', type: 'step', label: 'Check the deposit' });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^ok\.\ncreated: \{"nodeId":"[a-z-]+"\}\nsaved: plan\/features\/bookings\.yaml$/);
    expect(await read('plan/features/bookings.yaml')).toContain('label: Check the deposit');
    expect((await snapshots()).at(-1)).toMatchObject({ source: 'mcp', actor: 'claude-code' });
  });

  it('refuses a change it can’t make, with the reason, and leaves the files alone', async () => {
    const { call, read } = await connect();
    const before = await read('plan/features/bookings.yaml');
    const result = await call('set_status', { id: 'no-such-step', status: 'done' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^error \[not-found\]: .*no-such-step.*Fix the call and try again\.$/);
    expect(await read('plan/features/bookings.yaml')).toBe(before);
  });

  it('records a hand edit made since the last change first, as an outside edit', async () => {
    const { root, call, read, snapshots } = await connect();
    await call('get_outline');
    const before = (await snapshots()).length;
    await writeFile(join(root, 'plan/map.yaml'), (await read('plan/map.yaml')).replace('label: Reminders', 'label: Text reminders'));
    await call('set_status', { id: 'record-deposit', status: 'done' });
    const recorded = (await snapshots()).slice(before);
    expect(recorded.map((s) => s.source)).toEqual(['external', 'mcp']);
  });

  it('applies calls sent together one after the other', async () => {
    const { call, snapshots } = await connect();
    await call('get_outline');
    const before = (await snapshots()).length;
    const results = await Promise.all([call('add_feature', { label: 'Fees' }), call('add_feature', { label: 'Reviews' })]);
    expect(results.map((r) => r.isError)).toEqual([false, false]);
    expect((await snapshots()).length).toBe(before + 2);
  });

  it('records a client without a name as unknown', async () => {
    const { call, snapshots } = await connect({ clientName: '' });
    await call('add_feature', { label: 'Fees' });
    expect((await snapshots()).at(-1)).toMatchObject({ source: 'mcp', actor: 'unknown' });
  });
});

describe('where the user is', () => {
  it('names the level open in the chart, and how to read it', async () => {
    const { call, history } = await connect();
    await call('get_outline');
    await (await history()).writeView('bookings');
    const view = await call('get_current_view');
    expect(view.text).toContain('get_flow {"flowId": "bookings"}');
    expect(view.text).toMatch(/<plan>\nToolshed > Bookings\n<\/plan>$/);
  });

  it('says when the app isn’t showing anything', async () => {
    const { call } = await connect();
    expect((await call('get_current_view')).text).toContain("isn't showing");
  });
});

describe('checking the plan', () => {
  it('finds no errors in a good plan, and lists what is still to do', async () => {
    const { call } = await connect();
    expect((await call('validate')).text).toMatch(/^No errors, 3 warnings:\n<plan>\nplan\/map\.yaml:7:5 warning feature-without-flows: /);
  });

  it('says so when there is nothing at all', async () => {
    const { call } = await connect({ plan: false });
    await call('init_plan');
    expect((await call('validate')).text).toBe('No problems.');
  });

  it('lists each problem with its file and line', async () => {
    const { root, call, read } = await connect();
    await writeFile(join(root, 'plan/map.yaml'), (await read('plan/map.yaml')).replace('  - id: catalogue', '  - id: bookings'));
    const result = await call('validate');
    expect(result.text).toMatch(/^2 errors, 2 warnings:\n<plan>\n/);
    expect(result.text).toMatch(/^plan\/map\.yaml:13:5 error duplicate-id: id "bookings" is already used/m);
  });
});

describe('starting a plan', () => {
  it('points the agent at init_plan when there is no plan', async () => {
    const { call } = await connect({ plan: false });
    const outline = await call('get_outline');
    expect(outline).toEqual({ isError: true, text: expect.stringContaining('init_plan') as string });
  });

  it('creates the map and the guide, then works like any plan', async () => {
    const { root, call, read } = await connect({ plan: false });
    expect((await call('init_plan', { project: 'Garden share' })).isError).toBe(false);
    expect(await read('plan/map.yaml')).toContain('project: Garden share');
    await expect(stat(join(root, 'plan/GUIDE.md'))).resolves.toBeTruthy();
    expect((await call('add_feature', { label: 'Plots' })).isError).toBe(false);
    expect((await call('list_features')).text).toContain('Plots');
  });

  it('never replaces a plan that is already there', async () => {
    const { call, read } = await connect();
    const before = await read('plan/map.yaml');
    expect((await call('init_plan')).isError).toBe(true);
    expect(await read('plan/map.yaml')).toBe(before);
  });
});
