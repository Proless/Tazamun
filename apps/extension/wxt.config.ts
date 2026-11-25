import { defineConfig } from 'wxt';
import { manifestFor, type TargetBrowser } from './src/manifest.ts';

const TARGETS: readonly string[] = ['chrome', 'edge', 'firefox'] satisfies TargetBrowser[];

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue'],
  manifestVersion: 3,
  // Explicit imports (wxt/browser, wxt/utils/...) instead of auto-imported globals, so every file
  // says where its names come from and type-aware ESLint sees them.
  imports: false,
  manifest: ({ browser }) => {
    if (!TARGETS.includes(browser)) {
      throw new Error(`Unsupported browser "${browser}"; build for chrome, edge or firefox.`);
    }
    return manifestFor(browser as TargetBrowser);
  },
});
