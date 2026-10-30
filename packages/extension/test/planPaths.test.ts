import { describe, expect, it } from 'vitest';
import { looksLikePlan, planFileIn } from '../src/planPaths.js';

describe('planFileIn', () => {
  it('finds plan files in the folder', () => {
    expect(planFileIn('/work/app', '/work/app/plan/map.yaml')).toBe('plan/map.yaml');
    expect(planFileIn('/work/app/', '/work/app/plan/features/bookings.yaml')).toBe('plan/features/bookings.yaml');
  });

  it('leaves everything else alone', () => {
    for (const file of [
      '/work/app/plan/other.yaml',
      '/work/app/plan/features/deep/x.yaml',
      '/work/app/plan/GUIDE.md',
      '/work/app/sub/plan/map.yaml',
      '/work/other/plan/map.yaml',
      '/work/app-2/plan/map.yaml',
    ]) {
      expect(planFileIn('/work/app', file), file).toBeUndefined();
    }
  });
});

describe('looksLikePlan', () => {
  it("recognises a plan's map, even a broken one", () => {
    expect(looksLikePlan('project: Toolshed\nfeatures: []\n')).toBe(true);
    expect(looksLikePlan('# notes\nproject: [unclosed\n')).toBe(true);
  });

  it('rejects other files called map.yaml', () => {
    expect(looksLikePlan(null)).toBe(false);
    expect(looksLikePlan('')).toBe(false);
    expect(looksLikePlan('routes:\n  - project: x\n')).toBe(false);
  });
});
