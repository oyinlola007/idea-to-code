// Decides how much model a message needs. Small edits and questions go to the fast
// model; planning goes to the main one, since small models plan poorly (ITC-15).
// Behind one interface, so the way of deciding can change without touching the chat.
import { ModelError, type ModelProvider } from '../models/provider.js';
import type { MessageKind } from './transcript.js';

export interface Decision {
  kind: MessageKind;
  /** model: the fast model decided. skipped: only one model, so nothing to decide. fallback: it couldn't say. */
  by: 'model' | 'skipped' | 'fallback';
}

export interface Decider {
  decide(text: string, signal?: AbortSignal): Promise<Decision>;
}

const INSTRUCTIONS = `Classify the user's message to a software-planning assistant. Reply with exactly one word:
edit - a small change to things already in the plan: rename, mark done, change a description, add or remove one or two steps.
question - asks about the plan and changes nothing.
plan - designing or reworking: a new feature, a new flow, several steps, or anything bigger or unclear.`;

const KINDS: readonly MessageKind[] = ['edit', 'question', 'plan'];

/** The first kind named in the answer; planning when it names none, since that's the safe route. */
export function parseKind(answer: string): MessageKind | undefined {
  const word = /[a-z]+/.exec(answer.toLowerCase())?.[0];
  return KINDS.find((kind) => kind === word);
}

/** Asks the fast model, which costs a fraction of a cent and a moment. */
export class ModelDecider implements Decider {
  constructor(
    private readonly provider: ModelProvider,
    private readonly model: string,
  ) {}

  async decide(text: string, signal?: AbortSignal): Promise<Decision> {
    try {
      let answer = '';
      const request = {
        model: this.model,
        system: INSTRUCTIONS,
        messages: [{ role: 'user' as const, text }],
        tools: [],
        // Reasoning models spend output on thinking before the one word.
        maxOutputTokens: 512,
        ...(signal === undefined ? {} : { signal }),
      };
      for await (const event of this.provider.chat(request)) if (event.type === 'text') answer += event.text;
      const kind = parseKind(answer);
      return kind ? { kind, by: 'model' } : { kind: 'plan', by: 'fallback' };
    } catch (err) {
      if (err instanceof ModelError && err.code === 'cancelled') throw err;
      return { kind: 'plan', by: 'fallback' };
    }
  }
}

/** With one model for everything, there's nothing to decide. */
export const NO_DECISION: Decider = {
  decide: () => Promise.resolve({ kind: 'plan', by: 'skipped' }),
};
