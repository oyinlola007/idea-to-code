import { buildViewModel, loadFromTexts, summarizePlan, type AppState } from '@idea-to-code/core';
import { buildHistoryView, DEFAULT_IDLE_MS, HistoryStore, NodePlanFiles, ProjectService } from '@idea-to-code/store';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatService, type ChatHost } from '../../src/chat/chatService.js';
import { ChatStore } from '../../src/chat/transcript.js';
import { ModelError, type ModelProvider } from '../../src/models/provider.js';
import { MemoryChatFiles, scripted, toolshedFolder, type Script } from './helpers.js';

interface Harness {
  chat: ChatService;
  service: ProjectService;
  root: string;
  files: MemoryChatFiles;
  busy: boolean[];
  previews: (Record<string, string> | null)[];
  reveals: { level: string; ids: string[]; bringForward: boolean }[];
  clock: { now: number };
  refresh(): Promise<void>;
  /** How many times the chat asked the editor to start a plan. */
  starts: number[];
  /** Sets up a model, as choosing one in Settings does. */
  chooseModel(provider: ModelProvider): Promise<void>;
  /** Makes a model work without announcing it, as when permission is granted outside Settings. */
  chooseModelQuietly(provider: ModelProvider): Promise<void>;
  reopen(): Promise<void>;
}

const opened: ChatService[] = [];
afterEach(() => {
  for (const chat of opened.splice(0)) chat.dispose();
});

