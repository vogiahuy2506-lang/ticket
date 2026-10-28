import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration tests share one database, so they must not run in
    // parallel with each other. Each file uses its own schema, but the
    // schema setup itself is not free of races.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
