import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { StoreError } from '../src/errors.js';
import { HistoryStore, type ProjectHistory } from '../src/history.js';
import { plan, tempDir, toolshed } from './helpers.js';

let dir: string;
let project: ProjectHistory;
beforeEach(async () => {
  dir = await tempDir();
  ({ project } = await new HistoryStore(dir).openProject({ path: '/projects/toolshed', texts: await toolshed() }));
});

describe('registering a project', () => {
  it('writes project.json with path, name, format version and fingerprint', async () => {
    const record = JSON.parse(await readFile(join(project.dir, 'project.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ path: '/projects/toolshed', name: 'Toolshed', formatVersion: 1 });
    expect(record.fingerprint).toContain('bookings');
  });

  it('finds the same project again by its path', async () => {
    const again = await new HistoryStore(dir).openProject({ path: '/projects/toolshed', texts: {} });
    expect(again.status).toBe('existing');
    expect(again.project.record.id).toBe(project.record.id);
  });

  it('never writes into the project folder', async () => {
    const texts = await toolshed();
    await project.recordSnapshot({ texts, source: 'ui', actor: 'user' });
    expect(existsSync('/projects/toolshed')).toBe(false);
  });
});

describe('snapshots', () => {
  it('records source, actor, summary and files, with no parent at first', async () => {
    const r = await project.recordSnapshot({ texts: plan('A'), source: 'mcp', actor: 'claude-code', summary: 'First plan' });
    if (!r.recorded) throw new Error('expected a snapshot');
    expect(r.snapshot).toMatchObject({ parent: null, source: 'mcp', actor: 'claude-code', summary: 'First plan' });
    expect(Object.keys(r.snapshot.files)).toEqual(['plan/map.yaml']);
  });

  it('chains each snapshot to the one before', async () => {
    const a = await project.recordSnapshot({ texts: plan('A'), source: 'ui', actor: 'user' });
    const b = await project.recordSnapshot({ texts: plan('B'), source: 'ui', actor: 'user' });
    if (!a.recorded || !b.recorded) throw new Error('expected snapshots');
    expect(b.snapshot.parent).toBe(a.snapshot.id);
  });

  it('skips a snapshot identical to the latest, whoever records it', async () => {
    const first = await project.recordSnapshot({ texts: plan('A'), source: 'mcp', actor: 'claude-code' });
    const again = await project.recordSnapshot({ texts: plan('A'), source: 'external', actor: 'unknown' });
    if (!first.recorded) throw new Error('expected a snapshot');
    expect(again).toEqual({ recorded: false, latest: first.snapshot });
    await expect(project.listSnapshots()).resolves.toHaveLength(1);
  });

  it('counts a removed file as a change', async () => {
    const two = { ...plan('A'), 'plan/features/alpha.yaml': 'feature: alpha\nflows:\n  main:\n    label: A\n' };
    await project.recordSnapshot({ texts: two, source: 'ui', actor: 'user' });
    const r = await project.recordSnapshot({ texts: plan('A'), source: 'ui', actor: 'user' });
    expect(r.recorded).toBe(true);
  });

  it('reads a snapshot back exactly, comments included', async () => {
    const texts = await toolshed();
    const r = await project.recordSnapshot({ texts, source: 'ui', actor: 'user' });
    if (!r.recorded) throw new Error('expected a snapshot');
    const read = await project.readSnapshot(r.snapshot.id);
    expect(read.files).toEqual(texts);
    expect(read.missing).toEqual([]);
  });

  it('stores a file that did not change only once across snapshots', async () => {
    const shared = 'feature: alpha\nflows:\n  main:\n    label: A\n';
    await project.recordSnapshot({ texts: { ...plan('A'), 'plan/features/alpha.yaml': shared }, source: 'ui', actor: 'user' });
    await project.recordSnapshot({ texts: { ...plan('B'), 'plan/features/alpha.yaml': shared }, source: 'ui', actor: 'user' });
    const dirs = await readdir(join(dir, 'objects'), { recursive: true, withFileTypes: true });
    expect(dirs.filter((e) => e.isFile())).toHaveLength(3);
  });

  it('refuses an unknown snapshot', async () => {
    const failure = await project.readSnapshot('nope').catch((e: unknown) => e);
    expect((failure as StoreError).code).toBe('unknown-snapshot');
  });
});

describe('restore', () => {
  it('creates a new snapshot with the old files, losing nothing', async () => {
    const a = await project.recordSnapshot({ texts: plan('A'), source: 'ui', actor: 'user' });
    const b = await project.recordSnapshot({ texts: plan('B'), source: 'agent', actor: 'built-in' });
    if (!a.recorded || !b.recorded) throw new Error('expected snapshots');

    const r = await project.restore(a.snapshot.id, { actor: 'user' });
    if (!r.recorded) throw new Error('expected a snapshot');
    expect(r.files).toEqual(plan('A'));
    expect(r.snapshot).toMatchObject({ source: 'restore', actor: 'user', parent: b.snapshot.id, restoredFrom: a.snapshot.id });

    const all = await project.listSnapshots();
    expect(all.map((s) => s.id)).toEqual([a.snapshot.id, b.snapshot.id, r.snapshot.id]);
    expect((await project.readSnapshot(b.snapshot.id)).files).toEqual(plan('B'));
    expect((await project.verify()).problems).toEqual([]);
  });

  it('records nothing when restoring what is already the latest, but still returns the files', async () => {
    const a = await project.recordSnapshot({ texts: plan('A'), source: 'ui', actor: 'user' });
    if (!a.recorded) throw new Error('expected a snapshot');
    const r = await project.restore(a.snapshot.id, { actor: 'user' });
    expect(r.recorded).toBe(false);
    expect(r.files).toEqual(plan('A'));
  });
});

describe('view', () => {
  it('remembers the level being viewed', async () => {
    await expect(project.readView()).resolves.toBeNull();
    await project.writeView('take-deposit-flow');
    await expect(project.readView()).resolves.toMatchObject({ level: 'take-deposit-flow' });
  });
});

describe('errors', () => {
  it('uses StoreError for its own failures', async () => {
    const failure = await project.closeSession('nope').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StoreError);
  });
});
