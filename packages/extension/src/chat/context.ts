// What the model is sent each turn, after the standing instructions and tools:
// the conversation, kept small, then the latest message carrying a fresh view of
// the plan. Only the latest message ever has the plan, so nothing stale lingers,
// and everything before it stays identical from turn to turn, for caching.
import { asPlanData, summarizeToolCall } from '@idea-to-code/core';
import type { ChatMessage } from '../models/provider.js';
import type { StoredMessage, Turn } from './transcript.js';

/** Turns sent in full. Older ones are summarized in a line each. */
export const KEEP_TURNS = 6;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Older turns, a line each: what was asked and what changed. Built from the transcript, so it costs no model call. */
export function summarizeEarlier(turns: readonly Turn[]): string {
  const lines = turns.map((turn) => `- "${clip(turn.user.replace(/\s+/g, ' '), 120)}" → ${turn.summary ?? 'no changes'}`);
  return `Earlier in this chat:\n${lines.join('\n')}`;
}

/** A past turn's tool results shrink to a line: the model already acted on them. */
function shrunk(messages: readonly StoredMessage[]): ChatMessage[] {
  const inputs = new Map<string, unknown>();
  return messages.map((message): ChatMessage => {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) inputs.set(call.id, call.input);
      return message.toolCalls
        ? { role: 'assistant', text: message.text, toolCalls: message.toolCalls }
        : { role: 'assistant', text: message.text };
    }
    const ok = !message.result.startsWith('error');
    return {
      role: 'tool',
      callId: message.callId,
      name: message.name,
      result: summarizeToolCall(message.name, inputs.get(message.callId), ok),
    };
  });
}

/** The conversation so far, without the plan: recent turns in full, older ones as a summary. */
export function conversation(turns: readonly Turn[], keep = KEEP_TURNS): ChatMessage[] {
  const older = turns.slice(0, Math.max(turns.length - keep, 0));
  const recent = turns.slice(older.length);
  const out: ChatMessage[] = [];
  if (older.length > 0) out.push({ role: 'user', text: summarizeEarlier(older) });
  for (const turn of recent) {
    out.push({ role: 'user', text: turn.user });
    out.push(...shrunk(turn.messages));
  }
  return out;
}

export interface Fresh {
  /** The outline, the flow being viewed and where the user is. */
  mapView: string;
  /** What changed outside this chat since its last turn. */
  since?: string;
  /** What happened to the plan lately, for a chat's first message. */
  recent?: string;
}

/** The latest message: the plan as it is now, as data, then what the user wrote. */
export function latestMessage(text: string, fresh: Fresh): ChatMessage {
  const parts = [asPlanData(fresh.mapView)];
  if (fresh.recent !== undefined) parts.push(asPlanData(`Recent work on this plan:\n${fresh.recent}`));
  if (fresh.since !== undefined) parts.push(asPlanData(`Changed by someone else since your last turn: ${fresh.since}`));
  parts.push(text);
  return { role: 'user', text: parts.join('\n\n') };
}
