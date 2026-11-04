import { describe, expect, it } from 'vitest';
import type { Session, Snapshot } from '../src/events.js';
import { agentName, buildHistoryView, MAX_LISTED_CHANGES, undoStep } from '../src/historyView.js';

const session = (id: string, kind: Session['kind'] = 'activity', title?: string): Session => ({
  id,
  kind,
  openedAt: 1,
  snapshots: 0,
  lastActivityAt: 1,
  ...(title === undefined ? {} : { title }),
});

/** A chain of snapshots whose parents and files follow from the list; `state` says what each one holds. */
function chain(items: (Partial<Snapshot> & { id: string; state?: string })[]): Snapshot[] {
  return items.map(({ state, ...item }, i) => ({
    type: 'snapshot',
    parent: items[i - 1]?.id ?? null,
    session: 's1',
    at: i + 1,
    source: 'ui',
    actor: 'user',
    files: { 'plan/map.yaml': state ?? item.id },
    ...item,
  }));
}

describe('agent names', () => {
  it('names the agents people know, whatever the client calls itself', () => {
    expect(agentName('claude-code')).toBe('Claude Code');
    expect(agentName('cursor-vscode')).toBe('Cursor');
    expect(agentName('Visual Studio Code')).toBe('VS Code');
    expect(agentName('codex-mcp-client')).toBe('Codex');
    expect(agentName('claude-ai')).toBe('Claude Desktop');
  });

  it('shows any other name as sent, and no name as an agent', () => {
    expect(agentName('my-own-agent')).toBe('my-own-agent');
    expect(agentName('unknown')).toBe('An agent');
    expect(agentName('  ')).toBe('An agent');
  });
});

describe('who made a change', () => {
  it('says it in words, for every source', () => {
    const view = buildHistoryView(
      [session('s1')],
      chain([
        { id: 'a', source: 'external', actor: 'unknown' },
        { id: 'b', source: 'external', actor: 'unknown' },
        { id: 'c', source: 'ui', actor: 'user' },
        { id: 'd', source: 'agent', actor: 'claude-opus' },
        { id: 'e', source: 'mcp', actor: 'claude-code' },
        { id: 'f', source: 'restore', actor: 'user', restoredFrom: 'a' },
        { id: 'g', source: 'repair', actor: 'repair' },
      ]),
    );
    expect(view.sessions[0]?.entries.map((e) => e.who).reverse()).toEqual([
      'Already in the folder',
      'Outside edit',
      'You',
      'Built-in agent',
      'Claude Code',
      'You',
      'Repair',
    ]);
  });
});

describe('the history list', () => {
  it('groups by session, with the newest change first', () => {
    const view = buildHistoryView(
      [session('s1'), session('s2', 'chat', 'Planning bookings')],
      chain([{ id: 'a' }, { id: 'b', session: 's2', source: 'agent' }, { id: 'c', session: 's2', source: 'agent' }]),
    );
    expect(view.sessions.map((s) => [s.id, s.title, s.entries.map((e) => e.id)])).toEqual([
      ['s2', 'Planning bookings', ['c', 'b']],
      ['s1', 'You', ['a']],
    ]);
  });

  it('names who worked in a session, leaving out the version found on first opening', () => {
    const found = { id: 'a', source: 'external', actor: 'unknown' } as const;
    expect(buildHistoryView([session('s1')], chain([found])).sessions[0]?.title).toBe('Already in the folder');
    expect(
      buildHistoryView([session('s1')], chain([found, { id: 'b' }, { id: 'c', source: 'external', actor: 'unknown' }])).sessions[0]?.title,
    ).toBe('Outside edit, You');
  });

  it('leaves out sessions with no changes, and keeps a change whose session line was damaged', () => {
    const view = buildHistoryView([session('empty')], chain([{ id: 'a', session: 'lost' }]));
    expect(view.sessions.map((s) => s.id)).toEqual(['lost']);
    expect(view.sessions[0]?.kind).toBe('activity');
  });

  it('marks every version that already matches the plan, and dates a restore by what it brought back', () => {
    const view = buildHistoryView(
      [session('s1')],
      chain([
        { id: 'a', state: 'one' },
        { id: 'b', state: 'two' },
        { id: 'c', state: 'one', source: 'restore', restoredFrom: 'a' },
      ]),
    );
    const entries = view.sessions[0]?.entries ?? [];
    expect(entries.map((e) => [e.id, e.current])).toEqual([
      ['c', true],
      ['b', false],
      ['a', true],
    ]);
    expect(entries[0]?.restoredFromAt).toBe(1);
  });

  it('explains a change the comparison finds nothing in, and one with no summary', () => {
    const view = buildHistoryView([session('s1')], chain([{ id: 'a' }, { id: 'b', summary: 'No changes' }]));
    expect(view.sessions[0]?.entries.map((e) => e.summary)).toEqual(['Only comments or formatting changed', 'Changed the plan']);
  });

  it('caps the list and says how much it left out', () => {
    const many = chain(Array.from({ length: MAX_LISTED_CHANGES + 5 }, (_, i) => ({ id: `v${String(i)}` })));
    const view = buildHistoryView([session('s1')], many);
    expect(view.sessions[0]?.entries).toHaveLength(MAX_LISTED_CHANGES);
    expect(view.older).toBe(5);
  });
});

