import { beforeAll, describe, expect, it } from 'vitest';
import { loadFromTexts, type Project } from '../src/load.js';
import { breadcrumb, getFlow, getOutline, listFeatures, mapView } from '../src/mapView.js';
import { indexProject } from '../src/validate.js';
import { loadFixture } from './helpers.js';

let project: Project;
beforeAll(async () => {
  project = await loadFixture('toolshed');
});

describe('the outline', () => {
  it('lists every feature with its progress, its child flows, components and connections', () => {
    const outline = getOutline(project);
    expect(outline).toContain('Project: Toolshed');
    expect(outline).toContain('- bookings: Bookings (4/8 done) — Pick a tool and dates, pay a deposit, get a confirmed booking.');
    expect(outline).toContain('  - flow place-booking-flow: Place booking (under node place-booking; 2/5 done)');
    expect(outline).toContain('    - flow take-deposit-flow: Take deposit (under node take-deposit; 1/3 done)');
    expect(outline).toContain('- reminders: Reminders (no flows yet)');
    expect(outline).toContain('- app-db: App database (database, PostgreSQL, status=done, code=db/schema.sql)');
    expect(outline).toMatch(/Connections between features:\n- /);
  });

  it("says when a feature file can't be read, instead of calling it empty", () => {
    const broken = loadFromTexts({
      'plan/map.yaml': 'project: P\nfeatures:\n  - id: a\n    label: A\n',
      'plan/features/a.yaml': 'feature: a\nflows: [unclosed\n',
    });
    expect(getOutline(broken)).toContain("- a: A (can't be read: fix plan/features/a.yaml)");
    expect(listFeatures(broken)).toContain("can't be read");
  });

  it('says when there is no map, and when there are no features', () => {
    expect(getOutline(loadFromTexts({}))).toContain('map.yaml is missing or broken');
    expect(getOutline(loadFromTexts({ 'plan/map.yaml': 'project: P\n' }))).toContain('(no features yet)');
  });
});

describe('a flow', () => {
  it('shows every node with its type, status, child flow and description, and every edge', () => {
    const flow = getFlow(project, 'bookings');
    expect(flow).toContain('Flow bookings: Bookings (4/8 done)');
    expect(flow).toContain('Path: Overview › Bookings');
    expect(flow).toMatch(/- pick-dates: "Pick dates" \(step, status=done, code=src\/bookings\/\)/);
    expect(flow).toMatch(/- place-booking: "Place booking" \(step, expands=place-booking-flow \(2\/5 done\)\)/);
    expect(flow).toMatch(/- tool-available -> place-booking \(yes\)/);
  });

  it('names the known flows when the id is wrong', () => {
    expect(getFlow(project, 'nope')).toMatch(/^No flow "nope".*Known flows: .*take-deposit-flow/);
  });
});

describe('the map view', () => {
  it('adds the flow being viewed and where the user is', () => {
    const view = mapView(project, 'take-deposit-flow');
    expect(view).toContain('## The plan');
    expect(view).toContain('## The flow the user is looking at\nFlow take-deposit-flow: Take deposit');
    expect(view).toContain('Overview › Bookings › Place booking › Take deposit (level id: take-deposit-flow)');
  });

  it('shows only the outline on the overview, or for a level that no longer exists', () => {
    for (const level of ['overview', 'gone']) {
      const view = mapView(project, level);
      expect(view).not.toContain('## The flow the user is looking at');
      expect(view).toContain('Overview (level id: overview)');
    }
  });

  it('is the same text for the same plan, so a request stays cacheable', () => {
    expect(mapView(project, 'bookings')).toBe(mapView(project, 'bookings'));
  });
});

describe('breadcrumb', () => {
  it('goes from the overview down to the level', () => {
    expect(breadcrumb(indexProject(project), 'take-deposit-flow')).toEqual(['Overview', 'Bookings', 'Place booking', 'Take deposit']);
    expect(breadcrumb(indexProject(project), 'overview')).toEqual(['Overview']);
  });
});
