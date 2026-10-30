// The history API. A project's history lives outside its folder, and every
// process writes through the same lock, so changes from any editor or agent
// land in one unbroken chain of snapshots. Nothing is ever deleted: restoring
// creates a new snapshot. Writing restored files into the project is the caller's job.
import { randomUUID } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { loadFromTexts, PLAN_FORMAT_VERSION } from '@idea-to-code/core';
import { z } from 'zod';
import { putBlob, readBlob } from './blobs.js';
import { StoreError } from './errors.js';
import {
  currentActivity,
  parseIndex,
  replay,
  serializeEvents,
  withIdleClosure,
  type HistoryEvent,
  type HistoryState,
  type Session,
  type Snapshot,
  type SnapshotSource,
} from './events.js';
import { atomicWrite, readTextOrNull } from './files.js';
import { planFingerprint, similarity } from './fingerprint.js';
import { withLock, type LockOptions } from './lock.js';

const ProjectRecord = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  formatVersion: z.number(),
  fingerprint: z.array(z.string()),
  createdAt: z.number(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

const View = z.object({ level: z.string(), at: z.number() });
export type View = z.infer<typeof View>;

/** How much of a plan's IDs must match for a moved folder to count as the same project. */
const RELINK_THRESHOLD = 0.6;
export const DEFAULT_IDLE_MS = 30 * 60_000;

export interface StoreOptions {
  /** Idle time after which an activity session closes. */
  idleMs?: number;
  lock?: LockOptions;
  now?: () => number;
}

export interface OpenedProject {
  project: ProjectHistory;
  status: 'new' | 'existing' | 'relinked';
  previousPath?: string;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export class HistoryStore {
  constructor(
    readonly dataDir: string,
    private readonly options: StoreOptions = {},
  ) {}

  private get projectsDir() {
    return join(this.dataDir, 'projects');
  }

  private async records(): Promise<ProjectRecord[]> {
    const names = await readdir(this.projectsDir).catch(() => [] as string[]);
    const records: ProjectRecord[] = [];
    for (const name of names) {
      const text = await readTextOrNull(join(this.projectsDir, name, 'project.json')).catch(() => null);
      if (text === null) continue;
      try {
        records.push(ProjectRecord.parse(JSON.parse(text)));
      } catch {
        // An unreadable project record doesn't stop the others from working.
      }
    }
    return records;
  }

  private handle(record: ProjectRecord): ProjectHistory {
    return new ProjectHistory(this.dataDir, record, this.options);
  }

  private writeRecord(record: ProjectRecord): Promise<void> {
    return atomicWrite(join(this.projectsDir, record.id, 'project.json'), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Finds a folder's history, or starts one. A folder whose old location is gone
   * and whose plan matches strongly picks its history back up. A copy, whose
   * original still exists, gets its own history, because the two will now diverge.
   */
  async openProject(input: { path: string; texts: Readonly<Record<string, string>>; name?: string }): Promise<OpenedProject> {
    const path = resolve(input.path);
    return withLock(
      join(this.projectsDir, 'registry.lock'),
      async () => {
        const records = await this.records();
        const known = records.find((r) => r.path === path);
        if (known) return { project: this.handle(known), status: 'existing' as const };

        const fingerprint = planFingerprint(input.texts);
        let best: { record: ProjectRecord; score: number; tied: boolean } | undefined;
        for (const record of records) {
          const score = similarity(record.fingerprint, fingerprint);
          if (score < RELINK_THRESHOLD || (await pathExists(record.path))) continue;
          if (!best || score > best.score) best = { record, score, tied: false };
          else if (score === best.score) best.tied = true;
        }
        if (best && !best.tied) {
          const moved = { ...best.record, path, fingerprint };
          await this.writeRecord(moved);
          return { project: this.handle(moved), status: 'relinked' as const, previousPath: best.record.path };
        }

        const record: ProjectRecord = {
          id: randomUUID(),
          path,
          name: input.name ?? loadFromTexts(input.texts).map?.data?.project ?? basename(path),
          formatVersion: PLAN_FORMAT_VERSION,
          fingerprint,
          createdAt: (this.options.now ?? Date.now)(),
        };
        await this.writeRecord(record);
        return { project: this.handle(record), status: 'new' as const };
      },
      this.options.lock,
    );
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return this.records();
  }
}

function sameFiles(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

export type RecordResult = { recorded: true; snapshot: Snapshot } | { recorded: false; latest: Snapshot };

export interface RecordInput {
  texts: Readonly<Record<string, string>>;
  source: SnapshotSource;
  actor: string;
  summary?: string;
  /** A chat session to record under; without one, the edit joins the running activity session. */
  sessionId?: string;
}

export class ProjectHistory {
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly dataDir: string,
    readonly record: ProjectRecord,
    private readonly options: StoreOptions,
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.now = options.now ?? Date.now;
  }

  get dir() {
    return join(this.dataDir, 'projects', this.record.id);
  }
  private get indexPath() {
    return join(this.dir, 'index.jsonl');
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(join(this.dir, 'lock'), fn, this.options.lock);
  }

  /** Held across a whole read, edit, write and snapshot. The history lock stays inside it, around the index. */
  withPlanLock<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(join(this.dir, 'plan.lock'), fn, this.options.lock);
  }

  private async readIndex(): Promise<{ state: HistoryState; damagedLines: number }> {
    const { events, damagedLines } = parseIndex((await readTextOrNull(this.indexPath)) ?? '');
    return { state: replay(events), damagedLines };
  }

  private async append(events: readonly HistoryEvent[]): Promise<void> {
    // After a crash mid-write the last line has no newline; start clean so the damage stays on one line.
    const existing = (await readTextOrNull(this.indexPath)) ?? '';
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    const fh = await open(this.indexPath, 'a');
    try {
      await fh.appendFile(prefix + serializeEvents(events));
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private closeIdle(session: Session): HistoryEvent {
    return { type: 'session-close', id: session.id, at: session.lastActivityAt + this.idleMs, by: 'idle' };
  }

  /** Close events for every activity session no longer current, plus a new one if none is. */
  private activityFor(state: HistoryState, now: number): { sessionId: string; events: HistoryEvent[] } {
    const events: HistoryEvent[] = [];
    const current = currentActivity(state, now, this.idleMs);
    for (const session of state.sessions.values()) {
      if (session.kind === 'activity' && session.closedAt === undefined && session !== current) events.push(this.closeIdle(session));
    }
    if (current) return { sessionId: current.id, events };
    const sessionId = randomUUID();
    events.push({ type: 'session-open', id: sessionId, kind: 'activity', at: now });
    return { sessionId, events };
  }

  /** Records the plan's files, unless they're identical to the latest snapshot. */
  async recordSnapshot(input: RecordInput): Promise<RecordResult> {
    return this.recordFiles(input, await this.storeBlobs(input.texts));
  }

  private async storeBlobs(texts: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const path of Object.keys(texts).sort()) files[path] = await putBlob(this.dataDir, texts[path] ?? '');
    return files;
  }

  private recordFiles(input: RecordInput & { restoredFrom?: string }, files: Record<string, string>): Promise<RecordResult> {
    return this.locked(async () => {
      const { state } = await this.readIndex();
      const latest = state.snapshots.at(-1);
      if (latest && sameFiles(latest.files, files)) return { recorded: false as const, latest };

      const now = this.now();
      const events: HistoryEvent[] = [];
      let sessionId = input.sessionId;
      if (sessionId === undefined) {
        const activity = this.activityFor(state, now);
        sessionId = activity.sessionId;
        events.push(...activity.events);
      } else {
        const session = state.sessions.get(sessionId);
        if (!session) throw new StoreError('unknown-session', `no session "${sessionId}" in this project`);
        if (session.closedAt !== undefined) throw new StoreError('session-closed', `session "${sessionId}" is closed`);
      }
      const snapshot: Snapshot = {
        type: 'snapshot',
        id: randomUUID(),
        parent: latest?.id ?? null,
        session: sessionId,
        at: now,
        source: input.source,
        actor: input.actor,
        files,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
      };
      await this.append([...events, snapshot]);
      await this.refreshFingerprint(input.texts);
      return { recorded: true as const, snapshot };
    });
  }

  /** Keeps the fingerprint current, so a project edited and then moved is still recognised. */
  private async refreshFingerprint(texts: Readonly<Record<string, string>>): Promise<void> {
    const fingerprint = planFingerprint(texts);
    if (fingerprint.length === 0) return;
    this.record.fingerprint = fingerprint;
    await atomicWrite(join(this.dir, 'project.json'), `${JSON.stringify(this.record, null, 2)}\n`);
  }

  /** Opens a session. A chat records its editor; starting an activity session closes the running one. */
  async openSession(input: { kind: 'chat'; editor: string; title?: string } | { kind: 'activity' }): Promise<Session> {
    return this.locked(async () => {
      const { state } = await this.readIndex();
      const now = this.now();
      const events: HistoryEvent[] = [];
      const id = randomUUID();
      if (input.kind === 'activity') {
        for (const session of state.sessions.values()) {
          if (session.kind !== 'activity' || session.closedAt !== undefined) continue;
          const idle = now - session.lastActivityAt > this.idleMs;
          events.push(idle ? this.closeIdle(session) : { type: 'session-close', id: session.id, at: now, by: 'replaced' });
        }
        events.push({ type: 'session-open', id, kind: 'activity', at: now });
      } else {
        events.push({
          type: 'session-open',
          id,
          kind: 'chat',
          at: now,
          editor: input.editor,
          ...(input.title === undefined ? {} : { title: input.title }),
        });
      }
      await this.append(events);
      const opened = replay(parseIndex(serializeEvents(events)).events).sessions.get(id);
      if (!opened) throw new Error('session was not recorded');
      return opened;
    });
  }

  /** Closes a session, keeping a short summary other editors can show. Closing twice changes nothing. */
  async closeSession(id: string, input: { summary?: string } = {}): Promise<void> {
    await this.locked(async () => {
      const { state } = await this.readIndex();
      const session = state.sessions.get(id);
      if (!session) throw new StoreError('unknown-session', `no session "${id}" in this project`);
      if (session.closedAt !== undefined) return;
      await this.append([
        { type: 'session-close', id, at: this.now(), by: 'user', ...(input.summary === undefined ? {} : { summary: input.summary }) },
      ]);
    });
  }

  async listSessions(): Promise<Session[]> {
    const { state } = await this.readIndex();
    const now = this.now();
    return [...state.sessions.values()].map((s) => withIdleClosure(s, now, this.idleMs));
  }

  async listSnapshots(): Promise<Snapshot[]> {
    return (await this.readIndex()).state.snapshots;
  }

  /** A snapshot's files. A missing or corrupt file makes only that file unavailable, listed in `missing`. */
  async readSnapshot(id: string): Promise<{ snapshot: Snapshot; files: Record<string, string>; missing: string[] }> {
    const snapshot = (await this.listSnapshots()).find((s) => s.id === id);
    if (!snapshot) throw new StoreError('unknown-snapshot', `no snapshot "${id}" in this project`);
    const files: Record<string, string> = {};
    const missing: string[] = [];
    for (const [path, hash] of Object.entries(snapshot.files)) {
      const content = await readBlob(this.dataDir, hash);
      if (content === null) missing.push(path);
      else files[path] = content;
    }
    return { snapshot, files, missing };
  }

  /**
   * Makes an earlier version the latest by recording it again; nothing is lost.
   * Returns its files for the caller to write. Refuses if any file is unavailable,
   * rather than restoring part of a plan.
   */
  async restore(
    id: string,
    input: { actor: string; sessionId?: string; summary?: string },
  ): Promise<RecordResult & { files: Record<string, string> }> {
    const { snapshot, files, missing } = await this.readSnapshot(id);
    if (missing.length > 0)
      throw new StoreError('blob-missing', `can't restore "${id}": stored version of ${missing.join(', ')} is missing or damaged`);
    const result = await this.recordFiles(
      {
        texts: files,
        source: 'restore',
        actor: input.actor,
        summary: input.summary ?? `Restored the version from ${new Date(snapshot.at).toISOString()}`,
        restoredFrom: id,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      },
      snapshot.files,
    );
    return { ...result, files };
  }

  /** The level being viewed, shared with MCP clients. A missing or damaged file just means none. */
  async readView(): Promise<View | null> {
    const text = await readTextOrNull(join(this.dir, 'view.json'));
    if (text === null) return null;
    try {
      return View.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async writeView(level: string): Promise<void> {
    await atomicWrite(join(this.dir, 'view.json'), `${JSON.stringify({ level, at: this.now() })}\n`);
  }

  /** Checks the whole history: the parent chain proves writes were serialised; every stored version is re-hashed. */
  async verify(): Promise<{ snapshots: number; blobs: number; damagedLines: number; problems: string[] }> {
    const { state, damagedLines } = await this.readIndex();
    const problems: string[] = [];
    const ids = new Set<string>();
    const hashes = new Set<string>();
    state.snapshots.forEach((s, i) => {
      if (ids.has(s.id)) problems.push(`duplicate snapshot ${s.id}`);
      ids.add(s.id);
      const expected = i === 0 ? null : (state.snapshots[i - 1]?.id ?? null);
      if (s.parent !== expected) problems.push(`snapshot ${i + 1} has parent ${s.parent ?? 'none'}, expected ${expected ?? 'none'}`);
      if (!state.sessions.has(s.session)) problems.push(`snapshot ${s.id} belongs to unknown session ${s.session}`);
      for (const hash of Object.values(s.files)) hashes.add(hash);
    });
    for (const hash of hashes) {
      if ((await readBlob(this.dataDir, hash)) === null) problems.push(`blob ${hash} is missing or damaged`);
    }
    const leftovers = (await readdir(this.dir)).filter(
      (n) => n === 'lock' || n === 'plan.lock' || n.includes('.tmp-') || n.includes('.stale-') || n.endsWith('.steal'),
    );
    for (const name of leftovers) problems.push(`leftover ${name}`);
    return { snapshots: state.snapshots.length, blobs: hashes.size, damagedLines, problems };
  }
}
