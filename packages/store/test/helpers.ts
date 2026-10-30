import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
