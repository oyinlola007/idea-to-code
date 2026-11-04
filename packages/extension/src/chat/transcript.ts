// Chats, saved in this editor's own storage for the workspace: never in the project
// and never in the shared history, which only learns a chat's id, editor and summary.
// Everything read back is parsed, so a damaged file costs that chat, not the others.
import { Reveal } from '@idea-to-code/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const ToolCall = z.object({ id: z.string(), name: z.string(), input: z.unknown() });

/** What a turn said to and heard from the model, in the provider-neutral shape. */
export const StoredMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('assistant'), text: z.string(), toolCalls: z.array(ToolCall).optional() }),
  z.object({ role: z.literal('tool'), callId: z.string(), name: z.string(), result: z.string() }),
]);
export type StoredMessage = z.infer<typeof StoredMessage>;

export const MessageKind = z.enum(['edit', 'question', 'plan']);
export type MessageKind = z.infer<typeof MessageKind>;

export const Outcome = z.enum(['running', 'done', 'cancelled', 'too-many-failures', 'call-limit', 'error', 'interrupted']);
export type Outcome = z.infer<typeof Outcome>;

export const Turn = z.object({
  id: z.string(),
  at: z.number(),
  user: z.string(),
  kind: MessageKind.optional(),
  model: z.string().optional(),
  /** The model's side of the turn: its replies, tool calls and their results. */
  messages: z.array(StoredMessage),
  outcome: Outcome,
  /** Shown in place of a reply when the turn couldn't run. */
  error: z.object({ text: z.string(), action: z.enum(['open-model-settings']).optional() }).optional(),
  /** The one version this turn recorded, which links the message to the change. */
  snapshotId: z.string().optional(),
  sessionId: z.string().optional(),
  summary: z.string().optional(),
  /** Changes that couldn't be applied because the plan changed meanwhile. */
  skipped: z.number().optional(),
  applied: z.number().optional(),
  /** Reversed with the chat's Undo. */
  undone: z.boolean().optional(),
  /** Where its changes are on the chart. A damaged one is dropped, not the chat. */
  reveal: Reveal.optional().catch(undefined),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});
export type Turn = z.infer<typeof Turn>;

export const Thread = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The current sitting's session in the shared history, and when the chat last changed the plan. */
  history: z.object({ sessionId: z.string(), lastEditAt: z.number(), summaries: z.array(z.string()) }).optional(),
  /** The latest version of the plan this chat saw, to tell the agent what changed since. */
  lastSeen: z.string().optional(),
  turns: z.array(Turn),
});
export type Thread = z.infer<typeof Thread>;

const ThreadEntry = z.object({ id: z.string(), title: z.string(), updatedAt: z.number() });
const ChatIndex = z.object({ current: z.string().optional(), threads: z.array(ThreadEntry) });
type ChatIndex = z.infer<typeof ChatIndex>;

/** Where chats are kept: the editor's storage in use, a temp folder in tests. Paths are relative to it. */
export interface ChatFiles {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  append(path: string, text: string): Promise<void>;
}

export const FIRST_TITLE = 'Planning';
const INDEX = 'chats/index.json';
const threadPath = (id: string) => `chats/${id}.json`;

function parse<T>(schema: z.ZodType<T>, text: string | null): T | undefined {
  if (text === null) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export class ChatStore {
  constructor(
    private readonly files: ChatFiles,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  private async index(): Promise<ChatIndex> {
    return parse(ChatIndex, await this.files.read(INDEX)) ?? { threads: [] };
  }

  /** Every chat, newest first. */
  async list(): Promise<z.infer<typeof ThreadEntry>[]> {
    return [...(await this.index()).threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async read(id: string): Promise<Thread | undefined> {
    const thread = parse(Thread, await this.files.read(threadPath(id)));
    if (!thread) return undefined;
    // A turn still running when the editor closed never finished.
    for (const turn of thread.turns) if (turn.outcome === 'running') turn.outcome = 'interrupted';
    return thread;
  }

  /** The chat open last, so coming back continues it. The first one is made on first use. */
  async current(): Promise<Thread> {
    const index = await this.index();
    const id = index.current ?? index.threads[0]?.id;
    const thread = id === undefined ? undefined : await this.read(id);
    return thread ?? this.create(index.threads.length === 0 ? FIRST_TITLE : 'New chat');
  }

  async create(title = 'New chat'): Promise<Thread> {
    const at = this.now();
    const thread: Thread = { id: this.newId(), title, createdAt: at, updatedAt: at, turns: [] };
    await this.save(thread);
    return thread;
  }

  /** Opens a chat and makes it the current one. Undefined if it's gone or damaged. */
  async open(id: string): Promise<Thread | undefined> {
    const thread = await this.read(id);
    if (thread) await this.writeIndex(thread);
    return thread;
  }

  async save(thread: Thread): Promise<void> {
    await this.files.write(threadPath(thread.id), JSON.stringify(thread));
    await this.writeIndex(thread);
  }

  private async writeIndex(thread: Thread): Promise<void> {
    const index = await this.index();
    const entry = { id: thread.id, title: thread.title, updatedAt: thread.updatedAt };
    const threads = [entry, ...index.threads.filter((t) => t.id !== thread.id)];
    await this.files.write(INDEX, JSON.stringify({ current: thread.id, threads }));
  }

  /** One line per message, to count how often each kind happens. Stays on this machine. */
  async logKind(entry: {
    at: number;
    kind: MessageKind;
    by: 'model' | 'skipped' | 'fallback';
    model?: string;
    ms?: number;
  }): Promise<void> {
    await this.files.append('chats/kinds.jsonl', `${JSON.stringify(entry)}\n`);
  }
}
