import { ModelSettingsView } from '@idea-to-code/core';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { LanguageModelProvider, listEditorModels, toLmMessages, type LmApi, type LmModel } from '../src/models/languageModel.js';
import { ModelService, type Secrets, type UserConfig } from '../src/models/modelService.js';
import { OwnKeyProvider, sdkModel, toModelError, toSdkMessages } from '../src/models/ownKey.js';
import { ModelError, type ChatEvent, type ChatMessage, type ChatRequest } from '../src/models/provider.js';

const SECRET = 'sk-very-secret-value';

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const request: ChatRequest = { model: 'm', system: 'Be brief.', messages: [{ role: 'user', text: 'Hi' }], tools: [] };

function memoryConfig(initial: Record<string, unknown> = {}): UserConfig & { values: Record<string, unknown> } {
  const values = { ...initial };
  return {
    values,
    get: (key) => values[key],
    set: (key, value) => {
      values[key] = value;
      return Promise.resolve();
    },
  };
}

function memorySecrets(initial: Record<string, string> = {}): Secrets {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(values.get(key)),
    store: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

/** A fake of the editor's API. Parts are tagged objects, as easy to read back as the real classes. */
function fakeLm(models: LmModel[], overrides: Partial<LmApi> = {}): LmApi {
  return {
    selectChatModels: () => Promise.resolve(models),
    user: (parts) => ({ role: 'user', parts }),
    assistant: (parts) => ({ role: 'assistant', parts }),
    textPart: (value) => ({ kind: 'text', value }),
    toolCallPart: (callId, name, input) => ({ kind: 'call', callId, name, input }),
    toolResultPart: (callId, text) => ({ kind: 'result', callId, text }),
    isTextPart: (part): part is { value: string } => (part as { kind?: string }).kind === 'text',
    isToolCallPart: (part): part is { callId: string; name: string; input: unknown } => (part as { kind?: string }).kind === 'call',
    token: () => ({ token: {}, dispose: () => undefined }),
    ...overrides,
  };
}

function lmModel(id: string, parts: unknown[] = [], overrides: Partial<LmModel> = {}): LmModel {
  return {
    id,
    name: id,
    sendRequest: () =>
      Promise.resolve({
        stream: (async function* () {
          for (const part of parts) yield await Promise.resolve(part);
        })(),
      }),
    ...overrides,
  };
}

async function* emptyStream(): AsyncGenerator {
  // Nothing comes back, as if the model had nothing to say.
  await Promise.resolve();
  yield* [];
}

function apiError(statusCode: number | undefined, message = 'nope'): APICallError {
  return new APICallError({ message, url: 'https://x', requestBodyValues: {}, ...(statusCode === undefined ? {} : { statusCode }) });
}

function service(config: Record<string, unknown> = {}, secrets: Record<string, string> = {}, lm?: LmApi) {
  return new ModelService(memoryConfig(config), memorySecrets(secrets), () => lm);
}

describe('the guaranteed fallback', () => {
  it('offers your own key when the editor has no Language Model API', async () => {
    const view = await service().view();
    expect(view.source).toBe('key');
    expect(view.editorModels).toEqual([]);
  });

  it('offers your own key when the API returns no models, as in the forks', async () => {
    expect((await service({}, {}, fakeLm([])).view()).source).toBe('key');
  });

  it('offers your own key when asking for models fails', async () => {
    const lm = fakeLm([], { selectChatModels: () => Promise.reject(new Error('boom')) });
    expect((await service({}, {}, lm).view()).source).toBe('key');
  });

  it('falls back even if the editor was chosen earlier', async () => {
    const view = await service({ source: 'editor' }, { 'ideaToCode.key.anthropic': SECRET }, fakeLm([])).view();
    expect(view.source).toBe('key');
    const { provider } = await service({ source: 'editor' }, { 'ideaToCode.key.anthropic': SECRET }, fakeLm([])).model('large');
    expect(provider).toBeInstanceOf(OwnKeyProvider);
  });

  it("uses the editor's models when there are some, unless your key was chosen", async () => {
    const lm = fakeLm([lmModel('copilot')]);
    expect((await service({}, {}, lm).view()).source).toBe('editor');
    expect((await service({ source: 'key' }, {}, lm).view()).source).toBe('key');
    expect((await service({}, {}, lm).model('large')).provider).toBeInstanceOf(LanguageModelProvider);
  });

  it('leaves out editor models that cannot call tools', async () => {
    const models = [
      lmModel('a', [], { capabilities: { supportsToolCalling: false } }),
      lmModel('b'),
      lmModel('c', [], { capabilities: {} }),
    ];
    expect((await listEditorModels(fakeLm(models))).map((m) => m.id)).toEqual(['b', 'c']);
  });
});

describe('keys', () => {
  it('never reach the view, which only says one is saved', async () => {
    const view = await service({ source: 'key' }, { 'ideaToCode.key.openai': SECRET }).view();
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.providers.find((p) => p.id === 'openai')?.hasKey).toBe(true);
    expect(view.providers.find((p) => p.id === 'anthropic')?.hasKey).toBe(false);
    expect(() => ModelSettingsView.parse(view)).not.toThrow();
  });

  it('never go into settings', async () => {
    const config = memoryConfig();
    const secrets = memorySecrets();
    const models = new ModelService(config, secrets, () => undefined);
    await models.saveKey('openai', `  ${SECRET}  `);
    await models.update({ provider: 'openai', large: 'gpt-5.5' });
    expect(JSON.stringify(config.values)).not.toContain(SECRET);
    await expect(secrets.get('ideaToCode.key.openai')).resolves.toBe(SECRET);
  });

  it('can be removed', async () => {
    const models = service({ provider: 'openai' }, { 'ideaToCode.key.openai': SECRET });
    await models.removeKey('openai');
    expect((await models.view()).providers.find((p) => p.id === 'openai')?.hasKey).toBe(false);
  });

  it('are cut out of any error text, even one a provider echoed', () => {
    const err = toModelError(apiError(500, `bad request for ${SECRET}`), SECRET);
    expect(err.message).toContain('500');
    expect(err.message).not.toContain(SECRET);
    expect(toModelError(new Error(`failed: ${SECRET}`), SECRET).message).not.toContain(SECRET);
  });
});

