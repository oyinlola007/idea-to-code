import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const tempDir = () => mkdtemp(join(tmpdir(), 'itc-store-test-'));

/** A small valid plan; `extra` adds features, so different plans have different IDs. */
export function plan(name: string, features: string[] = ['alpha', 'beta', 'gamma']): Record<string, string> {
  return {
    'plan/map.yaml': `project: ${name}\nfeatures:\n${features.map((f) => `  - id: ${f}\n    label: ${f}\n`).join('')}`,
  };
}

/** The committed fictitious plan from core's tests. */
export async function toolshed(): Promise<Record<string, string>> {
  const root = fileURLToPath(new URL('../../core/test/fixtures/toolshed/plan/', import.meta.url));
  const texts: Record<string, string> = { 'plan/map.yaml': await readFile(join(root, 'map.yaml'), 'utf8') };
  for (const name of await readdir(join(root, 'features')))
    texts[`plan/features/${name}`] = await readFile(join(root, 'features', name), 'utf8');
  return texts;
}

/** A project folder holding the Toolshed plan. */
export async function projectFolder(): Promise<string> {
  const root = await tempDir();
  for (const [path, text] of Object.entries(await toolshed())) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  return root;
}

/** How an outside editor saves: a temp file, then a rename over the real one. */
export async function outsideEditorSave(root: string, path: string, text: string): Promise<void> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  const temp = `${full}.editor-tmp`;
  await writeFile(temp, text);
  await rename(temp, full);
}
