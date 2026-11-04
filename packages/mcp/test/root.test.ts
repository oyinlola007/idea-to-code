import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectRoot } from '../src/root.js';

let base: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'itc-root-test-')));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function folder(...parts: string[]): Promise<string> {
  const path = join(base, ...parts);
  await mkdir(path, { recursive: true });
  return path;
}

async function planIn(path: string): Promise<void> {
  await mkdir(join(path, 'plan'), { recursive: true });
  await writeFile(join(path, 'plan', 'map.yaml'), 'project: X\nfeatures: []\n');
}

describe('finding the project root', () => {
  it('finds the plan from a folder inside the project', async () => {
    const project = await folder('home', 'app');
    await planIn(project);
    const start = await folder('home', 'app', 'src', 'ui');
    expect(await findProjectRoot({ start, home: join(base, 'home') })).toEqual({ root: project, found: true });
  });

  it('never looks above the home folder', async () => {
    await planIn(base);
    const start = await folder('home', 'app');
    expect(await findProjectRoot({ start, home: join(base, 'home') })).toEqual({ root: start, found: false });
  });

  it('starts in the folder it was given when there is no plan yet', async () => {
    const start = await folder('home', 'new-app');
    expect(await findProjectRoot({ start, home: join(base, 'home') })).toEqual({ root: start, found: false });
  });

  it('refuses to start a plan in the home folder', async () => {
    const home = await folder('home');
    expect(await findProjectRoot({ start: home, home })).toEqual({ error: expect.stringContaining('--root') as string });
  });

  it('still uses a plan in the home folder itself', async () => {
    const home = await folder('home');
    await planIn(home);
    expect(await findProjectRoot({ start: home, home })).toEqual({ root: home, found: true });
  });

  it('takes --root over the folder it started in, relative to it', async () => {
    const project = await folder('elsewhere', 'app');
    await planIn(project);
    const start = await folder('home');
    expect(await findProjectRoot({ start, home: start, root: '../elsewhere/app' })).toEqual({ root: project, found: true });
  });

  it('refuses a --root that is not a folder', async () => {
    const start = await folder('home');
    expect(await findProjectRoot({ start, home: start, root: 'missing' })).toEqual({ error: expect.stringContaining('missing') as string });
  });
});
