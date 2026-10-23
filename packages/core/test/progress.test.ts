import { beforeAll, describe, expect, it } from 'vitest';
import { loadFromTexts, type Project } from '../src/load.js';
import { flowProgress, OVERVIEW, rollup } from '../src/progress.js';
import { indexProject, validateProject } from '../src/validate.js';
import { loadFixture } from './helpers.js';

let project: Project;
beforeAll(async () => {
  project = await loadFixture('toolshed');
});

describe('progress rollup', () => {
  it('rolls work up through child flows (Toolshed, counted by hand)', () => {
    const p = rollup(project);
    // take-deposit-flow: create-payment (done), record-deposit, release-hold
    expect(p.get('take-deposit-flow')).toEqual({ done: 1, total: 3 });
    // place-booking-flow: hold-tool (done) + take-deposit's 1/3 + confirm-booking (in progress)
    expect(p.get('place-booking-flow')).toEqual({ done: 2, total: 5 });
    // bookings: browse-tools, pick-dates (both done) + place-booking's 2/5 + join-waitlist
    expect(p.get('bookings')).toEqual({ done: 4, total: 8 });
    // handover: four components, two done; references don't count
    expect(p.get('handover')).toEqual({ done: 2, total: 4 });
  });

  it('gives features without flows 0/0 and totals the overview', () => {
    const p = rollup(project);
    for (const id of ['members', 'catalogue', 'reminders']) expect(p.get(id)).toEqual({ done: 0, total: 0 });
    // features 4/8 + 2/4, plus three top-level components of which app-db is done
    expect(p.get(OVERVIEW)).toEqual({ done: 7, total: 15 });
  });

  const MAP = 'project: P\nfeatures:\n  - id: f\n    label: F\n';

  it('ignores a stored status on a node with a child flow, and warns', () => {
    const feature = `feature: f
flows:
  main:
    label: F
    nodes:
      - { id: parent, type: step, label: Parent, status: done, expands: child }
  child:
    label: Child
    nodes:
      - { id: a, type: step, label: A }
`;
    const p = loadFromTexts({ 'plan/map.yaml': MAP, 'plan/features/f.yaml': feature });
    expect(rollup(p).get('f')).toEqual({ done: 0, total: 1 });
    expect(validateProject(p).map((i) => i.code)).toContain('status-on-parent');
  });

  it('does not loop forever on flows that expand each other', () => {
    const feature = `feature: f
flows:
  main:
    label: F
    nodes:
      - { id: a, type: step, label: A, expands: x }
  x:
    label: X
    nodes:
      - { id: b, type: step, label: B, expands: y }
  y:
    label: Y
    nodes:
      - { id: c, type: step, label: C, expands: x }
`;
    const p = loadFromTexts({ 'plan/map.yaml': MAP, 'plan/features/f.yaml': feature });
    expect(() => flowProgress(indexProject(p), 'f')).not.toThrow();
    expect(validateProject(p).filter((i) => i.code === 'cycle' || i.code === 'flow-multi-parent').length).toBeGreaterThan(0);
  });
});
