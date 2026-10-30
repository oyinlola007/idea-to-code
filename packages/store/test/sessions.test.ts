import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreError } from '../src/errors.js';
import { HistoryStore, type ProjectHistory } from '../src/history.js';
import { plan, tempDir } from './helpers.js';

const MINUTE = 60_000;
let clock: number;
let project: ProjectHistory;

beforeEach(async () => {
  clock = 1_000_000_000;
  const store = new HistoryStore(await tempDir(), { now: () => clock });
  ({ project } = await store.openProject({ path: '/projects/p', texts: plan('P') }));
});

let n = 0;
const edit = (actor = 'claude-code') => project.recordSnapshot({ texts: plan(`P${++n}`), source: 'mcp', actor });

describe('activity sessions', () => {
  it('groups edits from anyone into one running session, keeping each actor', async () => {
    await edit('claude-code');
    clock += 5 * MINUTE;
    await edit('copilot');
    const sessions = await project.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: 'activity', snapshots: 2 });
    expect(sessions[0]?.closedAt).toBeUndefined();
    expect((await project.listSnapshots()).map((s) => s.actor)).toEqual(['claude-code', 'copilot']);
  });

  it('stays open while edits keep coming within the idle time', async () => {
    await edit();
    clock += 29 * MINUTE;
    await edit();
    clock += 29 * MINUTE;
    await edit();
    await expect(project.listSessions()).resolves.toHaveLength(1);
  });

  it('closes after 30 idle minutes, at the time it went idle, and the next edit starts a new one', async () => {
    await edit();
    const last = clock;
    clock += 31 * MINUTE;
    await edit();
    const sessions = await project.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ closedAt: last + 30 * MINUTE, closedBy: 'idle', snapshots: 1 });
    expect(sessions[1]).toMatchObject({ snapshots: 1 });
    expect(sessions[1]?.closedAt).toBeUndefined();
  });

  it('shows an idle session as closed even before any later edit', async () => {
    await edit();
    clock += 31 * MINUTE;
    const [session] = await project.listSessions();
    expect(session).toMatchObject({ closedBy: 'idle' });
  });

  it('honours a configured idle time', async () => {
    const store = new HistoryStore(await tempDir(), { now: () => clock, idleMs: 5 * MINUTE });
    const { project: p } = await store.openProject({ path: '/projects/q', texts: plan('Q') });
    await p.recordSnapshot({ texts: plan('Q1'), source: 'ui', actor: 'user' });
    clock += 6 * MINUTE;
    await p.recordSnapshot({ texts: plan('Q2'), source: 'ui', actor: 'user' });
    await expect(p.listSessions()).resolves.toHaveLength(2);
  });

  it('starting a new activity session closes the running one', async () => {
    await edit();
    const opened = await project.openSession({ kind: 'activity' });
    await edit();
    const sessions = await project.listSessions();
    expect(sessions[0]).toMatchObject({ closedBy: 'replaced' });
    expect(sessions[1]).toMatchObject({ id: opened.id, snapshots: 1 });
  });
});

describe('chat sessions', () => {
  it('records the editor and a summary, but no transcript', async () => {
    const chat = await project.openSession({ kind: 'chat', editor: 'Cursor', title: 'Plan reminders' });
    const r = await project.recordSnapshot({ texts: plan('Chat'), source: 'agent', actor: 'built-in', sessionId: chat.id });
    if (!r.recorded) throw new Error('expected a snapshot');
    expect(r.snapshot.session).toBe(chat.id);
    await project.closeSession(chat.id, { summary: 'Planned reminders' });
    const [session] = await project.listSessions();
    expect(session).toMatchObject({
      kind: 'chat',
      editor: 'Cursor',
      title: 'Plan reminders',
      summary: 'Planned reminders',
      closedBy: 'user',
      snapshots: 1,
    });
    expect(Object.keys(session ?? {})).not.toContain('transcript');
  });

  it('runs alongside activity, without either closing the other', async () => {
    await edit();
    const chat = await project.openSession({ kind: 'chat', editor: 'Visual Studio Code' });
    await project.recordSnapshot({ texts: plan('Chat'), source: 'agent', actor: 'built-in', sessionId: chat.id });
    await edit();
    const sessions = await project.listSessions();
    expect(sessions.map((s) => s.kind)).toEqual(['activity', 'chat']);
    expect(sessions.every((s) => s.closedAt === undefined)).toBe(true);
    expect(sessions[0]?.snapshots).toBe(2);
  });

  it('does not close a chat for being idle', async () => {
    const chat = await project.openSession({ kind: 'chat', editor: 'VSCodium' });
    clock += 600 * MINUTE;
    const [session] = await project.listSessions();
    expect(session?.closedAt).toBeUndefined();
    await expect(
      project.recordSnapshot({ texts: plan('Later'), source: 'agent', actor: 'built-in', sessionId: chat.id }),
    ).resolves.toMatchObject({ recorded: true });
  });

  it('refuses a snapshot for a closed or unknown session', async () => {
    const chat = await project.openSession({ kind: 'chat', editor: 'Cursor' });
    await project.closeSession(chat.id);
    const closed = await project
      .recordSnapshot({ texts: plan('X'), source: 'agent', actor: 'a', sessionId: chat.id })
      .catch((e: unknown) => e);
    expect((closed as StoreError).code).toBe('session-closed');
    const unknown = await project
      .recordSnapshot({ texts: plan('Y'), source: 'agent', actor: 'a', sessionId: 'nope' })
      .catch((e: unknown) => e);
    expect((unknown as StoreError).code).toBe('unknown-session');
  });

  it('closing twice changes nothing', async () => {
    const chat = await project.openSession({ kind: 'chat', editor: 'Cursor' });
    await project.closeSession(chat.id, { summary: 'First' });
    await project.closeSession(chat.id, { summary: 'Second' });
    await expect(project.listSessions()).resolves.toMatchObject([{ summary: 'First' }]);
  });
});
