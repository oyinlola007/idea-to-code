import { describe, expect, it } from 'vitest';
import type { Level, ViewModel } from '@idea-to-code/core';
import { canBack, canForward, currentLevel, initialNav, navReducer, restoreNav, type NavAction, type NavState } from '../src/nav.js';

function level(id: string, parent: string | null, crumbs: string[]): Level {
  return {
    id,
    title: id,
    parent,
    crumbs: crumbs.map((c) => ({ id: c, title: c })),
    depth: crumbs.length - 1,
    nodes: [{ id: `${id}-node`, kind: 'step', label: 'n', source: { file: 'plan/map.yaml', line: 1 } }],
    edges: [],
    progress: { done: 0, total: 0 },
    source: { file: 'plan/map.yaml', line: 1 },
  };
}

const model: ViewModel = {
  project: 'P',
  issues: [],
  levels: {
    overview: level('overview', null, ['overview']),
    a: level('a', 'overview', ['overview', 'a']),
    'a-child': level('a-child', 'a', ['overview', 'a', 'a-child']),
    b: level('b', 'overview', ['overview', 'b']),
  },
};

const run = (actions: NavAction[], m = model, start: NavState = initialNav()) => actions.reduce(navReducer(m), start);

describe('navigation', () => {
  it('opens, goes up, back and forward', () => {
    let s = run([
      { type: 'open', level: 'a' },
      { type: 'open', level: 'a-child' },
    ]);
    expect(currentLevel(s)).toBe('a-child');
    s = navReducer(model)(s, { type: 'up' });
    expect(currentLevel(s)).toBe('a');
    expect(s.history).toEqual(['overview', 'a', 'a-child', 'a']);
    s = run([{ type: 'back' }, { type: 'back' }], model, s);
    expect(currentLevel(s)).toBe('a');
    expect(canForward(s)).toBe(true);
    s = navReducer(model)(s, { type: 'forward' });
    expect(currentLevel(s)).toBe('a-child');
  });

  it('truncates forward history when opening from the middle', () => {
    const s = run([
      { type: 'open', level: 'a' },
      { type: 'open', level: 'a-child' },
      { type: 'back' },
      { type: 'back' },
      { type: 'open', level: 'b' },
    ]);
    expect(s.history).toEqual(['overview', 'b']);
    expect(canForward(s)).toBe(false);
    expect(canBack(s)).toBe(true);
  });

  it('ignores levels that do not exist and up at the overview', () => {
    expect(run([{ type: 'open', level: 'nope' }])).toEqual(initialNav());
    expect(run([{ type: 'up' }])).toEqual(initialNav());
  });

  it('escape closes details, then clears the selection, then goes up', () => {
    let s = run([
      { type: 'open', level: 'a' },
      { type: 'select', id: 'a-node' },
    ]);
    expect(s.details).toBe(true);
    s = navReducer(model)(s, { type: 'escape' });
    expect(s).toMatchObject({ details: false, selected: 'a-node' });
    s = navReducer(model)(s, { type: 'escape' });
    expect(s).toMatchObject({ details: false, selected: null });
    expect(currentLevel(s)).toBe('a');
    s = navReducer(model)(s, { type: 'escape' });
    expect(currentLevel(s)).toBe('overview');
    expect(navReducer(model)(s, { type: 'escape' })).toEqual(s);
  });

  it('clears the selection when the level changes', () => {
    const s = run([
      { type: 'select', id: 'overview-node' },
      { type: 'open', level: 'a' },
    ]);
    expect(s.selected).toBeNull();
  });

  it('reconciles after a reload removed the current level', () => {
    const s = run([
      { type: 'open', level: 'a' },
      { type: 'open', level: 'a-child' },
    ]);
    const after: ViewModel = { ...model, levels: Object.fromEntries(Object.entries(model.levels).filter(([id]) => id !== 'a-child')) };
    const r = navReducer(after, model)(s, { type: 'reconcile' });
    expect(currentLevel(r)).toBe('a');
    expect(r.history).toEqual(['overview', 'a']);
  });

  it('falls back to the overview when the whole branch is gone', () => {
    const s = run([
      { type: 'open', level: 'a' },
      { type: 'open', level: 'a-child' },
      { type: 'select', id: 'a-child-node' },
    ]);
    const after: ViewModel = { ...model, levels: Object.fromEntries(Object.entries(model.levels).filter(([id]) => !id.startsWith('a'))) };
    const r = navReducer(after, model)(s, { type: 'reconcile' });
    expect(currentLevel(r)).toBe('overview');
    expect(r.history).toEqual(['overview']);
    expect(r.selected).toBeNull();
  });

  it('keeps the selection through a reload when the node still exists', () => {
    const s = run([
      { type: 'open', level: 'a' },
      { type: 'select', id: 'a-node' },
    ]);
    expect(navReducer(model, model)(s, { type: 'reconcile' })).toEqual(s);
  });
});

describe('restoreNav', () => {
  it('restores what a tab saved, with the details open for a selection', () => {
    expect(restoreNav({ history: ['overview', 'a'], cursor: 1, selected: 'a-node' })).toEqual({
      history: ['overview', 'a'],
      cursor: 1,
      selected: 'a-node',
      details: true,
    });
    expect(restoreNav({ history: ['overview'], cursor: 0 })).toEqual(initialNav());
  });

  it('ignores anything else', () => {
    for (const saved of [
      undefined,
      null,
      'x',
      {},
      { history: [], cursor: 0 },
      { history: ['a'], cursor: 1 },
      { history: [1], cursor: 0 },
      { level: 'a' },
    ]) {
      expect(restoreNav(saved), JSON.stringify(saved)).toBeUndefined();
    }
  });
});
