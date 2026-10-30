import { describe, expect, it } from 'vitest';
import { planFingerprint, similarity } from '../src/fingerprint.js';
import { plan, toolshed } from './helpers.js';

describe('fingerprint', () => {
  it('collects the stable ids, without the reserved ones', async () => {
    const ids = planFingerprint(await toolshed());
    expect(ids).toContain('bookings');
    expect(ids).toContain('take-deposit');
    expect(ids).toContain('payments-api');
    expect(ids).not.toContain('main');
    expect(ids).not.toContain('overview');
  });

  it('is empty for an empty plan', () => {
    expect(planFingerprint({})).toEqual([]);
  });

  it('ignores labels, so renames do not change it', () => {
    const a = planFingerprint(plan('One'));
    const b = planFingerprint({ 'plan/map.yaml': (plan('Two')['plan/map.yaml'] ?? '').replace('label: alpha', 'label: Renamed') });
    expect(b).toEqual(a);
  });

  it('measures overlap from 0 to 1, and never matches on nothing', () => {
    expect(similarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(similarity(['a', 'b'], ['c'])).toBe(0);
    expect(similarity(['a', 'b', 'c'], ['a', 'b', 'd'])).toBeCloseTo(0.5);
    expect(similarity([], [])).toBe(0);
  });
});
