import { defineProject } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineProject({
  // Resolves `wxt/browser` to an in-memory fake browser and applies the WXT config, so tests run
  // in Node without a real browser.
  plugins: [WxtVitest({ root: import.meta.dirname })],
  test: {
    name: 'extension',
    include: ['src/**/*.test.ts'],
  },
});
