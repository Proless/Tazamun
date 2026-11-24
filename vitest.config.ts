import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'packages/*/vitest.browser.config.ts',
      'apps/*/vitest.config.ts',
      'apps/*/vitest.browser.config.ts',
    ],
  },
});
