import { describe, expect, it } from 'vitest';
import { ChatStore, FIRST_TITLE, type Thread } from '../../src/chat/transcript.js';
import { MemoryChatFiles } from './helpers.js';

function store(files = new MemoryChatFiles()) {
  let clock = 1000;
  let id = 0;
  return {
    files,
    chats: new ChatStore(
      files,
      () => (clock += 10),
      () => `t${String(++id)}`,
    ),
  };
}

describe('saved chats', () => {
  it('start with one planning chat, and reopen the one used last', async () => {
    const { files, chats } = store();
    const first = await chats.current();
    expect(first.title).toBe(FIRST_TITLE);
    expect((await chats.current()).id).toBe(first.id);

    const second = await chats.create('Late returns');
    expect((await chats.current()).id).toBe(second.id);
    await chats.open(first.id);
    // A new session in the same editor picks up where it left off.
    expect((await new ChatStore(files).current()).id).toBe(first.id);
    expect((await chats.list()).map((t) => t.id)).toEqual([second.id, first.id]);
  });

  it('keep each turn, and mark one cut short as interrupted', async () => {
    const { chats } = store();
    const thread: Thread = await chats.current();
    thread.turns.push({ id: 'x', at: 1, user: 'Plan it', messages: [{ role: 'assistant', text: 'On it' }], outcome: 'running' });
    await chats.save(thread);
    const back = await chats.current();
    expect(back.turns[0]).toMatchObject({ user: 'Plan it', outcome: 'interrupted', messages: [{ role: 'assistant', text: 'On it' }] });
  });

  it('skip a damaged chat instead of failing', async () => {
    const { files, chats } = store();
    const thread = await chats.current();
    files.files.set(`chats/${thread.id}.json`, '{ not json');
    expect(await chats.open(thread.id)).toBeUndefined();
    expect((await chats.current()).id).not.toBe(thread.id);
  });

  it('log message kinds, one line each, on this machine', async () => {
    const { files, chats } = store();
    await chats.logKind({ at: 1, kind: 'edit', by: 'model', model: 'small' });
    await chats.logKind({ at: 2, kind: 'plan', by: 'skipped' });
    expect(
      files.files
        .get('chats/kinds.jsonl')
        ?.trim()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([
      { at: 1, kind: 'edit', by: 'model', model: 'small' },
      { at: 2, kind: 'plan', by: 'skipped' },
    ]);
  });
});
