// What a shared web page shows: the whole plan to read, nothing to edit, no problem markers.
import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { AppState } from '../src/bridge.js';
import { sharedState } from '../src/share.js';
import { fixturePath } from './helpers.js';

let toolshed: Record<string, string>;
beforeAll(async () => {
  toolshed = await readPlanTexts(fixturePath('toolshed'));
});

describe('a shared page of the plan', () => {
  it('is read-only, with no history and nothing to fix', () => {
    const state = sharedState(toolshed, 'toolshed');
    expect(AppState.parse(state)).toEqual(state);
    if (state.kind !== 'plan') throw new Error('no plan');
    expect(state).toMatchObject({ readOnly: true, trusted: false, history: null, folder: 'toolshed' });
    expect(state.plan.problems).toEqual([]);
    expect(state.model.issues).toEqual([]);
    expect(
      Object.values(state.model.levels)
        .flatMap((l) => l.nodes)
        .some((n) => n.problems !== undefined),
    ).toBe(false);
  });

  it('keeps every level, with progress and code links as plain paths', () => {
    const state = sharedState(toolshed, 'toolshed');
    if (state.kind !== 'plan') throw new Error('no plan');
    expect(Object.keys(state.model.levels)).toEqual(
      expect.arrayContaining(['overview', 'bookings', 'place-booking-flow', 'take-deposit-flow']),
    );
    expect(state.model.levels.bookings?.progress.total).toBeGreaterThan(0);
    const deposit = state.model.levels['take-deposit-flow']?.nodes.find((n) => n.id === 'record-deposit');
    expect(deposit?.code).toEqual([{ path: 'src/payments/deposit.ts' }]);
  });
});
