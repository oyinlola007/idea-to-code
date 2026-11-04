import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeAll, describe, expect, it } from 'vitest';
import { runTurn, type TurnInput } from '../../src/chat/turn.js';
import { OwnKeyProvider } from '../../src/models/ownKey.js';
import { ModelError, type ModelProvider } from '../../src/models/provider.js';
import { scripted, toolshedTexts } from './helpers.js';

let texts: Record<string, string>;
beforeAll(async () => {
  texts = await toolshedTexts();
});

const ask = (provider: ModelProvider, extra: Partial<TurnInput> = {}) =>
  runTurn({
    provider,
    model: 'm',
    messages: [{ role: 'user', text: 'Plan reminders' }],
    texts,
    signal: new AbortController().signal,
    ...extra,
  });

const fill = {
  name: 'fill_flow',
  input: {
    flowId: 'reminders',
    nodes: [
      { key: 'a', type: 'step', label: 'Find tomorrow’s pickups' },
      { key: 'b', type: 'step', label: 'Text the borrower' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  },
};

describe('a turn', () => {
  it('runs the model’s changes against the plan in memory, then ends with its reply', async () => {
    const activities: string[] = [];
    let previewed: Record<string, string> | undefined;
    const result = await ask(scripted([{ text: 'Planning it.', calls: [fill] }, { text: 'Reminders is planned.' }]), {
      onActivity: (activity, changed) => {
        activities.push(activity.text);
        previewed = changed ?? previewed;
      },
    });
    expect(result.outcome).toBe('done');
    expect(result.batch).toEqual([fill]);
    expect(result.texts['plan/features/reminders.yaml']).toContain('Text the borrower');
    expect(previewed).toEqual(result.texts);
    expect(activities).toEqual(['Planning Reminders…']);
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    // The plan on disk is the caller's business: nothing was written.
    expect(texts['plan/features/reminders.yaml']).toBeUndefined();
  });

  it('sends a failed change back to the model, which fixes it', async () => {
    const model = scripted([
      { calls: [{ name: 'set_status', input: { id: 'pick-date', status: 'done' } }] },
      { calls: [{ name: 'set_status', input: { id: 'pick-dates', status: 'in_progress' } }] },
      { text: 'Done.' },
    ]);
    const result = await ask(model);
    expect(result.outcome).toBe('done');
    expect(result.batch).toHaveLength(1);
    const reply = model.requests[1]?.messages.at(-1);
    expect(reply).toMatchObject({
      role: 'tool',
      result: expect.stringMatching(/^error \[not-found\]: no node "pick-date". Similar ids: .*pick-dates/) as string,
    });
  });

  it('gives up after too many failed changes', async () => {
    const bad = { calls: [{ name: 'set_status', input: { id: 'nope', status: 'done' } }] };
    const result = await ask(scripted([bad, bad, bad, bad, bad]));
    expect(result.outcome).toBe('too-many-failures');
    expect(result.batch).toEqual([]);
  });

  it('stops at the call limit', async () => {
    const read = { calls: [{ name: 'get_outline', input: {} }] };
    expect((await ask(scripted([read, read, read]), { maxCalls: 2 })).outcome).toBe('call-limit');
  });

  it('lets a read see the turn’s own changes', async () => {
    const model = scripted([
      {
        calls: [
          { name: 'add_feature', input: { label: 'Fees' } },
          { name: 'get_outline', input: {} },
        ],
      },
      { text: 'ok' },
    ]);
    await ask(model);
    const outline = model.requests[1]?.messages.at(-1);
    expect(outline).toMatchObject({
      role: 'tool',
      name: 'get_outline',
      result: expect.stringContaining('- fees: Fees (no steps yet)') as string,
    });
    expect(outline).toMatchObject({ result: expect.stringMatching(/^<plan>/) as string });
  });

  it('keeps what was done when stopped, and answers every call so the conversation stays whole', async () => {
    const controller = new AbortController();
    const model = scripted([{ calls: [fill] }, 'hang']);
    const turn = ask(model, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await turn;
    expect(result.outcome).toBe('cancelled');
    expect(result.batch).toEqual([fill]);
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', text: 'Working on it' });
  });

  it('reports a model failure', async () => {
    const result = await ask(scripted([new ModelError('rate-limited', 'Too many requests.')]));
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'rate-limited' } });
  });

  it('works through the real AI SDK', async () => {
    const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const responses = [
      [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'add_feature', input: '{"label":"Fees"}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ],
      [
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Added Fees.' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ],
    ];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: () => Promise.resolve({ stream: simulateReadableStream({ chunks: (responses[call++] ?? []) as never[] }) }),
    });
    const result = await ask(new OwnKeyProvider({ provider: 'openai', key: 'sk-test' }, () => model));
    expect(result.outcome).toBe('done');
    expect(result.batch).toEqual([{ name: 'add_feature', input: { label: 'Fees' } }]);
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', text: 'Added Fees.' });
    // The second request carried the tool's result back.
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('featureId');
  });
});