describe('what the chat gets', () => {
  it('says what is missing, in words', async () => {
    await expect(service().model('large')).rejects.toMatchObject({
      code: 'not-set-up',
      message: expect.stringContaining('Anthropic') as string,
    });
    await expect(service({ provider: 'custom' }).model('large')).rejects.toMatchObject({ code: 'not-set-up' });
    await expect(service({ provider: 'custom', baseUrl: 'ftp://x' }).model('large')).rejects.toMatchObject({ code: 'not-set-up' });
    await expect(service({ provider: 'custom', baseUrl: 'http://localhost:1/v1' }).model('large')).rejects.toMatchObject({
      message: 'Choose a model first.',
    });
  });

  it('has a different default per tier, and a choice per provider that survives switching', async () => {
    const models = service({ provider: 'openai' }, { 'ideaToCode.key.openai': SECRET, 'ideaToCode.key.google': SECRET });
    await expect(models.model('large')).resolves.toMatchObject({ model: 'gpt-6.1-sol' });
    await expect(models.model('small')).resolves.toMatchObject({ model: 'gpt-6.1-terra' });

    await models.update({ small: 'gpt-5.4-nano' });
    await models.update({ provider: 'google' });
    expect((await models.view()).small).toBe('gemini-3.6-flash');
    await models.update({ provider: 'openai' });
    expect((await models.view()).small).toBe('gpt-5.4-nano');
  });

  it("lets the editor's small tier follow its main one until chosen", async () => {
    const models = service({}, {}, fakeLm([lmModel('first'), lmModel('second')]));
    await models.update({ large: 'second' });
    expect(await models.view()).toMatchObject({ large: 'second', small: 'second' });
    await models.update({ small: 'first' });
    expect(await models.view()).toMatchObject({ large: 'second', small: 'first' });
  });

  it('needs no key for a custom endpoint', async () => {
    const models = service({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', tiers: { custom: { large: 'llama' } } });
    await expect(models.model('large')).resolves.toMatchObject({ model: 'llama' });
  });

  it('warns when a key would travel in the clear to another machine', async () => {
    const key = { 'ideaToCode.key.custom': SECRET };
    expect((await service({ provider: 'custom', baseUrl: 'http://example.com/v1' }, key).view()).sendsKeyInClear).toBe(true);
    expect((await service({ provider: 'custom', baseUrl: 'https://example.com/v1' }, key).view()).sendsKeyInClear).toBeUndefined();
    expect((await service({ provider: 'custom', baseUrl: 'http://localhost:11434/v1' }, key).view()).sendsKeyInClear).toBeUndefined();
    expect((await service({ provider: 'custom', baseUrl: 'http://example.com/v1' }).view()).sendsKeyInClear).toBeUndefined();
  });

  it('survives settings that make no sense', async () => {
    const view = await service({ provider: 'nonsense', tiers: 'broken', source: 42 }).view();
    expect(view.provider).toBe('anthropic');
    expect(view.large).toBe('claude-opus-5-5');
  });
});

describe('test connection', () => {
  const answering = (id: string) => lmModel(id, [{ kind: 'text', value: 'OK' }]);

  it('tries each tier, and only once when both use one model', async () => {
    let calls = 0;
    const model = lmModel('only', [], {
      sendRequest: () => {
        calls++;
        return Promise.resolve({ stream: emptyStream() });
      },
    });
    const results = await service({}, {}, fakeLm([model])).test();
    expect(results).toEqual([
      { tier: 'large', model: 'only', ok: true },
      { tier: 'small', model: 'only', ok: true },
    ]);
    expect(calls).toBe(1);
  });

  it('reports each failure in words, with no key', async () => {
    const results = await service().test();
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0]?.message).toContain('API key');
  });

  it('reports a model that answers beside one that does not', async () => {
    const models = service({ tiers: { editor: { large: 'good', small: 'gone' } } }, {}, fakeLm([answering('good')]));
    const results = await models.test();
    expect(results.map((r) => [r.tier, r.ok])).toEqual([
      ['large', true],
      ['small', false],
    ]);
  });
});

