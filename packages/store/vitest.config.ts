import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'store',
    include: ['test/**/*.test.ts'],
    // Some tests run several real processes writing with fsync.
    testTimeout: 60_000,
  },
});
