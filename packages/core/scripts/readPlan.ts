// Reads a project's plan files from disk, keyed by relative path, for the dev
// CLI and the tests. Lives outside src/ because core itself does no I/O.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FEATURES_DIR, MAP_PATH } from '../src/load.js';

export async function readPlanTexts(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  try {
    files[MAP_PATH] = await readFile(join(root, MAP_PATH), 'utf8');
  } catch {
    // A missing map is reported by the validator.
  }
  let names: string[] = [];
  try {
    names = await readdir(join(root, FEATURES_DIR));
  } catch {
    // No features folder yet.
  }
  for (const name of names.filter((n) => n.endsWith('.yaml')).sort()) {
    files[`${FEATURES_DIR}/${name}`] = await readFile(join(root, FEATURES_DIR, name), 'utf8');
  }
  return files;
}
