// Which project the server works on: --root if given, otherwise the nearest folder
// with a plan, from where the agent started it up to the home folder. Some clients
// start servers in the home folder or at /, where a plan must never be created.
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
  for (let folder = start; ; folder = dirname(folder)) {
    if (await hasPlan(folder)) return { root: folder, found: true };
    if (folder === home || dirname(folder) === folder) break;
  }
  if (start === home || dirname(start) === start) return { error: `No plan found from ${start}. ${HINT}` };
  return { root: start, found: false };
}
