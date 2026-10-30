import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/history.js';
import { plan, tempDir, toolshed } from './helpers.js';

let root: string;
let store: HistoryStore;
beforeEach(async () => {
  root = await tempDir();
  store = new HistoryStore(join(root, 'data'));
});

describe('a project folder that moves', () => {
  it('picks its history back up when the old folder is gone and the plan matches', async () => {
    const texts = await toolshed();
    const { project } = await store.openProject({ path: join(root, 'old-place'), texts });
    const first = await project.recordSnapshot({ texts, source: 'ui', actor: 'user' });

    const moved = await store.openProject({ path: join(root, 'new-place'), texts });
    expect(moved.status).toBe('relinked');
    expect(moved.previousPath).toBe(join(root, 'old-place'));
    expect(moved.project.record.id).toBe(project.record.id);
    expect(moved.project.record.path).toBe(join(root, 'new-place'));
    await expect(moved.project.listSnapshots()).resolves.toMatchObject([{ id: first.recorded ? first.snapshot.id : '' }]);

    // The new path is what's remembered from now on.
    await expect(store.openProject({ path: join(root, 'new-place'), texts })).resolves.toMatchObject({ status: 'existing' });
  });

  it('still matches a plan edited while or before it moved', async () => {
    const texts = await toolshed();
    const { project } = await store.openProject({ path: join(root, 'old-place'), texts });
    const edited = { ...texts, 'plan/map.yaml': `${texts['plan/map.yaml'] ?? ''}# edited\n` };
    await project.recordSnapshot({ texts: edited, source: 'ui', actor: 'user' });
    await expect(store.openProject({ path: join(root, 'new-place'), texts: edited })).resolves.toMatchObject({ status: 'relinked' });
  });

  it('treats a copy as a new project while the original still exists', async () => {
    const texts = await toolshed();
    await mkdir(join(root, 'original'));
    const { project } = await store.openProject({ path: join(root, 'original'), texts });
    const copy = await store.openProject({ path: join(root, 'copy'), texts });
    expect(copy.status).toBe('new');
    expect(copy.project.record.id).not.toBe(project.record.id);
    await expect(store.listProjects()).resolves.toHaveLength(2);
  });

  it('treats a different plan as a new project even if a folder disappeared', async () => {
    await store.openProject({ path: join(root, 'gone'), texts: await toolshed() });
    await expect(store.openProject({ path: join(root, 'other'), texts: plan('Other', ['x', 'y']) })).resolves.toMatchObject({
      status: 'new',
    });
  });

  it('never relinks an empty plan', async () => {
    await store.openProject({ path: join(root, 'gone'), texts: {} });
    await expect(store.openProject({ path: join(root, 'other'), texts: {} })).resolves.toMatchObject({ status: 'new' });
  });

  it('does not guess between two equally good matches', async () => {
    const texts = await toolshed();
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await store.openProject({ path: join(root, 'a'), texts });
    await store.openProject({ path: join(root, 'b'), texts });
    await rm(join(root, 'a'), { recursive: true });
    await rm(join(root, 'b'), { recursive: true });
    await expect(store.openProject({ path: join(root, 'c'), texts })).resolves.toMatchObject({ status: 'new' });
  });
});
