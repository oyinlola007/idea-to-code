// Which project the server works on: --root if given, otherwise the nearest folder
// with a plan, from where the agent started it up to the home folder. With no plan
// yet, a new one goes at the top of the git repository, or else where it started.
// Some clients start servers in the home folder or at /, where a plan must never be created.
import { realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type ProjectRoot = { root: string; found: boolean } | { error: string };

const HINT = 'Start the server in your project folder, or pass --root <folder>.';

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

async function hasPlan(folder: string): Promise<boolean> {
  return stat(join(folder, 'plan', 'map.yaml')).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** A .git folder, or a .git file in a worktree or submodule. */
async function isRepoTop(folder: string): Promise<boolean> {
  return stat(join(folder, '.git')).then(
    () => true,
    () => false,
  );
}

async function real(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

export async function findProjectRoot(options: { start: string; home: string; root?: string | undefined }): Promise<ProjectRoot> {
  if (options.root !== undefined) {
    const root = await real(resolve(options.start, options.root));
    if (!(await isDirectory(root))) return { error: `--root ${options.root} isn't a folder.` };
    return { root, found: await hasPlan(root) };
  }

  const start = await real(options.start);
  const home = await real(options.home);
  let repoTop: string | undefined;
  for (let folder = start; ; folder = dirname(folder)) {
    if (await hasPlan(folder)) return { root: folder, found: true };
    const outside = folder === home || dirname(folder) === folder;
    if (outside) break;
    if (repoTop === undefined && (await isRepoTop(folder))) repoTop = folder;
  }
  if (repoTop !== undefined) return { root: repoTop, found: false };
  if (start === home || dirname(start) === start) return { error: `No plan found from ${start}. ${HINT}` };
  return { root: start, found: false };
}
