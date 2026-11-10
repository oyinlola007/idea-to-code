// The built-in chat, without the editor: it decides which model a message needs,
// builds the request, runs the turn with the chart showing its changes live, writes
// the turn as one version, and keeps the chat. The editor parts come in through ChatHost.
import {
  diffProjects,
  loadFromTexts,
  mapView,
  revealChanges,
  summarizeDiff,
  type AppState,
  type ChatItem,
  type ChatView,
  type EditResult,
  type OpRequest,
  type Project,
  type Reveal,
} from '@idea-to-code/core';
import { DEFAULT_IDLE_MS, type ProjectService } from '@idea-to-code/store';
import { randomUUID } from 'node:crypto';
import { ModelError, type ModelProvider } from '../models/provider.js';
import { conversation, latestMessage } from './context.js';
import { ModelDecider, NO_DECISION } from './decider.js';
import type { ChatStore, Thread, Turn } from './transcript.js';
import { runTurn } from './turn.js';

export interface Disposable {
  dispose(): void;
}

/** What the chat needs from the editor. */
export interface ChatHost {
  service(): ProjectService | undefined;
  state(): AppState;
  hasFolder(): boolean;
  /** The level the user is looking at. */
  level(): string;
  /** Shows the agent's changes on the chart before they're written; null shows the files again. */
  setPreview(texts: Record<string, string> | null): void;
  /** While busy, edits from the chart wait. */
  setBusy(busy: boolean): void;
  undo(latest: string): Promise<EditResult>;
  /** Shows where changes are on the chart: in the Plan tab if it's on screen, or bringing it forward. */
  reveal(reveal: Reveal, bringForward: boolean): void;
  /** Starts a plan in the workspace, for a first message sent before there is one. True when there's a plan afterwards. */
  startPlan(): Promise<boolean>;
  onDidChange(listener: () => void): Disposable;
}

export interface ChatModels {
  model(tier: 'large' | 'small'): Promise<{ provider: ModelProvider; model: string }>;
  onDidChange(listener: () => void): Disposable;
}

export interface ChatLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface ChatDeps {
  host: ChatHost;
  models: ChatModels;
  store: ChatStore;
  /** Which editor this is, for the shared history: "Visual Studio Code", "Cursor"… */
  editor: string;
  log: ChatLog;
  now?: () => number;
}

const SETUP_CODES = new Set(['not-set-up', 'key-rejected', 'no-model', 'no-permission']);
const NEW_TITLE = 'New chat';

/** A short title from the first message of a chat. */
function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

interface Live {
  turn: Turn;
  controller: AbortController;
  /** Streamed text of each reply in this turn. */
  replies: string[];
  activity?: string;
}

export class ChatService {
  private thread: Thread | undefined;
  private threads: { id: string; title: string; updatedAt: number }[] = [];
  private live: Live | undefined;
  /** True while a first message is starting the plan, so a second send waits its turn. */
  private starting = false;
  private modelReady = true;
  /** A turn from this session that failed for want of a model, answered once one is set up. */
  private waitingForModel: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly textListeners = new Set<(event: { itemId: string; text: string }) => void>();
  private readonly subscriptions: Disposable[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: ChatDeps) {
    this.now = deps.now ?? Date.now;
    this.subscriptions.push(
      deps.host.onDidChange(() => {
        this.fire();
      }),
      deps.models.onDidChange(() => {
        void this.checkModel().then(() => this.answerWaiting());
      }),
    );
  }

  /** Opens the chat used last, and checks a model is set up. */
  async start(): Promise<void> {
    this.thread = await this.deps.store.current();
    this.threads = await this.deps.store.list();
    await this.checkModel();
  }

  /** Sends again the message that was waiting for a model, now that the settings changed. */
  private async answerWaiting(): Promise<void> {
    const thread = this.thread;
    const last = thread?.turns.at(-1);
    if (!thread || !last || last.id !== this.waitingForModel || this.live || this.starting || this.status() !== 'ready') return;
    this.waitingForModel = undefined;
    thread.turns.pop();
    await this.send(last.user);
  }

