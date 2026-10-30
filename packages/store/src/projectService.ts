// One project's plan and history, used the same way by the extension and the MCP
// server. Every change goes validate -> write -> snapshot -> event. The plan lock
// is held across all of it, so another process's change detection can't see an
// unfinished edit and credit it to an outside editor. History problems never stop
// an edit: it succeeds with a warning, and the next detection catches up.
import { applyOperation, diffProjects, loadFromTexts, summarizeDiff, type OpRequest, type OpSuccess } from '@idea-to-code/core';
import { hashOf } from './blobs.js';
import { StoreError } from './errors.js';
import type { Snapshot, SnapshotSource } from './events.js';
import type { HistoryStore, ProjectHistory } from './history.js';
import { checkProjectPath } from './paths.js';
import type { PlanFiles } from './planFiles.js';

export type Texts = Record<string, string>;

const MAX_TRIES = 3;
const DEFAULT_QUIET_MS = 2_000;

export type ServiceEvent =
  | {
      type: 'changed';
      cause: 'operation' | 'external' | 'restore';
      summary: string;
      snapshotId?: string;
      changed: string[];
      deleted: string[];
    }
  | { type: 'warning'; message: string };

export type ApplyResult = (OpSuccess & { snapshotId?: string; summary: string }) | { ok: false; code: string; message: string };

export type RestoreResult =
  | { ok: true; changed: string[]; deleted: string[]; snapshotId?: string; warnings: string[] }
  | { ok: false; code: string; message: string };

export interface EditContext {
  source: Exclude<SnapshotSource, 'external' | 'restore'>;
  actor: string;
  summary?: string;
  sessionId?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function differs(a: Texts, b: Texts): boolean {
  const keys = Object.keys(a);
  return keys.length !== Object.keys(b).length || keys.some((k) => a[k] !== b[k]);
}

function describe(before: Texts, after: Texts): string {
  return summarizeDiff(diffProjects(loadFromTexts(before), loadFromTexts(after)));
}

/** New and feature files go first and map.yaml last, so the map never lists a file that isn't there yet. */
function writeOrder(paths: string[]): string[] {
  return [...paths].sort((a, b) => Number(a === 'plan/map.yaml') - Number(b === 'plan/map.yaml'));
}

export interface ServiceOptions {
  files: PlanFiles;
  store: HistoryStore;
  /** The project folder, as the history knows it. */
  root: string;
  /** Quiet time before a burst of outside writes is handled. */
  quietMs?: number;
}

export class ProjectService {
  private readonly listeners = new Set<(event: ServiceEvent) => void>();
  private history: ProjectHistory | null = null;
  private stopWatching: (() => void) | undefined;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private syncing: Promise<unknown> = Promise.resolve();

  /** How opening this folder matched its history: useful to tell the user about a relink. */
  openStatus: { status: 'new' | 'existing' | 'relinked' | 'unavailable'; previousPath?: string } = { status: 'unavailable' };

  private constructor(private readonly options: ServiceOptions) {}

  /** Opens a project and records anything that changed while the app wasn't looking. */
  static async open(options: ServiceOptions): Promise<ProjectService> {
    const service = new ProjectService(options);
    await service.connectHistory();
    await service.sync();
    return service;
  }

