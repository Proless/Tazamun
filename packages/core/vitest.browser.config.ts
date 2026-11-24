import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';

// The same tests as vitest.config.ts, run in real browsers (P0 exit criterion: crypto works in
// Node and in browsers). Firefox is included on purpose: Firefox regressions slip through otherwise.
export default defineProject({
  test: {
    name: 'core-browser',
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }],
    },
  },
});
