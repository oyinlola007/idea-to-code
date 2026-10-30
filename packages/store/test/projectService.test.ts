import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/history.js';
import { NodePlanFiles } from '../src/nodePlanFiles.js';
import { ProjectService, type ServiceEvent } from '../src/projectService.js';
import { projectFolder, tempDir, toolshed } from './helpers.js';

const UI = { source: 'ui', actor: 'user' } as const;
const BOOKINGS = 'plan/features/bookings.yaml';

let root: string;
let dataDir: string;
let service: ProjectService;
let events: ServiceEvent[];

const open = (at = root) => ProjectService.open({ files: new NodePlanFiles(at), store: new HistoryStore(dataDir), root: at });

beforeEach(async () => {
  root = await projectFolder();
  dataDir = await tempDir();
  service = await open();
  events = [];
  service.onEvent((e) => events.push(e));
});

describe('opening a project', () => {
  it('records the first version', async () => {
    const snapshots = await service.projectHistory?.listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots?.[0]).toMatchObject({ source: 'external', summary: 'First version recorded' });
    expect(service.openStatus.status).toBe('new');
  });

  it('records nothing when reopening an unchanged project', async () => {
    const again = await open();
    expect(again.openStatus.status).toBe('existing');
    await expect(again.projectHistory?.listSnapshots()).resolves.toHaveLength(1);
  });

  it('records nothing for a folder with no plan yet', async () => {
    const empty = await open(await tempDir());
    await expect(empty.projectHistory?.listSnapshots()).resolves.toEqual([]);
  });
});

describe('applying an operation', () => {
  it('goes validate, write, snapshot, event', async () => {
    const r = await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, UI);
    if (!r.ok) throw new Error(r.message);
    expect(r.changed).toEqual([BOOKINGS]);
    expect(r.summary).toBe("'Join the waitlist' → done");
    await expect(readFile(join(root, BOOKINGS), 'utf8')).resolves.toContain('label: Join the waitlist\n        status: done');

    const snapshots = (await service.projectHistory?.listSnapshots()) ?? [];
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ id: r.snapshotId, source: 'ui', actor: 'user', summary: r.summary });
    expect(events).toEqual([
      { type: 'changed', cause: 'operation', summary: r.summary, snapshotId: r.snapshotId, changed: [BOOKINGS], deleted: [] },
    ]);
  });

  it('refuses an invalid edit, touching nothing', async () => {
    const before = await readFile(join(root, BOOKINGS), 'utf8');
    const r = await service.apply({ name: 'set_status', input: { id: 'tool-available', status: 'done' } }, UI);
    expect(r).toMatchObject({ ok: false, code: 'rejected' });
    await expect(readFile(join(root, BOOKINGS), 'utf8')).resolves.toBe(before);
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('creates and deletes feature files on disk', async () => {
    const added = await service.apply({ name: 'add_feature', input: { label: 'Insurance' } }, UI);
    expect(added.ok).toBe(true);
    await expect(readFile(join(root, 'plan/features/insurance.yaml'), 'utf8')).resolves.toContain('feature: insurance');
    const removed = await service.apply({ name: 'remove_feature', input: { id: 'insurance' } }, UI);
    expect(removed).toMatchObject({ ok: true, deleted: ['plan/features/insurance.yaml'] });
    await expect(readdir(join(root, 'plan/features'))).resolves.not.toContain('insurance.yaml');
  });

  it('records a chat edit under its session', async () => {
    const chat = await service.projectHistory?.openSession({ kind: 'chat', editor: 'Cursor' });
    const r = await service.apply(
      { name: 'add_node', input: { flowId: 'bookings', type: 'step', label: 'X' } },
      { source: 'agent', actor: 'built-in', sessionId: chat?.id ?? '' },
    );
    if (!r.ok) throw new Error(r.message);
    expect((await service.projectHistory?.listSnapshots())?.at(-1)).toMatchObject({ session: chat?.id, source: 'agent' });
  });

  it('keeps the edit and records it under activity if the chat session has closed', async () => {
    const chat = await service.projectHistory?.openSession({ kind: 'chat', editor: 'Cursor' });
    await service.projectHistory?.closeSession(chat?.id ?? '');
    const r = await service.apply(
      { name: 'add_node', input: { flowId: 'bookings', type: 'step', label: 'X' } },
      { source: 'agent', actor: 'built-in', sessionId: chat?.id ?? '' },
    );
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings.join(' ')).toContain('outside the chat session');
    expect((await service.projectHistory?.listSnapshots())?.at(-1)?.session).not.toBe(chat?.id);
  });

  it("doesn't lose edits from two services working at once", async () => {
    const other = await open();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? service : other).apply({ name: 'add_node', input: { flowId: 'bookings', type: 'step', label: `Concurrent ${i}` } }, UI),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const text = await readFile(join(root, BOOKINGS), 'utf8');
    for (let i = 0; i < 12; i++) expect(text).toContain(`label: Concurrent ${i}\n`);
    const check = await service.projectHistory?.verify();
    expect(check?.problems).toEqual([]);
    expect(check?.snapshots).toBe(13);
  });

  it('writes connector files through the same allow-list, outside plan history', async () => {
    await service.writeProjectFile('AGENTS.md', 'hello');
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe('hello');
    await expect(service.writeProjectFile('../x', 'y')).rejects.toThrow(/refused/);
    await expect(service.sync()).resolves.toEqual([]);
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(1);
  });

  it('opening a project changes nothing on disk', async () => {
    await expect(service.readPlan()).resolves.toEqual(await toolshed());
  });
});
