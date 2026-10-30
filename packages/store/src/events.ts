// The append-only history log (index.jsonl): one JSON event per line. Reading
// is tolerant: a half-written or unknown line is skipped and counted, so one
// bad line never costs the rest of the history. replay() derives the state.
import { z } from 'zod';

export const SnapshotSource = z.enum(['ui', 'agent', 'mcp', 'external', 'restore', 'repair']);
export type SnapshotSource = z.infer<typeof SnapshotSource>;

const SessionOpen = z.object({
  type: z.literal('session-open'),
  id: z.string(),
  kind: z.enum(['chat', 'activity']),
  at: z.number(),
  editor: z.string().optional(),
  title: z.string().optional(),
});

const SessionClose = z.object({
  type: z.literal('session-close'),
  id: z.string(),
  at: z.number(),
  by: z.enum(['user', 'idle', 'replaced']),
  summary: z.string().optional(),
});

const SnapshotEvent = z.object({
  type: z.literal('snapshot'),
  id: z.string(),
  parent: z.string().nullable(),
  session: z.string(),
  at: z.number(),
  source: SnapshotSource,
  actor: z.string(),
  files: z.record(z.string(), z.string()),
  summary: z.string().optional(),
  restoredFrom: z.string().optional(),
});

export const HistoryEvent = z.discriminatedUnion('type', [SessionOpen, SessionClose, SnapshotEvent]);
export type HistoryEvent = z.infer<typeof HistoryEvent>;
export type Snapshot = z.infer<typeof SnapshotEvent>;
export type SessionOpenEvent = z.infer<typeof SessionOpen>;

export function parseIndex(text: string): { events: HistoryEvent[]; damagedLines: number } {
  const events: HistoryEvent[] = [];
  let damagedLines = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      damagedLines++;
      continue;
    }
    const parsed = HistoryEvent.safeParse(value);
    if (parsed.success) events.push(parsed.data);
    else damagedLines++;
  }
  return { events, damagedLines };
}

export function serializeEvents(events: readonly HistoryEvent[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('');
}

export interface Session {
  id: string;
  kind: 'chat' | 'activity';
  openedAt: number;
  /** Which editor a chat belongs to; its transcript lives there, not in this store. */
  editor?: string;
  title?: string;
  summary?: string;
  closedAt?: number;
  closedBy?: 'user' | 'idle' | 'replaced';
  snapshots: number;
  lastActivityAt: number;
}

export interface HistoryState {
  sessions: Map<string, Session>;
  snapshots: Snapshot[];
}

export function replay(events: readonly HistoryEvent[]): HistoryState {
  const sessions = new Map<string, Session>();
  const snapshots: Snapshot[] = [];
  for (const e of events) {
    if (e.type === 'session-open') {
      sessions.set(e.id, {
        id: e.id,
        kind: e.kind,
        openedAt: e.at,
        ...(e.editor === undefined ? {} : { editor: e.editor }),
        ...(e.title === undefined ? {} : { title: e.title }),
        snapshots: 0,
        lastActivityAt: e.at,
      });
    } else if (e.type === 'session-close') {
      const session = sessions.get(e.id);
      if (session) {
        session.closedAt = e.at;
        session.closedBy = e.by;
        if (e.summary !== undefined) session.summary = e.summary;
      }
    } else {
      snapshots.push(e);
      const session = sessions.get(e.session);
      if (session) {
        session.snapshots++;
        session.lastActivityAt = e.at;
      }
    }
  }
  return { sessions, snapshots };
}

/** The activity session still accepting edits at `now`, if any. */
export function currentActivity(state: HistoryState, now: number, idleMs: number): Session | undefined {
  for (const session of state.sessions.values()) {
    if (session.kind === 'activity' && session.closedAt === undefined && now - session.lastActivityAt <= idleMs) return session;
  }
  return undefined;
}

/** An activity session past its idle time counts as closed, whether or not a later edit has recorded that yet. */
export function withIdleClosure(session: Session, now: number, idleMs: number): Session {
  if (session.kind === 'activity' && session.closedAt === undefined && now - session.lastActivityAt > idleMs) {
    return { ...session, closedAt: session.lastActivityAt + idleMs, closedBy: 'idle' };
  }
  return session;
}
