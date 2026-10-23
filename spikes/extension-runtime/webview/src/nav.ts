// Navigation through levels as a pure reducer: an in-tab history (a webview
// has no address bar), the selection, and the Esc order.
import { OVERVIEW, type LevelId, type ViewModel } from '../../src/shared/viewModel.js';

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
  for (let i = crumbs.length - 2; i >= 0; i--) {
    const id = crumbs[i]!.id;
    if (model.levels[id]) return id;
  }
  return OVERVIEW;
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
            if (history[history.length - 1] !== level) history.push(level);
            cursor = history.length - 1;
          } else if (model.levels[id] && history[history.length - 1] !== id) {
            history.push(id);
          }
        });
        const selected = s.selected && model.levels[level]?.nodes.some((n) => n.id === s.selected) ? s.selected : null;
        return { history, cursor, selected, details: s.details && selected !== null };
      }
    }
  };
}
