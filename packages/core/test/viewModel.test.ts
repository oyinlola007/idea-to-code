import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { loadFromTexts } from '../src/load.js';
import { OVERVIEW } from '../src/progress.js';
import { buildViewModel, ViewModel, type VNode } from '../src/viewModel.js';
import { fixturePath } from './helpers.js';

let model: ViewModel;
beforeAll(async () => {
  model = buildViewModel(loadFromTexts(await readPlanTexts(fixturePath('toolshed'))));
});

function node(level: string, id: string): VNode {
  const found = model.levels[level]?.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no ${id} in ${level}`);
  return found;
}

describe('buildViewModel on Toolshed', () => {
  it('has a level for the overview and for every flow', () => {
    expect(Object.keys(model.levels)).toEqual(
      expect.arrayContaining([OVERVIEW, 'bookings', 'place-booking-flow', 'take-deposit-flow', 'handover']),
    );
    expect(model.project).toBe('Toolshed');
  });

  it('shows features and shared components on the overview, with computed progress', () => {
    expect(node(OVERVIEW, 'bookings')).toMatchObject({ kind: 'feature', opens: 'bookings' });
    expect(node(OVERVIEW, 'bookings').progress?.total).toBeGreaterThan(0);
    expect(node(OVERVIEW, 'payments-api')).toMatchObject({ kind: 'component', componentKind: 'external-api', tech: 'Stripe' });
    expect(model.levels[OVERVIEW]?.progress).toEqual({ done: 7, total: 15 });
  });

  it('marks a listed feature without flows as planned, with nothing to open', () => {
    expect(node(OVERVIEW, 'reminders').planned).toBe(true);
    expect(node(OVERVIEW, 'reminders').opens).toBeUndefined();
  });

  it('gives an expandable node computed progress and never its own status', () => {
    const placeBooking = node('bookings', 'place-booking');
    expect(placeBooking.opens).toBe('place-booking-flow');
    expect(placeBooking.progress).toBeDefined();
    expect(placeBooking.status).toBeUndefined();
  });

  it('resolves parents and crumbs at any depth', () => {
    const deep = model.levels['take-deposit-flow'];
    expect(deep?.parent).toBe('place-booking-flow');
    expect(deep?.depth).toBe(3);
    expect(deep?.crumbs.map((c) => c.id)).toEqual([OVERVIEW, 'bookings', 'place-booking-flow', 'take-deposit-flow']);
    expect(deep?.crumbs[0]?.title).toBe('Toolshed');
  });

  it('resolves references to features and shared components', () => {
    expect(node('bookings', 'join-waitlist').kind).toBe('step');
    const all = Object.values(model.levels).flatMap((level) => level.nodes);
    expect(all.find((n) => n.id === 'payments')).toMatchObject({
      kind: 'reference',
      refLabel: 'Payments API',
      componentKind: 'external-api',
    });
    expect(all.find((n) => n.id === 'notify-member')).toMatchObject({ kind: 'reference', refLabel: 'Reminders' });
  });

  it('points every node at its source line', () => {
    const source = node('bookings', 'place-booking').source;
    expect(source.file).toBe('plan/features/bookings.yaml');
    expect(source.line).toBeGreaterThan(1);
    expect(node(OVERVIEW, 'bookings').source.file).toBe('plan/map.yaml');
  });

  it('parses through its own schema, so it crosses the bridge', () => {
    expect(ViewModel.safeParse(model).success).toBe(true);
  });

  it('still shows the rest of the plan when one file is broken', () => {
    const broken = buildViewModel(
      loadFromTexts({ 'plan/map.yaml': 'project: A\nfeatures:\n  - id: b\n    label: B\n', 'plan/features/b.yaml': 'flows: [oops' }),
    );
    expect(broken.levels[OVERVIEW]?.nodes).toHaveLength(1);
    expect(broken.issues.some((i) => i.severity === 'error')).toBe(true);
  });
});
