// What the history panel and the sidebar show: snapshots grouped into sessions, with
// who made each change in words. Pure, so it's tested without files.
import type { HistoryEntry, HistorySession, HistoryView } from '@idea-to-code/core';
import type { Session, Snapshot } from './events.js';

/** Enough to scroll back through a long stretch of work, without sending the whole log on every refresh. */
export const MAX_LISTED_CHANGES = 300;

const FOUND = 'Already in the folder';

function whoMade(snapshot: Snapshot): string {
  switch (snapshot.source) {
    case 'ui':
      return 'You';
    case 'agent':
      return 'Built-in agent';
    case 'mcp':
      return `${snapshot.actor} via MCP`;
    case 'external':
      return snapshot.parent === null ? FOUND : 'Outside edit';
    case 'restore':
      return snapshot.actor === 'user' ? 'You' : snapshot.actor;
    case 'repair':
      return 'Repair';
  }
}

function summaryOf(snapshot: Snapshot): string {
  if (snapshot.summary === undefined) return 'Changed the plan';
  // Comments and spacing aren't part of the plan, so the comparison finds nothing to name.
  return snapshot.summary === 'No changes' ? 'Only comments or formatting changed' : snapshot.summary;
}

function sameFiles(a: Snapshot, b: Snapshot | undefined): boolean {
  if (!b) return false;
  const paths = Object.keys(a.files);
  return paths.length === Object.keys(b.files).length && paths.every((path) => a.files[path] === b.files[path]);
}

/**
 * What Undo would reverse, and the version that brings back. An Undo holds what the version it
 * restored holds, so it's stepped through: a second Undo goes further back, not forward again.
 * A restore the user asked for is a change like any other, so Undo reverses it.
 */
export function undoStep(snapshots: readonly Snapshot[]): { undoing: Snapshot; target: Snapshot } | null {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  let undoing = snapshots.at(-1);
  while (undoing?.undo === true && undoing.restoredFrom !== undefined) undoing = byId.get(undoing.restoredFrom);
  const target = undoing?.parent ? byId.get(undoing.parent) : undefined;
  return undoing && target ? { undoing, target } : null;
}

function sessionTitle(session: Session | undefined, entries: readonly HistoryEntry[]): string {
  if (session?.title !== undefined) return session.title;
  if (session?.kind === 'chat') return 'Chat';
  const who = new Set(entries.map((entry) => entry.who));
  // The version found on first opening is nobody's work, unless it's all there is.
  if (who.size > 1) who.delete(FOUND);
  return [...who].join(', ');
}

export function buildHistoryView(sessions: readonly Session[], snapshots: readonly Snapshot[]): HistoryView {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const latest = snapshots.at(-1);
  const listed = snapshots.slice(-MAX_LISTED_CHANGES);

  const groups = new Map<string, HistoryEntry[]>();
  // Newest first, so a session's place in the map is its newest change.
  for (const snapshot of [...listed].reverse()) {
    const restoredFromAt = snapshot.restoredFrom === undefined ? undefined : byId.get(snapshot.restoredFrom)?.at;
    const entry: HistoryEntry = {
      id: snapshot.id,
      at: snapshot.at,
      source: snapshot.source,
      who: whoMade(snapshot),
      summary: summaryOf(snapshot),
      ...(restoredFromAt === undefined ? {} : { restoredFromAt }),
      ...(snapshot.undo === true ? { undo: true } : {}),
      current: sameFiles(snapshot, latest),
    };
    groups.set(snapshot.session, [...(groups.get(snapshot.session) ?? []), entry]);
  }

  const known = new Map(sessions.map((s) => [s.id, s]));
  const listedSessions: HistorySession[] = [...groups].map(([id, entries]) => {
    const session = known.get(id);
    return {
      id,
      kind: session?.kind ?? 'activity',
      title: sessionTitle(session, entries),
      openedAt: session?.openedAt ?? entries.at(-1)?.at ?? 0,
      entries,
    };
  });

  const step = undoStep(snapshots);
  return {
    sessions: listedSessions,
    older: snapshots.length - listed.length,
    undo:
      step && latest
        ? {
            latest: latest.id,
            who: whoMade(step.undoing),
            summary: step.undoing.source === 'restore' ? 'the restore' : summaryOf(step.undoing),
          }
        : null,
  };
}
