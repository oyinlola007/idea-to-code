// One plain sentence for a history entry, e.g. "2 nodes added in Bookings;
// 'Pick dates' → done". Specific about what people look for (renames, status,
// moves), and counts for the rest, so it stays short however big the change.
import type { Change, PlanDiff } from './diff.js';

const MAX_PARTS = 6;
const COUNT_ORDER = [
  'node added',
  'node changed',
  'node removed',
  'connection added',
  'connection changed',
  'connection removed',
  'detail changed',
];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function isRename(change: Change): boolean {
  return 'fields' in change && change.fields.length === 1 && change.fields[0]?.field === 'label';
}

export function summarizeDiff(diff: PlanDiff): string {
  const parts: string[] = [];
  const add = (part: string) => parts.push(part);

  const addedFlows = new Set<string>();
  const removedFlows = new Set<string>();
  for (const c of diff.changes) {
    if (c.kind === 'flow-added') addedFlows.add(c.id);
    if (c.kind === 'flow-removed') removedFlows.add(c.id);
  }

  // Named changes come first: they're what people look for.
  for (const c of diff.changes) {
    if (c.kind === 'feature-added') add(`Added feature '${c.label}'`);
    if (c.kind === 'feature-removed') add(`Removed feature '${c.label}'`);
    if (c.kind === 'component-added') add(`Added component '${c.label}'`);
    if (c.kind === 'component-removed') add(`Removed component '${c.label}'`);
    if (c.kind === 'flow-added' && !diff.changes.some((o) => o.kind === 'feature-added' && o.id === c.id))
      add(`Added flow '${c.label}' with ${plural(c.nodes, 'node')}`);
    if (c.kind === 'flow-removed' && !diff.changes.some((o) => o.kind === 'feature-removed' && o.id === c.id))
      add(`Removed flow '${c.label}'`);
    if ((c.kind === 'feature-changed' || c.kind === 'component-changed' || c.kind === 'node-changed') && isRename(c)) {
      add(`Renamed '${c.fields[0]?.from ?? ''}' to '${c.label}'`);
    }
    if (c.kind === 'status-changed') add(`'${c.label}' → ${c.to.replace('_', ' ')}`);
    if (c.kind === 'node-moved') add(`Moved '${c.label}' to ${c.toFlowLabel}`);
  }

  // Everything else is counted per level, leaving out what a new or removed flow already says.
  const groups = new Map<string, { label: string; counts: Map<string, number> }>();
  const count = (c: Change, what: string) => {
    const group = groups.get(c.level) ?? { label: c.levelLabel, counts: new Map<string, number>() };
    group.counts.set(what, (group.counts.get(what) ?? 0) + 1);
    groups.set(c.level, group);
  };
  for (const c of diff.changes) {
    if (addedFlows.has(c.level) || removedFlows.has(c.level)) continue;
    if (c.kind === 'node-added') count(c, 'node added');
    if (c.kind === 'node-removed') count(c, 'node removed');
    if (c.kind === 'node-changed' && !isRename(c)) count(c, 'node changed');
    if (c.kind === 'edge-added' || c.kind === 'connection-added') count(c, 'connection added');
    if (c.kind === 'edge-removed' || c.kind === 'connection-removed') count(c, 'connection removed');
    if (c.kind === 'edge-changed' || c.kind === 'connection-changed') count(c, 'connection changed');
    if (
      (c.kind === 'feature-changed' || c.kind === 'component-changed' || c.kind === 'flow-changed' || c.kind === 'project-changed') &&
      !isRename(c)
    )
      count(c, 'detail changed');
  }
  for (const { label, counts } of groups.values()) {
    const bits = COUNT_ORDER.flatMap((what) => {
      const n = counts.get(what);
      if (n === undefined) return [];
      const [noun = what, verb = ''] = what.split(' ');
      return [`${plural(n, noun)} ${verb}`];
    });
    add(`${bits.join(', ')} in ${label}`);
  }

  for (const file of diff.unreadable) add(`couldn't compare ${file}, which can't be read`);

  if (parts.length === 0) return 'No changes';
  const shown = parts.slice(0, MAX_PARTS);
  const hidden = parts.length - shown.length;
  return shown.join('; ') + (hidden > 0 ? `; and ${plural(hidden, 'more change')}` : '');
}
