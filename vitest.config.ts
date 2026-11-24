import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    // Remove once packages/core has its first tests (HLC).
    passWithNoTests: true,
  },
});
