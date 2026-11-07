import { beforeAll, describe, expect, it } from 'vitest';
import { readPlanTexts } from '../scripts/readPlan.js';
import { loadFromTexts } from '../src/load.js';
import { OVERVIEW } from '../src/progress.js';
import { missingCodeLinkIssues } from '../src/codeLinks.js';
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

describe('code links on the chart', () => {
  it('lists each card’s code, marking what the host found missing, with its warning on the card', async () => {
    const project = loadFromTexts(await readPlanTexts(fixturePath('toolshed')));
    const missing = new Set(['src/payments/deposit.ts']);
    const view = buildViewModel(project, { missingCode: missing, extraIssues: missingCodeLinkIssues(project, missing) });
    const at = (level: string, id: string) => view.levels[level]?.nodes.find((n) => n.id === id);
    expect(at('bookings', 'pick-dates')?.code).toEqual([{ path: 'src/bookings/' }]);
    expect(at(OVERVIEW, 'app-db')?.code).toEqual([{ path: 'db/schema.sql' }]);
    expect(at('take-deposit-flow', 'record-deposit')?.code).toEqual([{ path: 'src/payments/deposit.ts', missing: true }]);
    expect(at('take-deposit-flow', 'record-deposit')?.problems?.[0]?.message).toContain("doesn't exist");
    expect(at('bookings', 'tool-available')?.code).toBeUndefined();
  });
});

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

  it('has no problem marks on a healthy plan, and leaves planned features unmarked', () => {
    const all = Object.values(model.levels).flatMap((level) => level.nodes);
    expect(all.filter((n) => n.problems)).toEqual([]);
    expect(model.issues).toEqual([]);
  });
});

describe('problem marks', () => {
  const map =
    'project: A\nfeatures:\n  - id: b\n    label: B\n  - id: c\n    label: C\ncomponents:\n  - id: db\n    label: DB\n    kind: database\n';
  const flow = (nodes: string) => `feature: b\nflows:\n  main:\n    label: B\n    nodes:\n${nodes}    edges: []\n`;
  const step = (id: string, extra = '') => `      - id: ${id}\n        type: step\n        label: ${id}\n${extra}`;
  const nodeIn = (m: ViewModel, level: string, id: string) => m.levels[level]?.nodes.find((n) => n.id === id);

  it('marks the node an issue belongs to, not its neighbours', () => {
    const reference = '      - id: lost\n        type: reference\n        label: Lost\n        ref: nowhere\n';
    const m = buildViewModel(
      loadFromTexts({ 'plan/map.yaml': map, 'plan/features/b.yaml': flow(step('first') + reference + step('last')) }),
    );
    expect(nodeIn(m, 'b', 'lost')?.problems?.[0]?.severity).toBe('error');
    expect(nodeIn(m, 'b', 'first')?.problems).toBeUndefined();
    expect(nodeIn(m, 'b', 'last')?.problems).toBeUndefined();
  });

  it('marks the feature on the overview when its file has an error', () => {
    const reference = '      - id: lost\n        type: reference\n        label: Lost\n        ref: nowhere\n';
    const m = buildViewModel(loadFromTexts({ 'plan/map.yaml': map, 'plan/features/b.yaml': flow(reference) }));
    const feature = nodeIn(m, OVERVIEW, 'b');
    expect(feature?.problems?.[0]?.severity).toBe('error');
    expect(feature?.broken).toBeUndefined();
    expect(feature?.opens).toBe('b');
    expect(nodeIn(m, OVERVIEW, 'c')?.problems).toBeUndefined();
  });

  it('says a feature is broken, not unplanned, when its file is unreadable, and points at the problem', () => {
    const m = buildViewModel(loadFromTexts({ 'plan/map.yaml': map, 'plan/features/b.yaml': 'feature: b\nflows: [oops' }));
    const feature = nodeIn(m, OVERVIEW, 'b');
    expect(feature).toMatchObject({ broken: true });
    expect(feature?.planned).toBeUndefined();
    expect(feature?.opens).toBeUndefined();
    expect(feature?.source.file).toBe('plan/features/b.yaml');
    expect(feature?.problems?.[0]?.severity).toBe('error');
    expect(nodeIn(m, OVERVIEW, 'c')).toMatchObject({ planned: true });
    expect(nodeIn(m, OVERVIEW, 'db')?.problems).toBeUndefined();
  });

  it('keeps planned features out of the problem list', () => {
    const m = buildViewModel(loadFromTexts({ 'plan/map.yaml': map }));
    expect(m.issues).toEqual([]);
    expect(ViewModel.safeParse(m).success).toBe(true);
  });

  it('still crosses the bridge with marks on it', () => {
    const m = buildViewModel(loadFromTexts({ 'plan/map.yaml': map, 'plan/features/b.yaml': 'flows: [oops' }));
    expect(ViewModel.safeParse(m).success).toBe(true);
  });

  it('survives a map that cannot be read', () => {
    const m = buildViewModel(loadFromTexts({ 'plan/map.yaml': 'project: [oops' }));
    expect(m.levels[OVERVIEW]?.nodes).toEqual([]);
    expect(m.issues.some((i) => i.severity === 'error')).toBe(true);
  });
});
