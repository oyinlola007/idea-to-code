// One turn of the built-in agent: our own tool loop. The model's tool calls run
// against the plan in memory (the latest disk version plus this turn's changes), so
// the chart can show them as they happen; the turn is written to disk once, at the end,
// by the caller. A failed change goes back to the model to fix, up to a limit.
import {
  agentToolDefinitions,
  AGENT_INSTRUCTIONS,
  applyOperation,
  describeActivity,
  isReadTool,
  loadFromTexts,
  runReadTool,
  type OpRequest,
} from '@idea-to-code/core';
import { ModelError, type ChatMessage, type ModelProvider, type ToolCall } from '../models/provider.js';
import type { Outcome, StoredMessage } from './transcript.js';

export const MAX_MODEL_CALLS = 16;
export const MAX_FAILURES = 4;

export interface TurnInput {
  provider: ModelProvider;
  model: string;
  /** The conversation, ending with the latest user message. */
  messages: ChatMessage[];
  /** The plan as it is now. */
  texts: Record<string, string>;
  signal: AbortSignal;
  /** Streamed reply text; a new reply starts after each round of tool calls. */
  onText?: (reply: number, text: string) => void;
  /** A tool call, in words, with the plan as it now looks when the call changed it. */
  onActivity?: (activity: { text: string; ok: boolean }, texts?: Record<string, string>) => void;
  maxCalls?: number;
  maxFailures?: number;
}

export interface TurnResult {
  outcome: Exclude<Outcome, 'running' | 'interrupted'>;
  /** The changes that worked, in order, to write at the end. */
  batch: OpRequest[];
  texts: Record<string, string>;
  /** The model's side of the turn, to keep in the transcript. */
  messages: StoredMessage[];
  error?: ModelError;
  usage: { inputTokens: number; outputTokens: number };
}

/** A tool's answer to the model. Errors start with "error", which is how old turns are summarized later. */
function runTool(call: ToolCall, texts: Record<string, string>): { result: string; ok: boolean; texts?: Record<string, string> } {
  if (isReadTool(call.name)) {
    const read = runReadTool(loadFromTexts(texts), call.name, call.input);
    return { result: read.ok ? read.text : `error: ${read.text}`, ok: read.ok };
  }
  const result = applyOperation(texts, { name: call.name, input: call.input });
  if (!result.ok) return { result: `error [${result.code}]: ${result.message}. Fix the call and try again.`, ok: false };
  const created = Object.keys(result.created).length > 0 ? ` created: ${JSON.stringify(result.created)}` : '';
  const warnings = result.warnings.length > 0 ? ` warnings: ${result.warnings.join('; ')}` : '';
  return { result: `ok.${created}${warnings}`, ok: true, texts: result.texts };
}

/** One model call: its text, streamed, and the tool calls it asks for. A failure comes back with whatever was said before it. */
async function ask(
  input: TurnInput,
  conversation: ChatMessage[],
  reply: number,
  usage: TurnResult['usage'],
): Promise<{ text: string; calls: ToolCall[]; error?: ModelError }> {
  let text = '';
  const calls: ToolCall[] = [];
  try {
    const events = input.provider.chat({
      model: input.model,
      system: AGENT_INSTRUCTIONS,
      messages: conversation,
      tools: agentToolDefinitions(),
      signal: input.signal,
    });
    for await (const event of events) {
      if (event.type === 'text') {
        text += event.text;
        input.onText?.(reply, event.text);
      } else if (event.type === 'tool-call') calls.push(event.call);
      else {
        usage.inputTokens += event.inputTokens ?? 0;
        usage.outputTokens += event.outputTokens ?? 0;
      }
    }
    return { text, calls };
  } catch (err) {
    return { text, calls: [], error: asModelError(err) };
  }
}

function asModelError(err: unknown): ModelError {
  return err instanceof ModelError ? err : new ModelError('failed', err instanceof Error ? err.message : String(err));
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const maxCalls = input.maxCalls ?? MAX_MODEL_CALLS;
  const maxFailures = input.maxFailures ?? MAX_FAILURES;
  const conversation = [...input.messages];
  const stored: StoredMessage[] = [];
  const batch: OpRequest[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let texts = input.texts;
  let failures = 0;
  const finish = (outcome: TurnResult['outcome'], error?: ModelError): TurnResult => ({
    outcome,
    batch,
    texts,
    messages: stored,
    usage,
    ...(error === undefined ? {} : { error }),
  });
  const keep = (message: StoredMessage) => {
    stored.push(message);
    conversation.push(message);
  };

  /** Runs one tool call against the plan in memory and tells the model how it went. */
  const run = (call: ToolCall) => {
    if (input.signal.aborted) {
      // Once stopped, the remaining calls still get an answer, so the conversation stays well formed.
      keep({ role: 'tool', callId: call.id, name: call.name, result: 'error: cancelled by the user' });
      return;
    }
    // Described against the plan before the change, so a removed step still has its name.
    const text = describeActivity(loadFromTexts(texts), call.name, call.input);
    const ran = runTool(call, texts);
    if (ran.texts) {
      texts = ran.texts;
      batch.push({ name: call.name, input: call.input });
    }
    if (!ran.ok) failures++;
    input.onActivity?.({ text, ok: ran.ok }, ran.texts);
    keep({ role: 'tool', callId: call.id, name: call.name, result: ran.result });
  };

  for (let reply = 0; reply < maxCalls; reply++) {
    const answer = await ask(input, conversation, reply, usage);
    if (answer.error) {
      // What was said before stopping is kept; calls that never ran are dropped.
      if (answer.text !== '') stored.push({ role: 'assistant', text: answer.text });
      return finish(answer.error.code === 'cancelled' || input.signal.aborted ? 'cancelled' : 'error', answer.error);
    }
    keep(
      answer.calls.length > 0
        ? { role: 'assistant', text: answer.text, toolCalls: answer.calls }
        : { role: 'assistant', text: answer.text },
    );
    if (answer.calls.length === 0) return finish('done');
    answer.calls.forEach(run);
    if (input.signal.aborted) return finish('cancelled');
    if (failures >= maxFailures) return finish('too-many-failures');
  }
  return finish('call-limit');
}