  onEvent(listener: (event: ServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ServiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private warn(warnings: string[], message: string): void {
    warnings.push(message);
    this.emit({ type: 'warning', message });
  }

  private async connectHistory(warnings: string[] = []): Promise<ProjectHistory | null> {
    if (this.history) return this.history;
    try {
      const opened = await this.options.store.openProject({ path: this.options.root, texts: await this.readPlan() });
      this.history = opened.project;
      this.openStatus = { status: opened.status, ...(opened.previousPath === undefined ? {} : { previousPath: opened.previousPath }) };
      return this.history;
    } catch (err) {
      this.warn(warnings, `history is unavailable, so this change wasn't recorded: ${messageOf(err)}`);
      return null;
    }
  }

  get projectHistory(): ProjectHistory | null {
    return this.history;
  }

  /** The plan as it is on disk right now. */
  async readPlan(): Promise<Texts> {
    const texts: Texts = {};
    for (const path of await this.options.files.listPlanFiles()) {
      const content = await this.options.files.read(path);
      if (content !== null) texts[path] = content;
    }
    return texts;
  }

  /** Runs under the plan lock when history is healthy. A stuck lock doesn't stop the work; it only costs the guarantee, with a warning. */
  private async guarded<T>(warnings: string[], fn: () => Promise<T>): Promise<T> {
    const history = await this.connectHistory(warnings);
    if (!history) return fn();
    const progress = { started: false };
    try {
      return await history.withPlanLock(() => {
        progress.started = true;
        return fn();
      });
    } catch (err) {
      if (progress.started || !(err instanceof StoreError)) throw err;
      this.warn(warnings, `couldn't get the history lock, so this change may not be recorded correctly: ${err.message}`);
      return fn();
    }
  }

  /** Records the files if they differ from the latest snapshot. Failures become warnings. */
  private async record(
    texts: Texts,
    input: { source: SnapshotSource; actor: string; summary?: string; sessionId?: string },
    warnings: string[],
  ): Promise<Snapshot | undefined> {
    const history = await this.connectHistory(warnings);
    if (!history) return undefined;
    try {
      const result = await history.recordSnapshot({ texts, ...input });
      return result.recorded ? result.snapshot : undefined;
    } catch (err) {
      // The edit is already on disk, so a stale chat session must not lose it: file it under activity.
      if (err instanceof StoreError && (err.code === 'unknown-session' || err.code === 'session-closed')) {
        this.warn(warnings, `recorded outside the chat session: ${err.message}`);
        return this.record(
          texts,
          { source: input.source, actor: input.actor, ...(input.summary === undefined ? {} : { summary: input.summary }) },
          warnings,
        );
      }
      this.warn(warnings, `this change wasn't recorded in history: ${messageOf(err)}`);
      return undefined;
    }
  }

  /** What the latest snapshot held, to describe a change against. Empty if there's none or it's damaged. */
  private async latestTexts(): Promise<{ snapshot?: Snapshot; texts: Texts } | null> {
    if (!this.history) return null;
    try {
      const snapshot = (await this.history.listSnapshots()).at(-1);
      if (!snapshot) return { texts: {} };
      const read = await this.history.readSnapshot(snapshot.id);
      return { snapshot, texts: read.files };
    } catch {
      return null;
    }
  }

  private matchesSnapshot(snapshot: Snapshot | undefined, texts: Texts): boolean {
    const hashes = Object.fromEntries(Object.entries(texts).map(([path, text]) => [path, hashOf(text)]));
    if (!snapshot) return Object.keys(hashes).length === 0;
    return !differs(snapshot.files, hashes);
  }

  /** Under the plan lock: records the disk's state as an outside change if it differs. */
  private async recordDrift(warnings: string[]): Promise<void> {
    const texts = await this.readPlan();
    const latest = await this.latestTexts();
    if (!latest || this.matchesSnapshot(latest.snapshot, texts)) return;
    const summary = latest.snapshot ? describe(latest.texts, texts) : 'First version recorded';
    const snapshot = await this.record(texts, { source: 'external', actor: 'unknown', summary }, warnings);
    if (snapshot) {
      const changed = Object.keys(texts).filter((p) => texts[p] !== latest.texts[p]);
      const deleted = Object.keys(latest.texts).filter((p) => texts[p] === undefined);
      this.emit({ type: 'changed', cause: 'external', summary, snapshotId: snapshot.id, changed, deleted });
    }
  }

  /** Checks the disk against history now; the single rule keeps this safe to run from any process, any time. */
  async sync(): Promise<string[]> {
    const warnings: string[] = [];
    const run = this.syncing.then(() => this.guarded(warnings, () => this.recordDrift(warnings)));
    this.syncing = run.catch(() => undefined);
    await run;
    return warnings;
  }

  /** Writes new contents, putting the originals back if any write fails, so a plan is never left half-changed. */
  private async writeAll(before: Texts, changed: string[], deleted: string[], after: Texts): Promise<void> {
    const done: string[] = [];
    try {
      for (const path of writeOrder(changed)) {
        await this.options.files.write(path, after[path] ?? '');
        done.push(path);
      }
      for (const path of deleted) {
        await this.options.files.remove(path);
        done.push(path);
      }
    } catch (err) {
      for (const path of done) {
        const original = before[path];
        await (original === undefined ? this.options.files.remove(path) : this.options.files.write(path, original)).catch(() => undefined);
      }
      throw err;
    }
  }

  /** Whether the given files still hold what they did when we read them. */
  private async unchangedSince(texts: Texts, paths: string[]): Promise<boolean> {
    for (const path of paths) {
      if ((await this.options.files.read(path)) !== (texts[path] ?? null)) return false;
    }
    return true;
  }

  /** Applies one operation to the files on disk and records it. */
  async apply(request: OpRequest, context: EditContext): Promise<ApplyResult> {
    const warnings: string[] = [];
    try {
      return await this.guarded(warnings, async () => {
        for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
          await this.recordDrift(warnings);
          const before = await this.readPlan();
          const result = applyOperation(before, request);
          if (!result.ok) return result;

          // If an outside editor saved since we read, the edit is applied again to its version: edits address IDs.
          if (!(await this.unchangedSince(before, [...result.changed, ...result.deleted]))) continue;

          try {
            await this.writeAll(before, result.changed, result.deleted, result.texts);
          } catch (err) {
            return { ok: false, code: 'write-failed', message: `couldn't save the change: ${messageOf(err)}` };
          }
          const summary = context.summary ?? describe(before, result.texts);
          const snapshot = await this.record(
            result.texts,
            {
              source: context.source,
              actor: context.actor,
              summary,
              ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            },
            warnings,
          );
          this.emit({
            type: 'changed',
            cause: 'operation',
            summary,
            ...(snapshot ? { snapshotId: snapshot.id } : {}),
            changed: result.changed,
            deleted: result.deleted,
          });
          return { ...result, warnings: [...result.warnings, ...warnings], summary, ...(snapshot ? { snapshotId: snapshot.id } : {}) };
        }
        return {
          ok: false,
          code: 'conflict',
          message: `the plan files kept changing while saving (tried ${MAX_TRIES} times). Read the plan again and retry`,
        };
      });
    } catch (err) {
      if (err instanceof StoreError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  /**
   * Makes the plan files match an earlier version exactly, recording anything unrecorded
   * first so nothing is lost. Only map.yaml and feature files are touched.
   */
  async rollback(snapshotId: string, input: { actor: string; sessionId?: string }): Promise<RestoreResult> {
    const warnings: string[] = [];
    const history = await this.connectHistory(warnings);
    if (!history) return { ok: false, code: 'history-unavailable', message: warnings.join('; ') };
    try {
      return await this.guarded(warnings, async () => {
        const target = await history.readSnapshot(snapshotId);
        if (target.missing.length > 0) {
          return {
            ok: false as const,
            code: 'blob-missing',
            message: `can't restore this version: the stored copy of ${target.missing.join(', ')} is missing or damaged`,
          };
        }
        for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
          await this.recordDrift(warnings);
          const before = await this.readPlan();
          const changed = Object.keys(target.files).filter((p) => before[p] !== target.files[p]);
          const deleted = Object.keys(before).filter((p) => target.files[p] === undefined);
          if (!(await this.unchangedSince(before, [...changed, ...deleted]))) continue;

          try {
            await this.writeAll(before, changed, deleted, target.files);
          } catch (err) {
            return { ok: false as const, code: 'write-failed', message: `couldn't restore the files: ${messageOf(err)}` };
          }
          let snapshot: Snapshot | undefined;
          try {
            const restored = await history.restore(snapshotId, input);
            if (restored.recorded) snapshot = restored.snapshot;
          } catch (err) {
            this.warn(warnings, `the files were restored, but this wasn't recorded in history: ${messageOf(err)}`);
          }
          const summary = snapshot?.summary ?? 'Restored an earlier version';
          this.emit({ type: 'changed', cause: 'restore', summary, ...(snapshot ? { snapshotId: snapshot.id } : {}), changed, deleted });
          return { ok: true as const, changed, deleted, warnings, ...(snapshot ? { snapshotId: snapshot.id } : {}) };
        }
        return {
          ok: false as const,
          code: 'conflict',
          message: `the plan files kept changing during the restore (tried ${MAX_TRIES} times). Try again`,
        };
      });
    } catch (err) {
      if (err instanceof StoreError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  /** Writes a connector or other allowed project file. Not part of plan history. */
  async writeProjectFile(path: string, content: string): Promise<void> {
    checkProjectPath(path);
    await this.options.files.write(path, content);
  }

  /** Starts noticing outside changes, handling a burst once it goes quiet. */
  startWatching(): void {
    if (this.stopWatching) return;
    const quietMs = this.options.quietMs ?? DEFAULT_QUIET_MS;
    this.stopWatching = this.options.files.watch(() => {
      clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => {
        this.sync().catch((err: unknown) => {
          this.emit({ type: 'warning', message: `couldn't check for outside changes: ${messageOf(err)}` });
        });
      }, quietMs);
    });
  }

  /** Stops watching and waits for any check in progress. */
  async dispose(): Promise<void> {
    clearTimeout(this.quietTimer);
    this.stopWatching?.();
    this.stopWatching = undefined;
    await this.syncing;
  }
}