describe('undo', () => {
  it('has nothing to undo at the first version, or with no history', () => {
    expect(undoStep([])).toBeNull();
    expect(undoStep(chain([{ id: 'a' }]))).toBeNull();
    expect(buildHistoryView([], []).undo).toBeNull();
  });

  it('reverses the latest change', () => {
    const step = undoStep(chain([{ id: 'a' }, { id: 'b' }]));
    expect([step?.undoing.id, step?.target.id]).toEqual(['b', 'a']);
  });

  it('goes further back on each Undo, instead of flipping between two versions', () => {
    const afterOne = chain([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'u1', source: 'restore', restoredFrom: 'b', undo: true, state: 'b' },
    ]);
    expect(undoStep(afterOne)?.target.id).toBe('a');
    const afterTwo = chain([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'u1', source: 'restore', restoredFrom: 'b', undo: true, state: 'b' },
      { id: 'u2', source: 'restore', restoredFrom: 'a', undo: true, state: 'a' },
    ]);
    expect(undoStep(afterTwo)).toBeNull();
  });

  it('reverses a restore the user asked for, going back to before it', () => {
    const snapshots = chain([{ id: 'a' }, { id: 'b' }, { id: 'r', source: 'restore', restoredFrom: 'a', state: 'a' }]);
    const step = undoStep(snapshots);
    expect([step?.undoing.id, step?.target.id]).toEqual(['r', 'b']);
    expect(buildHistoryView([session('s1')], snapshots).undo).toEqual({ latest: 'r', who: 'You', summary: 'the restore' });
  });

  it('reverses a new edit made after an Undo', () => {
    const step = undoStep(
      chain([{ id: 'a' }, { id: 'b' }, { id: 'u', source: 'restore', restoredFrom: 'a', undo: true, state: 'a' }, { id: 'c' }]),
    );
    expect([step?.undoing.id, step?.target.id]).toEqual(['c', 'u']);
  });

  it('tells the UI what it would reverse', () => {
    const view = buildHistoryView(
      [session('s1')],
      chain([{ id: 'a' }, { id: 'b', source: 'mcp', actor: 'claude-code', summary: "Removed feature 'Fees'" }]),
    );
    expect(view.undo).toEqual({ latest: 'b', who: 'Claude Code', summary: "Removed feature 'Fees'" });
  });

  it('stops safely when a damaged log has lost the version it needs', () => {
    expect(undoStep(chain([{ id: 'u', source: 'restore', restoredFrom: 'gone', undo: true }]))).toBeNull();
    expect(undoStep([{ ...chain([{ id: 'b' }])[0], id: 'b', parent: 'gone' } as Snapshot])).toBeNull();
  });
});
