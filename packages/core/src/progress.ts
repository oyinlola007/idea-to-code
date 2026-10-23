// Done/total progress. Only step and component nodes carry work; a node with
// a child flow counts as that flow's work, so parent progress is always computed.
import type { Project } from './load.js';
import { WORK_TYPES } from './schema.js';
import { indexProject, type ProjectIndex } from './validate.js';

export interface Progress {
  done: number;
  total: number;
}

/** Done/total over work nodes; a node with a child flow counts as that flow's work. */
export function flowProgress(index: ProjectIndex, flowId: string, seen = new Set<string>()): Progress {
  const ref = index.flows.get(flowId);
  if (!ref || seen.has(flowId)) return { done: 0, total: 0 };
  seen.add(flowId);
  const sum: Progress = { done: 0, total: 0 };
  for (const node of ref.flow.nodes) {
    if (!WORK_TYPES.has(node.type)) continue;
    const child = 'expands' in node && node.expands ? index.flows.get(node.expands) : undefined;
    if (child?.parentNodeId === node.id) {
      const p = flowProgress(index, child.id, seen);
      sum.done += p.done;
      sum.total += p.total;
    } else {
      sum.total += 1;
      if ('status' in node && node.status === 'done') sum.done += 1;
    }
  }
  return sum;
}

/** The rollup key for the whole plan: every feature plus the top-level components. */
export const OVERVIEW = 'overview';

/** Progress for every flow, every feature (0/0 when it has no flows yet), and the overview. */
export function rollup(project: Project): Map<string, Progress> {
  const index = indexProject(project);
  const out = new Map<string, Progress>();
  for (const id of index.flows.keys()) out.set(id, flowProgress(index, id));
  for (const id of index.features.keys()) if (!out.has(id)) out.set(id, { done: 0, total: 0 });
  const overview: Progress = { done: 0, total: 0 };
  for (const id of index.features.keys()) {
    const p = out.get(id) ?? { done: 0, total: 0 };
    overview.done += p.done;
    overview.total += p.total;
  }
  for (const component of index.components.values()) {
    overview.total += 1;
    if (component.status === 'done') overview.done += 1;
  }
  out.set(OVERVIEW, overview);
  return out;
}
