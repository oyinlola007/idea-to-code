// What a shared web page of the plan shows: the chart to read, nothing to edit, and
// no problem markers, which are for whoever maintains the plan, not its readers.
import type { AppState } from './bridge.js';
import { summarizePlan } from './bridge.js';
import { loadFromTexts } from './load.js';
import { buildViewModel } from './viewModel.js';

export function sharedState(texts: Readonly<Record<string, string>>, folder: string): AppState {
  const model = buildViewModel(loadFromTexts(texts));
  const levels = Object.fromEntries(
    Object.entries(model.levels).map(([id, level]) => [
      id,
      {
        ...level,
        nodes: level.nodes.map((node) => {
          const shared = { ...node };
          delete shared.problems;
          // Links are only paths to the reader: nothing is checked against files that aren't there.
          if (shared.code) shared.code = shared.code.map(({ path }) => ({ path }));
          return shared;
        }),
      },
    ]),
  );
  return {
    kind: 'plan',
    trusted: false,
    readOnly: true,
    folder,
    plan: { ...summarizePlan(texts), problems: [] },
    model: { ...model, levels, issues: [] },
    history: null,
  };
}
