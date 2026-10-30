import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { blobPath } from '../src/blobs.js';
import { HistoryStore } from '../src/history.js';
import { NodePlanFiles } from '../src/nodePlanFiles.js';
import { ProjectService, type ServiceEvent } from '../src/projectService.js';
import { outsideEditorSave, projectFolder, tempDir, toolshed } from './helpers.js';

const UI = { source: 'ui', actor: 'user' } as const;
const BOOKINGS = 'plan/features/bookings.yaml';

let root: string;
let dataDir: string;
let service: ProjectService;
let firstId: string;

beforeEach(async () => {
  root = await projectFolder();
  dataDir = await tempDir();
  service = await ProjectService.open({ files: new NodePlanFiles(root), store: new HistoryStore(dataDir), root });
  firstId = (await service.projectHistory?.listSnapshots())?.[0]?.id ?? '';
});

describe('rollback', () => {
  it('puts the files back, as a new version, losing nothing', async () => {
    await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, UI);
    const events: ServiceEvent[] = [];
    service.onEvent((e) => events.push(e));

    const r = await service.rollback(firstId, { actor: 'user' });
    expect(r).toMatchObject({ ok: true, changed: [BOOKINGS], deleted: [] });
    await expect(service.readPlan()).resolves.toEqual(await toolshed());

    const snapshots = (await service.projectHistory?.listSnapshots()) ?? [];
    expect(snapshots.map((s) => s.source)).toEqual(['external', 'ui', 'restore']);
    expect(snapshots[2]?.restoredFrom).toBe(firstId);
    expect(events).toMatchObject([{ type: 'changed', cause: 'restore', changed: [BOOKINGS] }]);
  });

  it('can be undone by rolling forward again', async () => {
    const edit = await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, UI);
    await service.rollback(firstId, { actor: 'user' });
    if (!edit.ok || !edit.snapshotId) throw new Error('expected a snapshot');
    await service.rollback(edit.snapshotId, { actor: 'user' });
    await expect(readFile(join(root, BOOKINGS), 'utf8')).resolves.toContain('label: Join the waitlist\n        status: done');
  });

  it('brings back a deleted feature file, and removes one that version did not have', async () => {
    await service.apply({ name: 'remove_feature', input: { id: 'handover' } }, UI);
    await service.apply({ name: 'add_feature', input: { label: 'Insurance' } }, UI);
    const r = await service.rollback(firstId, { actor: 'user' });
    expect(r).toMatchObject({ ok: true, deleted: ['plan/features/insurance.yaml'] });
    await expect(readdir(join(root, 'plan/features'))).resolves.toEqual(['bookings.yaml', 'handover.yaml']);
    await expect(service.readPlan()).resolves.toEqual(await toolshed());
  });

  it('records unrecorded outside changes first, so they can be got back', async () => {
    const text = await readFile(join(root, BOOKINGS), 'utf8');
    await outsideEditorSave(root, BOOKINGS, `${text}# unrecorded work\n`);
    await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, UI);
    await outsideEditorSave(root, BOOKINGS, `${await readFile(join(root, BOOKINGS), 'utf8')}# more unrecorded work\n`);

    await service.rollback(firstId, { actor: 'user' });

    const snapshots = (await service.projectHistory?.listSnapshots()) ?? [];
    expect(snapshots.map((s) => s.source)).toEqual(['external', 'external', 'ui', 'external', 'restore']);
    const kept = await service.projectHistory?.readSnapshot(snapshots[3]?.id ?? '');
    expect(kept?.files[BOOKINGS]).toContain('# more unrecorded work');
  });

  it("doesn't touch GUIDE.md or the connector files", async () => {
    await writeFile(join(root, 'plan/GUIDE.md'), 'guide');
    await service.writeProjectFile('AGENTS.md', 'agents');
    await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, UI);
    await service.rollback(firstId, { actor: 'user' });
    await expect(readFile(join(root, 'plan/GUIDE.md'), 'utf8')).resolves.toBe('guide');
    await expect(readFile(join(root, 'AGENTS.md'), 'utf8')).resolves.toBe('agents');
  });

  it('refuses a version with a damaged stored file, leaving the plan as it is', async () => {
    const edit = await service.apply({ name: 'set_status', input: { id: 'join-waitlist', status: 'done' } }, UI);
    const first = await service.projectHistory?.readSnapshot(firstId);
    await rm(blobPath(dataDir, first?.snapshot.files[BOOKINGS] ?? ''));
    const before = await service.readPlan();
    const r = await service.rollback(firstId, { actor: 'user' });
    expect(r).toMatchObject({ ok: false, code: 'blob-missing' });
    expect(!r.ok && r.message).toContain(BOOKINGS);
    await expect(service.readPlan()).resolves.toEqual(before);
    expect(edit.ok).toBe(true);
  });

  it('reports an unknown version', async () => {
    await expect(service.rollback('nope', { actor: 'user' })).resolves.toMatchObject({ ok: false, code: 'unknown-snapshot' });
  });

  it('restoring what is already there changes nothing', async () => {
    const r = await service.rollback(firstId, { actor: 'user' });
    expect(r).toMatchObject({ ok: true, changed: [], deleted: [] });
    await expect(service.projectHistory?.listSnapshots()).resolves.toHaveLength(1);
  });
});
