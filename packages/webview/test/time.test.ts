import { describe, expect, it } from 'vitest';
import { whenText } from '../src/ui/time.js';

const now = new Date(2026, 9, 31, 15, 0).getTime();

describe('whenText', () => {
  it('is just the time today', () => {
    expect(whenText(new Date(2026, 9, 31, 9, 5).getTime(), now, 'en-GB')).toBe('09:05');
  });

  it('adds the date on an earlier day', () => {
    expect(whenText(new Date(2026, 9, 30, 9, 5).getTime(), now, 'en-GB')).toBe('30 Oct, 09:05');
  });

  it('adds the year when it differs', () => {
    expect(whenText(new Date(2025, 9, 30, 9, 5).getTime(), now, 'en-GB')).toContain('2025');
  });
});
