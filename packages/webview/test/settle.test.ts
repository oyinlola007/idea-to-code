import { describe, expect, it, vi } from 'vitest';
import { settle } from '../src/chart/settle.js';

describe('settle', () => {
  it('finishes when the animation does', async () => {
    await expect(settle(Promise.resolve(true), 10_000)).resolves.toBeUndefined();
  });

  it('finishes when the animation fails', async () => {
    await expect(settle(Promise.reject(new Error('no')), 10_000)).resolves.toBeUndefined();
  });

  it('finishes on time when an interrupted animation never resolves', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = settle(new Promise(() => undefined), 250).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