describe('own-key provider', () => {
  const stream = (parts: unknown[]) =>
    new MockLanguageModelV4({ doStream: () => Promise.resolve({ stream: simulateReadableStream({ chunks: parts as never[] }) }) });
  const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };

  it('streams text and tool calls, leaving the tools to the caller', async () => {
    const model = stream([
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'Add' },
      { type: 'text-delta', id: '1', delta: 'ing' },
      { type: 'text-end', id: '1' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'add_feature', input: '{"label":"Fees"}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
    ]);
    const provider = new OwnKeyProvider({ provider: 'openai', key: SECRET }, () => model);
    const tools = [{ name: 'add_feature', description: 'Add', inputSchema: { type: 'object', properties: { label: { type: 'string' } } } }];
    const events = await collect(provider.chat({ ...request, tools }));
    expect(events).toEqual([
      { type: 'text', text: 'Add' },
      { type: 'text', text: 'ing' },
      { type: 'tool-call', call: { id: 'c1', name: 'add_feature', input: { label: 'Fees' } } },
      { type: 'finish', inputTokens: 3, outputTokens: 2 },
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('refuses without a key, before any request', async () => {
    const provider = new OwnKeyProvider({ provider: 'openai', key: undefined }, () => {
      throw new Error('should not be called');
    });
    await expect(collect(provider.chat(request))).rejects.toMatchObject({ code: 'not-set-up' });
  });

  it.each([
    [401, 'key-rejected'],
    [403, 'key-rejected'],
    [404, 'no-model'],
    [429, 'rate-limited'],
    [500, 'failed'],
    [undefined, 'unreachable'],
  ] as const)('turns a %s from the provider into %s', (status, code) => {
    expect(toModelError(apiError(status), SECRET).code).toBe(code);
  });

  it('calls a stop a cancellation, not a failure', () => {
    const controller = new AbortController();
    controller.abort();
    expect(toModelError(new Error('aborted'), SECRET, controller.signal).code).toBe('cancelled');
  });

  it('turns a failure in the stream into a ModelError', async () => {
    const model = new MockLanguageModelV4({ doStream: () => Promise.reject(apiError(401)) });
    const provider = new OwnKeyProvider({ provider: 'openai', key: SECRET }, () => model);
    await expect(collect(provider.chat(request))).rejects.toBeInstanceOf(ModelError);
    await expect(collect(provider.chat(request))).rejects.toMatchObject({ code: 'key-rejected' });
  });

  it('builds a model for every provider', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) expect(sdkModel({ provider, key: SECRET }, 'm')).toBeDefined();
    expect(sdkModel({ provider: 'custom', key: undefined, baseUrl: 'http://localhost:1/v1' }, 'm')).toBeDefined();
  });

  it('carries a whole tool round in the messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Add fees' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'add_feature', input: { label: 'Fees' } }] },
      { role: 'tool', callId: 'c1', name: 'add_feature', result: 'ok' },
    ];
    expect(toSdkMessages(messages)).toEqual([
      { role: 'user', content: 'Add fees' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'add_feature', input: { label: 'Fees' } }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'add_feature', output: { type: 'text', value: 'ok' } }],
      },
    ]);
  });
});

