// Where to look after a change: the one level that shows all of it, and the cards
// there that changed or lead down to a change. A change on one level opens that
// level; a change across levels opens the highest level they share.
import { z } from 'zod';
import { diffProjects, type Change, type PlanDiff } from './diff.js';
import type { Project } from './load.js';
import { OVERVIEW } from './progress.js';
import { buildViewModel, type LevelId, type ViewModel } from './viewModel.js';

export const Reveal = z.strictObject({
  level: z.string().max(200),
  ids: z.array(z.string().max(200)).max(500),
});
export type Reveal = z.infer<typeof Reveal>;

/** The cards a change touches on its own level; none when it's the level itself, or gone. */
function cardsOf(change: Change): string[] {
  switch (change.kind) {
    case 'feature-added':
    case 'feature-changed':
    case 'component-added':
    case 'component-changed':
    case 'node-added':
    case 'node-changed':
    case 'node-moved':
    case 'status-changed':
      return [change.id];
    case 'connection-added':
    case 'connection-changed':
    case 'connection-removed':
    case 'edge-added':
    case 'edge-changed':
    case 'edge-removed':
      return [change.from, change.to];
    default:
      return [];
  }
}

/** The longest start of `path` whose levels all still exist. */
function existing(path: string[], model: ViewModel): string[] {
  const end = path.findIndex((level) => !(level in model.levels));
  return end === -1 ? path : path.slice(0, end);
}

export function revealOf(diff: PlanDiff, model: ViewModel): Reveal | null {
  const points = diff.changes.map((change) => ({ path: existing(change.path, model), cards: cardsOf(change) }));
  const first = points[0];
  if (!first) return null;

  let shared = first.path.length > 0 ? first.path : [OVERVIEW];
  for (const { path } of points) {
    let i = 0;
    while (i < shared.length && i < path.length && shared[i] === path[i]) i++;
    shared = shared.slice(0, Math.max(i, 1));
  }
  const level: LevelId = shared.at(-1) ?? OVERVIEW;
  const nodes = model.levels[level]?.nodes ?? [];
  const here = new Set(nodes.map((node) => node.id));

  const ids = new Set<string>();
  for (const { path, cards } of points) {
    if (path.length <= shared.length) {
      for (const id of cards) if (here.has(id)) ids.add(id);
      continue;
    }
    // Deeper down: the card that opens the next level on the way.
    const below = path[shared.length];
    const card = nodes.find((node) => node.opens === below);
    if (card) ids.add(card.id);
  }
  // A level that's new is all new: opening it says so, and ringing every card would be noise.
  if (diff.changes.some((change) => change.kind === 'flow-added' && change.id === level)) return { level, ids: [] };
  return { level, ids: nodes.filter((node) => ids.has(node.id)).map((node) => node.id) };
}

/** Where to look after the plan went from `before` to `after`. */
export function revealChanges(before: Project, after: Project): Reveal | null {
  return revealOf(diffProjects(before, after), buildViewModel(after));
}