/** A chat on a real plan and history, with a fake editor around it. */
async function harness(
  models: { large: ModelProvider | ModelError; small?: ModelProvider; sameModel?: boolean },
  options: { noPlan?: boolean } = {},
): Promise<Harness> {
  const root = await toolshedFolder();
  const service = await ProjectService.open({
    files: new NodePlanFiles(root),
    store: new HistoryStore(await mkdtemp(join(tmpdir(), 'itc-chat-data-'))),
    root,
  });
  const clock = { now: Date.now() };
  let state: AppState = { kind: 'no-plan', trusted: true };
  const listeners = new Set<() => void>();
  const busy: boolean[] = [];
  const previews: (Record<string, string> | null)[] = [];
  const reveals: { level: string; ids: string[]; bringForward: boolean }[] = [];
  const starts: number[] = [];
  // A folder without a plan shows as one until the chat starts it.
  let planned = options.noPlan !== true;
  const refresh = async () => {
    if (!planned) return;
    const texts = await service.readPlan();
    const history = service.projectHistory;
    state = {
      kind: 'plan',
      trusted: true,
      folder: 'toolshed',
      plan: summarizePlan(texts),
      model: buildViewModel(loadFromTexts(texts)),
      history: history ? buildHistoryView(await history.listSessions(), await history.listSnapshots()) : null,
    };
    for (const listener of listeners) listener();
  };
  await refresh();
  const host: ChatHost = {
    service: () => service,
    state: () => state,
    hasFolder: () => true,
    level: () => 'bookings',
    setPreview: (texts) => previews.push(texts),
    setBusy: (b) => busy.push(b),
    reveal: (reveal, bringForward) => reveals.push({ ...reveal, bringForward }),
    startPlan: async () => {
      starts.push(clock.now);
      planned = true;
      await refresh();
      return true;
    },
    undo: async (latest) => {
      const result = await service.undo({ actor: 'user', expectedLatest: latest });
      await refresh();
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const files = new MemoryChatFiles();
  const modelListeners = new Set<() => void>();
  const make = () =>
    new ChatService({
      host,
      models: {
        model: (tier) => {
          if (models.large instanceof ModelError) return Promise.reject(models.large);
          const provider = tier === 'small' && models.small ? models.small : models.large;
          return Promise.resolve({ provider, model: tier === 'small' && !models.sameModel ? 'fast' : 'main' });
        },
        onDidChange: (listener) => {
          modelListeners.add(listener);
          return { dispose: () => modelListeners.delete(listener) };
        },
      },
      store: new ChatStore(files, () => clock.now),
      editor: 'Visual Studio Code',
      log: { info: () => undefined, warn: () => undefined },
      now: () => clock.now,
    });
  const chat = make();
  opened.push(chat);
  await chat.start();
  const chooseModel = async (provider: ModelProvider) => {
    models.large = provider;
    for (const listener of modelListeners) listener();
    // Let the chat check the model and answer anything waiting.
    for (let i = 0; i < 50 && (h.chat.view().busy || h.chat.view().status !== 'ready'); i++) await new Promise((r) => setTimeout(r, 5));
    while (h.chat.view().busy) await new Promise((r) => setTimeout(r, 5));
  };
  /** A reload: the chat service starts again on the same saved chats. */
  const reopen = async () => {
    h.chat.dispose();
    modelListeners.clear();
    h.chat = make();
    opened.push(h.chat);
    await h.chat.start();
  };
  const chooseModelQuietly = (provider: ModelProvider) => {
    models.large = provider;
    return Promise.resolve();
  };
  const h: Harness = {
    chat,
    service,
    root,
    files,
    busy,
    previews,
    reveals,
    clock,
    refresh,
    starts,
    chooseModel,
    chooseModelQuietly,
    reopen,
  };
  return h;
}

const fillReminders: Script = {
  text: 'Planning Reminders.',
  calls: [
    {
      name: 'fill_flow',
      input: { flowId: 'reminders', nodes: [{ key: 'a', type: 'step', label: 'Text the borrower' }], edges: [] },
    },
    { name: 'set_status', input: { id: 'pick-dates', status: 'in_progress' } },
  ],
};

const snapshots = async (h: Harness) => (await h.service.projectHistory?.listSnapshots()) ?? [];

describe('the first message', () => {
  it('starts the plan when there is none, then plans', async () => {
    const h = await harness({ large: scripted([fillReminders, { text: 'Planned.' }]), sameModel: true }, { noPlan: true });
    expect(h.chat.view().status).toBe('no-plan');
    await h.chat.send('A tool-lending app for neighbours');
    expect(h.starts).toHaveLength(1);
    expect(h.chat.view().items.map((i) => i.kind)).toEqual(['user', 'assistant', 'assistant', 'changes']);
  });

  it('names the project before the first message, once there is a plan', async () => {
    const h = await harness({ large: scripted([]), sameModel: true }, { noPlan: true });
    expect(h.chat.view().project).toBeUndefined();
    expect((await harness({ large: scripted([]), sameModel: true })).chat.view().project).toBe('Toolshed');
  });

  it('never starts a plan that is already there', async () => {
    const h = await harness({ large: scripted([{ text: 'It has five features.' }]), sameModel: true });
    await h.chat.send('What is in the plan?');
    expect(h.starts).toEqual([]);
  });
});

describe('a chat turn', () => {
  it('writes once, as one agent version in a chat session, and links it to the message', async () => {
    const large = scripted([fillReminders, { text: 'Reminders texts the borrower.' }]);
    const h = await harness({ large, sameModel: true });
    const before = (await snapshots(h)).length;
    await h.chat.send('Plan the reminders');
    await h.refresh();

    const all = await snapshots(h);
    expect(all).toHaveLength(before + 1);
    const version = all.at(-1);
    expect(version).toMatchObject({ source: 'agent', actor: 'built-in agent' });
    const session = (await h.service.projectHistory?.listSessions())?.find((s) => s.id === version?.session);
    expect(session).toMatchObject({ kind: 'chat', editor: 'Visual Studio Code', title: 'Planning' });

    const view = h.chat.view();
    expect(view.status).toBe('ready');
    expect(view.busy).toBe(false);
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'assistant', 'changes']);
    expect(view.items.at(-1)).toMatchObject({ kind: 'changes', session: version?.session, undoable: true });
    expect(await readFile(join(h.root, 'plan/features/reminders.yaml'), 'utf8')).toContain('Text the borrower');
    // Changes in two features: the overview, with both pointed out, once the turn is over.
    const reveal = { level: 'overview', ids: ['bookings', 'reminders'] };
    expect(view.items.at(-1)).toMatchObject({ reveal });
    expect(h.reveals).toEqual([{ ...reveal, bringForward: false }]);
    h.chat.showChanges(reveal);
    expect(h.reveals.at(-1)).toEqual({ ...reveal, bringForward: true });
    // The transcript, not the shared history, holds the link.
    expect(h.files.files.get(`chats/${view.current?.id ?? ''}.json`)).toContain(version?.id ?? 'missing');
  });

  it('shows the changes on the chart as they happen, and pauses chart edits meanwhile', async () => {
    const h = await harness({ large: scripted([fillReminders, { text: 'Done.' }]), sameModel: true });
    await h.chat.send('Plan the reminders');
    expect(h.busy).toEqual([true, false]);
    expect(h.previews.at(-1)).toBeNull();
    expect(h.previews.filter((p) => p !== null).at(-1)?.['plan/features/reminders.yaml']).toContain('Text the borrower');
  });

  it('sends the plan with the latest message only, and a "since" line after someone else changed it', async () => {
    const large = scripted([{ text: 'First.' }, { text: 'Second.' }]);
    const h = await harness({ large, sameModel: true });
    await h.chat.send('What is in bookings?');
    const first = large.requests[0];
    expect(first?.messages).toHaveLength(1);
    const firstText = first?.messages[0]?.role === 'user' ? first.messages[0].text : '';
    expect(firstText).toContain('## The flow the user is looking at\nFlow bookings');
    expect(firstText).toContain('Recent work on this plan');

    const map = join(h.root, 'plan/map.yaml');
    await writeFile(map, (await readFile(map, 'utf8')).replace('label: Reminders', 'label: Text reminders'));
    await h.service.sync();
    await h.refresh();
    await h.chat.send('And now?');
    const second = large.requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[0]).toEqual({ role: 'user', text: 'What is in bookings?' });
    const latest = second.at(-1)?.role === 'user' ? (second.at(-1) as { text: string }).text : '';
    expect(latest).toContain("Changed by someone else since your last turn: Renamed 'Reminders' to 'Text reminders'");
    expect(latest).not.toContain('Recent work on this plan');
  });

  it('sends small edits and questions to the fast model, and planning to the main one', async () => {
    const small = scripted([{ text: 'question' }, { text: 'It has 8 steps.' }, { text: 'plan' }]);
    const large = scripted([{ text: 'Here is a plan.' }]);
    const h = await harness({ large, small });
    await h.chat.send('How many steps in bookings?');
    await h.chat.send('Design a returns feature');
    expect(small.requests.map((r) => r.model)).toEqual(['fast', 'fast', 'fast']);
    expect(large.requests.map((r) => r.model)).toEqual(['main']);
    const kinds = (h.files.files.get('chats/kinds.jsonl') ?? '')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; by: string });
    expect(kinds.map((k) => `${k.kind}/${k.by}`)).toEqual(['question/model', 'plan/model']);
  });

  it('skips the decision when one model does everything', async () => {
    const large = scripted([{ text: 'Sure.' }]);
    const h = await harness({ large, sameModel: true });
    await h.chat.send('Hi');
    expect(large.requests).toHaveLength(1);
    expect(h.files.files.get('chats/kinds.jsonl')).toContain('"by":"skipped"');
  });

  it('keeps what was done when stopped, as one version Undo reverses', async () => {
    const large = scripted([fillReminders, 'hang']);
    const h = await harness({ large, sameModel: true });
    const before = (await snapshots(h)).length;
    const turn = h.chat.send('Plan the reminders');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.chat.view().busy).toBe(true);
    h.chat.cancel();
    await turn;
    await h.refresh();
    expect(await snapshots(h)).toHaveLength(before + 1);
    expect(h.chat.view().items.at(-1)).toMatchObject({ kind: 'changes', cancelled: true, undoable: true });

    await h.chat.undo();
    expect(await readFile(join(h.root, 'plan/features/reminders.yaml'), 'utf8').catch(() => 'gone')).toBe('gone');
    expect(h.chat.view().items.at(-1)).toMatchObject({ kind: 'changes', undone: true });
    expect(h.chat.view().items.at(-1)).not.toHaveProperty('undoable');
    // Nothing left to point at.
    expect(h.chat.view().items.at(-1)).not.toHaveProperty('reveal');
  });

  it('records nothing for a question', async () => {
    const h = await harness({
      large: scripted([{ calls: [{ name: 'get_outline', input: {} }] }, { text: 'Five features.' }]),
      sameModel: true,
    });
    const before = (await snapshots(h)).length;
    await h.chat.send('How many features?');
    expect(await snapshots(h)).toHaveLength(before);
    expect(h.chat.view().items.map((i) => i.kind)).toEqual(['user', 'assistant']);
  });

  it('starts a new history session after a break, closing the last one with a summary', async () => {
    const step = (status: string): Script => ({ calls: [{ name: 'set_status', input: { id: 'pick-dates', status } }] });
    const large = scripted([step('in_progress'), { text: 'ok' }, step('todo'), { text: 'ok' }]);
    const h = await harness({ large, sameModel: true });
    await h.chat.send('Start on pick dates');
    h.clock.now += DEFAULT_IDLE_MS + 60_000;
    await h.chat.send('Actually, not yet');
    const sessions = ((await h.service.projectHistory?.listSessions()) ?? []).filter((s) => s.kind === 'chat');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      closedBy: 'user',
      summary: expect.stringContaining("1 change: 'Pick dates' → in progress") as string,
    });
    expect(sessions[1]?.closedAt).toBeUndefined();
  });

  it('says what to do when no model is set up, before anything is typed', async () => {
    const h = await harness({ large: new ModelError('not-set-up', 'Add your OpenAI API key first.') });
    expect(h.chat.view().status).toBe('no-model');
  });

  it('answers the message sent before a model was set up, once one is chosen', async () => {
    const h = await harness({ large: new ModelError('not-set-up', 'Add your OpenAI API key first.'), sameModel: true });
    await h.chat.send('What is in the plan?');
    expect(h.chat.view().items.at(-1)).toMatchObject({ kind: 'notice', action: 'open-model-settings' });
    await h.chooseModel(scripted([{ text: 'It has five features.' }]));
    const items = h.chat.view().items;
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ kind: 'assistant', text: 'It has five features.' });
  });

  it('never sends a message again just because the model settings changed', async () => {
    const model = scripted([{ text: 'It has five features.' }, { text: 'again' }]);
    const h = await harness({ large: model, sameModel: true });
    await h.chat.send('What is in the plan?');
    await h.chooseModel(model);
    expect(model.requests).toHaveLength(1);
  });

  it('answers a waiting message when the chat asks again, even with no settings change', async () => {
    const h = await harness({ large: new ModelError('no-permission', 'Allow idea-to-code to use the model.'), sameModel: true });
    await h.chat.send('What is in the plan?');
    const model = scripted([{ text: 'It has five features.' }]);
    // The model works now, but nothing announced a change.
    await h.chooseModelQuietly(model);
    await h.chat.retryWaiting();
    const items = h.chat.view().items;
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ kind: 'assistant', text: 'It has five features.' });
  });

  it('replaces a message that never reached a model when the next one is sent', async () => {
    const h = await harness({ large: new ModelError('not-set-up', 'Add your OpenAI API key first.'), sameModel: true });
    await h.chat.send('What is in the plan?');
    await h.chooseModelQuietly(scripted([{ text: 'It has five features.' }]));
    await h.chat.send('What is in the plan?');
    const items = h.chat.view().items;
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(items.some((i) => 'action' in i && i.action === 'open-model-settings')).toBe(false);
  });

  it('answers a message that failed before the editor was reloaded, once a model is chosen', async () => {
    const h = await harness({ large: new ModelError('not-set-up', 'Add your OpenAI API key first.'), sameModel: true });
    await h.chat.send('What is in the plan?');
    // A reload: a new chat service opens the same saved chat.
    await h.reopen();
    await h.chooseModel(scripted([{ text: 'It has five features.' }]));
    const items = h.chat.view().items;
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ kind: 'assistant', text: 'It has five features.' });
  });

  it('only answers a waiting message from the chat it was sent in', async () => {
    const h = await harness({ large: new ModelError('not-set-up', 'Add your OpenAI API key first.'), sameModel: true });
    await h.chat.send('What is in the plan?');
    await h.chat.newThread();
    const model = scripted([{ text: 'It has five features.' }]);
    await h.chooseModel(model);
    expect(model.requests).toHaveLength(0);
  });

  it('keeps chats apart, and reopens the one used last', async () => {
    const h = await harness({ large: scripted([{ text: 'one' }, { text: 'two' }]), sameModel: true });
    await h.chat.send('First chat');
    await h.chat.newThread();
    await h.chat.send('Lend tools to friends only');
    const view = h.chat.view();
    expect(view.current?.title).toBe('Lend tools to friends only');
    expect(view.threads.map((t) => t.title)).toEqual(['Lend tools to friends only', 'Planning']);
    await h.chat.openThread(view.threads[1]?.id ?? '');
    expect(h.chat.view().items[0]).toMatchObject({ kind: 'user', text: 'First chat' });
  });
});
