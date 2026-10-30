import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodePlanFiles } from '../src/nodePlanFiles.js';
import { UnsafePathError } from '../src/paths.js';
import { projectFolder, tempDir } from './helpers.js';

describe('NodePlanFiles', () => {
  it('lists only the map and feature files', async () => {
    const root = await projectFolder();
    await writeFile(join(root, 'plan', 'GUIDE.md'), 'guide');
    await writeFile(join(root, 'plan', 'features', 'notes.txt'), 'notes');
    await expect(new NodePlanFiles(root).listPlanFiles()).resolves.toEqual([
      'plan/map.yaml',
      'plan/features/bookings.yaml',
      'plan/features/handover.yaml',
    ]);
  });

  it('copes with no plan at all', async () => {
    const files = new NodePlanFiles(await tempDir());
    await expect(files.listPlanFiles()).resolves.toEqual([]);
    await expect(files.read('plan/map.yaml')).resolves.toBeNull();
  });

  it('writes atomically, creating folders and leaving no temp files', async () => {
    const root = await tempDir();
    const files = new NodePlanFiles(root);
    await files.write('plan/features/x.yaml', 'one');
    await files.write('plan/features/x.yaml', 'two');
    await expect(files.read('plan/features/x.yaml')).resolves.toBe('two');
    await expect(readdir(join(root, 'plan', 'features'))).resolves.toEqual(['x.yaml']);
  });

  it('removes a file, and a missing file is fine', async () => {
    const root = await projectFolder();
    const files = new NodePlanFiles(root);
    await files.remove('plan/features/handover.yaml');
    await files.remove('plan/features/handover.yaml');
    await expect(files.read('plan/features/handover.yaml')).resolves.toBeNull();
  });

  it('refuses paths outside the allowed set', async () => {
    const files = new NodePlanFiles(await tempDir());
    await expect(files.write('../escape.yaml', 'x')).rejects.toThrow(UnsafePathError);
    await expect(files.write('src/index.ts', 'x')).rejects.toThrow(UnsafePathError);
    await expect(files.remove('package.json')).rejects.toThrow(UnsafePathError);
  });

  it('refuses a symbolic link that leads out of the project, writing nothing there', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await symlink(outside, join(root, 'plan'));
    await expect(new NodePlanFiles(root).write('plan/map.yaml', 'x')).rejects.toThrow(/symbolic link/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('notices a change made by another program', async () => {
    const root = await projectFolder();
    const files = new NodePlanFiles(root);
    const noticed = new Promise<void>((resolve) => {
      const stop = files.watch(() => {
        stop();
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(join(root, 'plan', 'map.yaml'), `${await readFile(join(root, 'plan', 'map.yaml'), 'utf8')}# edit\n`);
    await expect(noticed).resolves.toBeUndefined();
  });

  it('notices a plan folder appearing later', async () => {
    const root = await tempDir();
    const files = new NodePlanFiles(root);
    const noticed = new Promise<void>((resolve) => {
      const stop = files.watch(() => {
        stop();
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    await mkdir(join(root, 'plan'));
    await expect(noticed).resolves.toBeUndefined();
  });
});