describe('Language Model provider', () => {
  it('has no system role, so instructions lead the first message, and results arrive together after the calls', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: 'Add two' },
      {
        role: 'assistant',
        text: 'Adding',
        toolCalls: [
          { id: 'a', name: 'add', input: 1 },
          { id: 'b', name: 'add', input: 2 },
        ],
      },
      { role: 'tool', callId: 'a', name: 'add', result: 'ok' },
      { role: 'tool', callId: 'b', name: 'add', result: 'ok' },
    ];
    expect(toLmMessages(fakeLm([]), 'Be brief.', messages)).toEqual([
      {
        role: 'user',
        parts: [
          { kind: 'text', value: 'Be brief.' },
          { kind: 'text', value: 'Add two' },
        ],
      },
      {
        role: 'assistant',
        parts: [
          { kind: 'text', value: 'Adding' },
          { kind: 'call', callId: 'a', name: 'add', input: 1 },
          { kind: 'call', callId: 'b', name: 'add', input: 2 },
        ],
      },
      {
        role: 'user',
        parts: [
          { kind: 'result', callId: 'a', text: 'ok' },
          { kind: 'result', callId: 'b', text: 'ok' },
        ],
      },
    ]);
  });

  it('streams text and tool calls from the editor', async () => {
    const model = lmModel('m', [
      { kind: 'text', value: 'Hi' },
      { kind: 'call', callId: 'c', name: 'add', input: {} },
    ]);
    await expect(collect(new LanguageModelProvider(fakeLm([model])).chat(request))).resolves.toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool-call', call: { id: 'c', name: 'add', input: {} } },
      { type: 'finish' },
    ]);
  });

  it('explains a refused consent, and a model that has gone', async () => {
    const refusing = lmModel('m', [], { sendRequest: () => Promise.reject(Object.assign(new Error('no'), { code: 'NoPermissions' })) });
    await expect(collect(new LanguageModelProvider(fakeLm([refusing])).chat(request))).rejects.toMatchObject({ code: 'no-permission' });
    await expect(collect(new LanguageModelProvider(fakeLm([])).chat(request))).rejects.toMatchObject({ code: 'no-model' });
  });

  it('always releases the cancel token', async () => {
    let disposed = 0;
    const lm = fakeLm([lmModel('m', [], { sendRequest: () => Promise.reject(new Error('x')) })], {
      token: () => ({
        token: {},
        dispose: () => {
          disposed++;
        },
      }),
    });
    await expect(collect(new LanguageModelProvider(lm).chat(request))).rejects.toBeInstanceOf(ModelError);
    expect(disposed).toBe(1);
  });
});
