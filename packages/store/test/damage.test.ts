import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { blobPath } from '../src/blobs.js';
import type { StoreError } from '../src/errors.js';
import { HistoryStore, type ProjectHistory } from '../src/history.js';
import { plan, tempDir } from './helpers.js';

let dir: string;
let project: ProjectHistory;
beforeEach(async () => {
  dir = await tempDir();
  ({ project } = await new HistoryStore(dir).openProject({ path: '/projects/p', texts: plan('P') }));
});

const record = async (name: string) => {
  const r = await project.recordSnapshot({ texts: plan(name), source: 'ui', actor: 'user' });
  if (!r.recorded) throw new Error('expected a snapshot');
  return r.snapshot;
};

describe('a damaged history', () => {
  it('skips a half-written last line and keeps the rest', async () => {
    const a = await record('A');
    await appendFile(join(project.dir, 'index.jsonl'), '{"type":"snapshot","id":"half');
    await expect(project.listSnapshots()).resolves.toMatchObject([{ id: a.id }]);
    expect((await project.verify()).damagedLines).toBe(1);
  });

  it('keeps recording after a half-written line, without merging into it', async () => {
    const a = await record('A');
    await appendFile(join(project.dir, 'index.jsonl'), '{"type":"snapshot","id":"half');
    const b = await record('B');
    expect(b.parent).toBe(a.id);
    const lines = (await readFile(join(project.dir, 'index.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(lines.filter((l) => l.includes('"half'))).toEqual(['{"type":"snapshot","id":"half']);
    await expect(project.listSnapshots()).resolves.toHaveLength(2);
  });

  it('skips lines it does not understand, such as from a newer version', async () => {
    await record('A');
    await appendFile(join(project.dir, 'index.jsonl'), '{"type":"something-new","at":1}\nnot json\n');
    await expect(project.listSnapshots()).resolves.toHaveLength(1);
    expect((await project.verify()).damagedLines).toBe(2);
  });

  it('makes only the affected version unavailable when a blob is missing', async () => {
    const a = await record('A');
    const b = await record('B');
    const hash = a.files['plan/map.yaml'] ?? '';
    await rm(blobPath(dir, hash));
    const read = await project.readSnapshot(a.id);
    expect(read.missing).toEqual(['plan/map.yaml']);
    expect(read.files).toEqual({});
    await expect(project.readSnapshot(b.id)).resolves.toMatchObject({ missing: [] });
    expect((await project.verify()).problems.join(' ')).toContain('missing or damaged');
  });

  it('treats a corrupt blob the same way', async () => {
    const a = await record('A');
    await writeFile(blobPath(dir, a.files['plan/map.yaml'] ?? ''), 'garbage');
    await expect(project.readSnapshot(a.id)).resolves.toMatchObject({ missing: ['plan/map.yaml'] });
  });

  it('refuses to restore a version with a missing file, rather than restoring part of a plan', async () => {
    const a = await record('A');
    await record('B');
    await rm(blobPath(dir, a.files['plan/map.yaml'] ?? ''));
    const failure = await project.restore(a.id, { actor: 'user' }).catch((e: unknown) => e);
    expect((failure as StoreError).code).toBe('blob-missing');
    await expect(project.listSnapshots()).resolves.toHaveLength(2);
  });

  it('can still record new versions when an old one is damaged', async () => {
    const a = await record('A');
    await rm(blobPath(dir, a.files['plan/map.yaml'] ?? ''));
    await expect(record('B')).resolves.toMatchObject({ parent: a.id });
  });

  it('treats a damaged view file as no view', async () => {
    await writeFile(join(project.dir, 'view.json'), '{oops');
    await expect(project.readView()).resolves.toBeNull();
  });

  it('ignores an unreadable project record, keeping the others working', async () => {
    const bad = join(dir, 'projects', 'broken');
    await mkdir(bad);
    await writeFile(join(bad, 'project.json'), 'nope');
    const store = new HistoryStore(dir);
    await expect(store.listProjects()).resolves.toHaveLength(1);
    await expect(store.openProject({ path: '/projects/p', texts: {} })).resolves.toMatchObject({ status: 'existing' });
  });

  it('reports a clean history as clean', async () => {
    await record('A');
    await record('B');
    await expect(project.verify()).resolves.toMatchObject({ snapshots: 2, damagedLines: 0, problems: [] });
  });
});
