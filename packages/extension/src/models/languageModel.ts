// The models the editor already has (e.g. Copilot), through VS Code's Language Model
// API. Newer than the engine floor and missing or empty in the forks, so everything
// about it is checked at runtime. The API is passed in, which also makes it testable.
import type { ChatEvent, ChatMessage, ChatRequest, ModelProvider } from './provider.js';
import { ModelError } from './provider.js';

interface LmResponse {
  stream: AsyncIterable<unknown>;
}

export interface LmModel {
  id: string;
  name: string;
  vendor?: string;
  capabilities?: { supportsToolCalling?: boolean };
  sendRequest(messages: unknown[], options: { tools?: unknown[] }, token: unknown): Thenable<LmResponse>;
}

/** The parts of the API the chat needs. Tool calling arrived after the engine floor, so an editor without it has no usable models. */
export interface LmApi {
  selectChatModels(): Thenable<readonly LmModel[]>;
  user(parts: unknown[]): unknown;
  assistant(parts: unknown[]): unknown;
  textPart(text: string): unknown;
  toolCallPart(id: string, name: string, input: unknown): unknown;
  toolResultPart(id: string, text: string): unknown;
  isTextPart(part: unknown): part is { value: string };
  isToolCallPart(part: unknown): part is { callId: string; name: string; input: unknown };
  /** A token that cancels with the signal. */
  token(signal: AbortSignal | undefined): { token: unknown; dispose(): void };
}

/** Models that can call tools. Never rejects: no models is an answer, and the own-key route takes over. */
export async function listEditorModels(api: LmApi | undefined): Promise<LmModel[]> {
  if (!api) return [];
  try {
    const models = await api.selectChatModels();
    return models.filter((model) => model.capabilities?.supportsToolCalling !== false);
  } catch {
    return [];
  }
}

export function toLmMessages(api: LmApi, system: string, messages: readonly ChatMessage[]): unknown[] {
  // The API has no system role. Tool results must arrive together in one user message, right after the calls.
  const out: unknown[] = [];
  let pending: unknown[] = system === '' ? [] : [api.textPart(system)];
  const flush = () => {
    if (pending.length > 0) out.push(api.user(pending));
    pending = [];
  };
  for (const message of messages) {
    if (message.role === 'user') pending.push(api.textPart(message.text));
    else if (message.role === 'tool') pending.push(api.toolResultPart(message.callId, message.result));
    else {
      flush();
      out.push(
        api.assistant([
          ...(message.text === '' ? [] : [api.textPart(message.text)]),
          ...(message.toolCalls ?? []).map((call) => api.toolCallPart(call.id, call.name, call.input)),
        ]),
      );
    }
  }
  flush();
  return out;
}

function toModelError(err: unknown, signal: AbortSignal | undefined): ModelError {
  if (signal?.aborted === true) return new ModelError('cancelled', 'Cancelled.');
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'NoPermissions')
    return new ModelError('no-permission', "This extension doesn't have permission to use that model. Allow it when your editor asks.");
  if (code === 'NotFound') return new ModelError('no-model', 'That model is no longer available in your editor.');
  if (code === 'Blocked') return new ModelError('rate-limited', 'Your editor blocked this request. Try again in a moment.');
  return new ModelError('failed', `The editor's model failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
}

export class LanguageModelProvider implements ModelProvider {
  constructor(private readonly api: LmApi) {}

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const model = (await listEditorModels(this.api)).find((candidate) => candidate.id === request.model);
    if (!model) throw new ModelError('no-model', 'That model is no longer available in your editor.');
    const cancel = this.api.token(request.signal);
    try {
      // The first request is what asks the user for consent, which is why this runs from a click or a chat message.
      const response = await model.sendRequest(
        toLmMessages(this.api, request.system, request.messages),
        { tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        cancel.token,
      );
      for await (const part of response.stream) {
        if (this.api.isTextPart(part)) yield { type: 'text', text: part.value };
        else if (this.api.isToolCallPart(part)) yield { type: 'tool-call', call: { id: part.callId, name: part.name, input: part.input } };
      }
      // The API reports no token counts here.
      yield { type: 'finish' };
    } catch (err) {
      throw toModelError(err, request.signal);
    } finally {
      cancel.dispose();
    }
  }
}
