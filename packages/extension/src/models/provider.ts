// What the built-in chat needs from a model, whoever provides it. One call is one
// model turn: the chat runs its own tool loop on top, so no provider executes tools.
import type { ToolDefinition } from '@idea-to-code/core';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: string };

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type ChatEvent =
  { type: 'text'; text: string } | { type: 'tool-call'; call: ToolCall } | { type: 'finish'; inputTokens?: number; outputTokens?: number };

export interface ModelProvider {
  /** Fails with a ModelError, never with a provider's own error, whose text could hold a key. */
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
}

export type ModelErrorCode =
  'not-set-up' | 'key-rejected' | 'no-model' | 'no-permission' | 'rate-limited' | 'unreachable' | 'cancelled' | 'failed';

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
