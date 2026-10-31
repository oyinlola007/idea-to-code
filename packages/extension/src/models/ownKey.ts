// The user's own key, through the Vercel AI SDK. This route works in every editor,
// so it's the guaranteed one when the editor has no models of its own.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, jsonSchema, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { ChatEvent, ChatMessage, ChatRequest, ModelProvider } from './provider.js';
import { ModelError } from './provider.js';

export const KEY_PROVIDERS = ['anthropic', 'openai', 'google', 'custom'] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

export interface KeyProviderConfig {
  provider: KeyProvider;
  key: string | undefined;
  /** Only the custom endpoint has one. */
  baseUrl?: string;
}

export function sdkModel(config: KeyProviderConfig, model: string): LanguageModel {
  const apiKey = config.key ?? '';
  switch (config.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'openai':
      return createOpenAI({ apiKey })(model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model);
    case 'custom':
      // Ollama and others need no key, and then no Authorization header goes out.
      return createOpenAICompatible({ name: 'custom', baseURL: config.baseUrl ?? '', ...(config.key === undefined ? {} : { apiKey }) })(
        model,
      );
  }
}

export function toSdkMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.text };
      case 'assistant':
        return {
          role: 'assistant',
          content: [
            ...(message.text === '' ? [] : [{ type: 'text' as const, text: message.text }]),
            ...(message.toolCalls ?? []).map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          ],
        };
      case 'tool':
        return {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: message.callId, toolName: message.name, output: { type: 'text', value: message.result } },
          ],
        };
    }
  });
}

function toSdkTools(request: ChatRequest): ToolSet {
  return Object.fromEntries(
    request.tools.map((definition) => [
      definition.name,
      tool({ description: definition.description, inputSchema: jsonSchema(definition.inputSchema) }),
    ]),
  );
}

/** A provider's own error text can echo the request, so a key is cut out of anything we keep. */
function redact(text: string, key: string | undefined): string {
  return key ? text.split(key).join('[key]') : text;
}

export function toModelError(err: unknown, key: string | undefined, signal?: AbortSignal): ModelError {
  if (err instanceof ModelError) return err;
  if (signal?.aborted === true) return new ModelError('cancelled', 'Cancelled.');
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === 401 || status === 403) return new ModelError('key-rejected', 'The provider rejected this key.');
    if (status === 404) return new ModelError('no-model', "The provider doesn't have this model, or the address is wrong.");
    if (status === 429) return new ModelError('rate-limited', 'The provider says too many requests, or the account is out of credit.');
    if (status === undefined) return new ModelError('unreachable', "Couldn't reach the provider. Check the connection and the address.");
    return new ModelError('failed', `The provider answered with an error (${String(status)}): ${redact(err.message, key).slice(0, 300)}`);
  }
  return new ModelError('failed', `The request failed: ${redact(err instanceof Error ? err.message : String(err), key).slice(0, 300)}`);
}

export class OwnKeyProvider implements ModelProvider {
  constructor(
    private readonly config: KeyProviderConfig,
    private readonly createModel: (config: KeyProviderConfig, model: string) => LanguageModel = sdkModel,
  ) {}

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const { key } = this.config;
    if (key === undefined && this.config.provider !== 'custom') throw new ModelError('not-set-up', 'Add an API key first.');
    try {
      const result = streamText({
        model: this.createModel(this.config, request.model),
        ...(request.system === '' ? {} : { instructions: request.system }),
        messages: toSdkMessages(request.messages),
        // Our own loop runs tools: without an execute, the turn ends with the calls.
        tools: toSdkTools(request),
        maxRetries: 1,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
      });
      for await (const part of result.stream) {
        if (part.type === 'text-delta') yield { type: 'text', text: part.text };
        else if (part.type === 'tool-call')
          yield { type: 'tool-call', call: { id: part.toolCallId, name: part.toolName, input: part.input } };
        else if (part.type === 'error') throw part.error;
        else if (part.type === 'abort') throw new ModelError('cancelled', 'Cancelled.');
        else if (part.type === 'finish') {
          const { inputTokens, outputTokens } = part.totalUsage;
          yield {
            type: 'finish',
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          };
        }
      }
    } catch (err) {
      throw toModelError(err, key, request.signal);
    }
  }
}
