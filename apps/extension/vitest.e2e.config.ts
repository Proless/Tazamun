import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests (e2e/*.e2e.ts): real browsers, the real server, the built extension. Not part
 * of `pnpm test`; run with `pnpm --filter @tazamun/extension test:e2e` after a build.
 */
export default defineConfig({
  test: {
    name: 'extension-e2e',
    root: import.meta.dirname,
    include: ['e2e/**/*.e2e.ts'],
    // One browser pair, scenarios in order.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