  private async checkModel(): Promise<void> {
    try {
      await this.deps.models.model('large');
      this.modelReady = true;
    } catch {
      this.modelReady = false;
    }
    this.fire();
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  onText(listener: (event: { itemId: string; text: string }) => void): Disposable {
    this.textListeners.add(listener);
    return { dispose: () => this.textListeners.delete(listener) };
  }

  private fire(): void {
    for (const listener of this.listeners) listener();
  }

  get busy(): boolean {
    return this.live !== undefined;
  }

  private status(): ChatView['status'] {
    const { host } = this.deps;
    const state = host.state();
    if (!host.hasFolder()) return 'no-folder';
    if (!state.trusted) return 'untrusted';
    if (state.kind !== 'plan' || !host.service()) return 'no-plan';
    return this.modelReady ? 'ready' : 'no-model';
  }

  /** The latest version of the plan, which Undo would reverse. */
  private latestVersion(): string | undefined {
    const state = this.deps.host.state();
    return state.kind === 'plan' ? state.history?.undo?.latest : undefined;
  }

  private turnItems(turn: Turn): ChatItem[] {
    const items: ChatItem[] = [{ kind: 'user', id: `${turn.id}-u`, text: turn.user }];
    turn.messages.forEach((message, i) => {
      if (message.role === 'assistant' && message.text.trim() !== '')
        items.push({ kind: 'assistant', id: `${turn.id}-r${String(i)}`, text: message.text });
    });
    if (turn.error) {
      items.push({
        kind: 'notice',
        id: `${turn.id}-e`,
        text: turn.error.text,
        tone: 'error',
        ...(turn.error.action ? { action: turn.error.action } : {}),
      });
    }
    if (turn.snapshotId !== undefined) {
      items.push({
        kind: 'changes',
        id: `${turn.id}-c`,
        summary: turn.summary ?? '',
        ...(turn.sessionId === undefined ? {} : { session: turn.sessionId }),
        ...(turn.outcome === 'cancelled' ? { cancelled: true } : {}),
        ...(turn.undone === true ? { undone: true } : turn.snapshotId === this.latestVersion() ? { undoable: true } : {}),
        ...(turn.reveal && turn.undone !== true ? { reveal: turn.reveal } : {}),
      });
    } else if ((turn.skipped ?? 0) > 0) {
      items.push({
        kind: 'notice',
        id: `${turn.id}-s`,
        text: 'The plan changed while I worked, so my changes weren’t applied.',
        tone: 'info',
      });
    }
    if (turn.outcome === 'too-many-failures') {
      items.push({ kind: 'notice', id: `${turn.id}-f`, text: 'Some changes couldn’t be made. Try asking another way.', tone: 'info' });
    }
    return items;
  }

  private liveItems(live: Live): ChatItem[] {
    const items: ChatItem[] = [{ kind: 'user', id: `${live.turn.id}-u`, text: live.turn.user }];
    live.replies.forEach((text, i) => items.push({ kind: 'assistant', id: `${live.turn.id}-live${String(i)}`, text }));
    if (live.activity !== undefined) items.push({ kind: 'activity', id: `${live.turn.id}-act`, text: live.activity, ok: true });
    return items;
  }

  view(): ChatView {
    const thread = this.thread;
    const live = this.live;
    const items = (thread?.turns ?? []).filter((turn) => turn.id !== live?.turn.id).flatMap((turn) => this.turnItems(turn));
    if (live) items.push(...this.liveItems(live));
    return {
      status: this.status(),
      threads: this.threads,
      current: thread ? { id: thread.id, title: thread.title } : null,
      items,
      busy: live !== undefined,
    };
  }

  /** What changed outside this chat since its last turn, in a sentence, if anything did. */
  private async since(thread: Thread, service: ProjectService, project: Project): Promise<string | undefined> {
    const history = service.projectHistory;
    if (!history || thread.lastSeen === undefined) return undefined;
    try {
      const latest = (await history.listSnapshots()).at(-1);
      if (!latest || latest.id === thread.lastSeen) return undefined;
      const seen = await history.readSnapshot(thread.lastSeen);
      const summary = summarizeDiff(diffProjects(loadFromTexts(seen.files), project));
      return summary === 'No changes' ? undefined : summary;
    } catch {
      return undefined;
    }
  }

  /** For a chat's first message: the latest work on the plan, from any editor or agent. */
  private recent(): string | undefined {
    const state = this.deps.host.state();
    if (state.kind !== 'plan' || !state.history) return undefined;
    const lines = state.history.sessions.slice(0, 5).map(
      (s) =>
        `- ${s.title}, ${new Date(s.openedAt).toISOString().slice(0, 10)}: ${s.entries
          .slice(0, 3)
          .map((e) => e.summary)
          .join('; ')}`,
    );
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  /** The chat's current session in the shared history: a new one after a break, like other edits. */
  private async sitting(thread: Thread, service: ProjectService): Promise<string | undefined> {
    const history = service.projectHistory;
    if (!history) return undefined;
    const current = thread.history;
    if (current && this.now() - current.lastEditAt <= DEFAULT_IDLE_MS) return current.sessionId;
    if (current) await this.closeSitting(thread, service);
    const session = await history.openSession({ kind: 'chat', editor: this.deps.editor, title: thread.title });
    thread.history = { sessionId: session.id, lastEditAt: this.now(), summaries: [] };
    return session.id;
  }

  private async closeSitting(thread: Thread, service: ProjectService | undefined): Promise<void> {
    const current = thread.history;
    thread.history = undefined;
    if (!current || !service?.projectHistory) return;
    const n = current.summaries.length;
    const summary = `${String(n)} change${n === 1 ? '' : 's'}${n > 0 ? `: ${current.summaries.slice(0, 3).join('; ')}` : ''}`;
    await service.projectHistory.closeSession(current.sessionId, { summary }).catch((err: unknown) => {
      this.deps.log.warn(`couldn't close the chat's history session: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Writes the turn's changes as one version, in the chat's sitting. */
  private async commit(thread: Thread, turn: Turn, batch: OpRequest[], service: ProjectService): Promise<void> {
    const sessionId = await this.sitting(thread, service).catch(() => undefined);
    const result = await service.applyBatch(batch, {
      source: 'agent',
      actor: 'built-in agent',
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    if (!result.ok) {
      turn.error = { text: `The changes couldn’t be saved: ${result.message}` };
      return;
    }
    turn.applied = result.applied;
    turn.skipped = result.skipped.length;
    if (result.snapshotId === undefined) return;
    turn.snapshotId = result.snapshotId;
    turn.summary = result.summary;
    const reveal = revealChanges(loadFromTexts(result.before), loadFromTexts(result.texts));
    if (reveal) turn.reveal = reveal;
    if (result.sessionId !== undefined) turn.sessionId = result.sessionId;
    if (thread.history && result.sessionId === thread.history.sessionId) {
      thread.history.lastEditAt = this.now();
      thread.history.summaries.push(result.summary);
    } else {
      // Recorded elsewhere, e.g. the session was closed by another editor: start afresh next time.
      thread.history = undefined;
    }
  }

  async send(text: string): Promise<void> {
    const thread = this.thread;
    if (this.live || this.starting || !thread) return;
    // The first message starts the plan; there's no separate step.
    if (this.status() === 'no-plan') {
      this.starting = true;
      const started = await this.deps.host.startPlan().finally(() => (this.starting = false));
      if (!started) return;
    }
    const service = this.deps.host.service();
    if (!service || this.status() === 'no-plan') return;
    if (thread.turns.length === 0 && thread.title === NEW_TITLE) thread.title = titleFrom(text);
    const turn: Turn = { id: randomUUID(), at: this.now(), user: text, messages: [], outcome: 'running' };
    const live: Live = { turn, controller: new AbortController(), replies: [] };
    const { signal } = live.controller;
    this.live = live;
    thread.turns.push(turn);
    // Saved now, so a turn cut short by closing the editor shows as interrupted.
    await this.deps.store.save(thread);
    this.deps.host.setBusy(true);
    this.fire();
    const started = this.now();
    try {
      await this.run(thread, turn, live, service, signal);
    } catch (err) {
      turn.outcome = signal.aborted ? 'cancelled' : 'error';
      if (!signal.aborted) turn.error = { text: err instanceof Error ? err.message : String(err) };
    } finally {
      this.deps.host.setPreview(null);
      thread.lastSeen = (await service.projectHistory?.listSnapshots().catch(() => undefined))?.at(-1)?.id ?? thread.lastSeen;
      thread.updatedAt = this.now();
      await this.deps.store.save(thread);
      this.threads = await this.deps.store.list();
      this.live = undefined;
      this.waitingForModel = turn.error?.action === 'open-model-settings' ? turn.id : undefined;
      this.deps.host.setBusy(false);
      this.fire();
      if (turn.reveal) this.deps.host.reveal(turn.reveal, false);
      const usage = turn.usage ? `, ${String(turn.usage.inputTokens)} in / ${String(turn.usage.outputTokens)} out tokens` : '';
      this.deps.log.info(
        `chat turn: ${turn.kind ?? '?'} on ${turn.model ?? '?'}, ${turn.outcome}, ${String(turn.applied ?? 0)} changes${usage}, ${String(this.now() - started)}ms`,
      );
    }
  }

  private async run(thread: Thread, turn: Turn, live: Live, service: ProjectService, signal: AbortSignal): Promise<void> {
    let large: { provider: ModelProvider; model: string };
    try {
      large = await this.deps.models.model('large');
    } catch (err) {
      turn.outcome = 'error';
      const setup = err instanceof ModelError && SETUP_CODES.has(err.code);
      turn.error = { text: err instanceof Error ? err.message : String(err), ...(setup ? { action: 'open-model-settings' as const } : {}) };
      return;
    }
    const small = await this.deps.models.model('small').catch(() => large);
    // One model for both: nothing to decide.
    const decider = small.model === large.model ? NO_DECISION : new ModelDecider(small.provider, small.model);
    const decidedAt = this.now();
    const decision = await decider.decide(turn.user, signal);
    const route = decision.kind === 'plan' ? large : small;
    turn.kind = decision.kind;
    turn.model = route.model;
    await this.deps.store
      .logKind({ at: decidedAt, kind: decision.kind, by: decision.by, model: route.model, ms: this.now() - decidedAt })
      .catch(() => undefined);

    const texts = await service.readPlan();
    const project = loadFromTexts(texts);
    const earlier = thread.turns.filter((t) => t.id !== turn.id && t.outcome !== 'running');
    const since = await this.since(thread, service, project);
    const recent = earlier.length === 0 ? this.recent() : undefined;
    const messages = [
      ...conversation(earlier),
      latestMessage(turn.user, {
        mapView: mapView(project, this.deps.host.level()),
        ...(since === undefined ? {} : { since }),
        ...(recent === undefined ? {} : { recent }),
      }),
    ];

    const result = await runTurn({
      provider: route.provider,
      model: route.model,
      messages,
      texts,
      signal,
      onText: (reply, delta) => {
        const first = live.replies[reply] === undefined;
        live.replies[reply] = (live.replies[reply] ?? '') + delta;
        // A new reply needs the whole view once, so the page has something to add to.
        if (first) this.fire();
        else for (const listener of this.textListeners) listener({ itemId: `${turn.id}-live${String(reply)}`, text: delta });
      },
      onActivity: (activity, changed) => {
        live.activity = activity.text;
        if (changed) this.deps.host.setPreview(changed);
        this.fire();
      },
    });
    turn.messages = result.messages;
    turn.outcome = result.outcome;
    turn.usage = result.usage;
    if (result.outcome === 'error' && result.error) {
      const setup = SETUP_CODES.has(result.error.code);
      turn.error = { text: result.error.message, ...(setup ? { action: 'open-model-settings' as const } : {}) };
    }
    // Stopped or not, what was done is kept, as one version that Undo reverses.
    if (result.batch.length > 0) await this.commit(thread, turn, result.batch, service);
  }

  cancel(): void {
    this.live?.controller.abort();
  }

  async newThread(): Promise<void> {
    if (this.live) return;
    this.thread = await this.deps.store.create(NEW_TITLE);
    this.threads = await this.deps.store.list();
    this.fire();
  }

  async openThread(id: string): Promise<void> {
    if (this.live || id === this.thread?.id) return;
    const thread = await this.deps.store.open(id);
    if (!thread) {
      this.deps.log.warn(`couldn't open chat ${id}: it's missing or damaged`);
      return;
    }
    this.thread = thread;
    this.threads = await this.deps.store.list();
    this.fire();
  }

  showChanges(reveal: Reveal): void {
    this.deps.host.reveal(reveal, true);
  }

  /** Reverses the chat's latest change, if nothing has changed the plan since. */
  async undo(): Promise<void> {
    const latest = this.latestVersion();
    const turn = this.thread?.turns.findLast((t) => t.snapshotId !== undefined);
    if (this.live || latest === undefined || turn?.snapshotId !== latest) return;
    const result = await this.deps.host.undo(latest);
    if (!result.ok) {
      this.deps.log.warn(`undo from the chat: ${result.message ?? 'refused'}`);
      return;
    }
    turn.undone = true;
    if (this.thread) await this.deps.store.save(this.thread);
    this.fire();
  }

  dispose(): void {
    this.live?.controller.abort();
    if (this.thread)
      void this.closeSitting(this.thread, this.deps.host.service()).then(() => this.thread && this.deps.store.save(this.thread));
    for (const s of this.subscriptions) s.dispose();
    this.listeners.clear();
    this.textListeners.clear();
  }
}
