import { fileURLToPath } from 'node:url';
import { loadFromTexts, type Project } from '../src/load.js';
import { readPlanTexts } from '../scripts/readPlan.js';

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export async function loadFixture(name: string): Promise<Project> {
  return loadFromTexts(await readPlanTexts(fixturePath(name)));
}
