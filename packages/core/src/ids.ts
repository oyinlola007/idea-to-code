// Readable slug IDs. An ID is generated once from a label and never changes,
// even when the label does; history, diffs and references all depend on that.
import type { Project } from './load.js';
import { OVERVIEW } from './progress.js';
import { MAIN } from './validate.js';

export function slugify(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return slug || 'item';
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Every ID in use, plus the reserved ones: "main" (a flow key) and "overview" (the chart's root level). */
export function allIds(project: Project): Set<string> {
  const ids = new Set<string>([MAIN, OVERVIEW]);
  for (const f of project.map?.data?.features ?? []) ids.add(f.id);
  for (const c of project.map?.data?.components ?? []) ids.add(c.id);
  for (const file of project.features) {
    if (!file.data) continue;
    ids.add(file.data.feature);
    for (const [key, flow] of Object.entries(file.data.flows)) {
      ids.add(key);
      for (const n of flow.nodes) ids.add(n.id);
    }
  }
  return ids;
}
