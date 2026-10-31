// Navigation through levels as a pure reducer: an in-tab history (a webview
// has no address bar), the selection, and the Esc order.
import { OVERVIEW, type LevelId, type ViewModel } from '@idea-to-code/core';

export interface NavState {
  history: LevelId[];
  cursor: number;
  selected: string | null;
  details: boolean;
}

export type NavAction =
  | { type: 'open'; level: LevelId }
  | { type: 'up' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'select'; id: string | null }
  | { type: 'closeDetails' }
  | { type: 'escape' }
  | { type: 'reconcile' };

export const initialNav = (level: LevelId = OVERVIEW): NavState => ({ history: [level], cursor: 0, selected: null, details: false });

export const currentLevel = (s: NavState): LevelId => s.history[s.cursor] ?? OVERVIEW;
export const canBack = (s: NavState) => s.cursor > 0;
export const canForward = (s: NavState) => s.cursor < s.history.length - 1;

function push(s: NavState, level: LevelId): NavState {
  if (level === currentLevel(s)) return { ...s, selected: null, details: false };
  const history = [...s.history.slice(0, s.cursor + 1), level];
  return { history, cursor: history.length - 1, selected: null, details: false };
}

/** The nearest level that still exists, walking up the old crumbs. */
function surviving(level: LevelId, before: ViewModel | undefined, model: ViewModel): LevelId {
  if (model.levels[level]) return level;
  const crumbs = before?.levels[level]?.crumbs ?? [];
  for (const { id } of crumbs.slice(0, -1).reverse()) {
    if (model.levels[id]) return id;
  }
  return OVERVIEW;
}

/** Reads back what a tab saved, which could be anything from an older version. */
export function restoreNav(saved: unknown): NavState | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined;
  const { history, cursor, selected } = saved as { history?: unknown; cursor?: unknown; selected?: unknown };
  if (!Array.isArray(history) || history.length === 0 || !history.every((id) => typeof id === 'string')) return undefined;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0 || cursor >= history.length) return undefined;
  const id = typeof selected === 'string' ? selected : null;
  return { history: history, cursor, selected: id, details: id !== null };
}

export function navReducer(model: ViewModel, before?: ViewModel) {
  return (s: NavState, a: NavAction): NavState => {
    switch (a.type) {
      case 'open':
        return model.levels[a.level] ? push(s, a.level) : s;
      case 'up': {
        const parent = model.levels[currentLevel(s)]?.parent;
        return parent ? push(s, parent) : s;
      }
      case 'back':
        return canBack(s) ? { ...s, cursor: s.cursor - 1, selected: null, details: false } : s;
      case 'forward':
        return canForward(s) ? { ...s, cursor: s.cursor + 1, selected: null, details: false } : s;
      case 'select':
        return { ...s, selected: a.id, details: a.id !== null };
      case 'closeDetails':
        return { ...s, details: false };
      case 'escape':
        if (s.details) return { ...s, details: false };
        if (s.selected) return { ...s, selected: null };
        return navReducer(model, before)(s, { type: 'up' });
      case 'reconcile': {
        const level = surviving(currentLevel(s), before, model);
        const history: LevelId[] = [];
        let cursor = 0;
        s.history.forEach((id, i) => {
          if (i === s.cursor) {
            if (history.at(-1) !== level) history.push(level);
            cursor = history.length - 1;
          } else if (model.levels[id] && history.at(-1) !== id) {
            history.push(id);
          }
        });
        const selected = s.selected && model.levels[level]?.nodes.some((n) => n.id === s.selected) ? s.selected : null;
        return { history, cursor, selected, details: s.details && selected !== null };
      }
    }
  };
}
