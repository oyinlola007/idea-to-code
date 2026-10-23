import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'store',
    include: ['test/**/*.test.ts'],
  },
});
