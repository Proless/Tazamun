import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { onInstalled } from '../background/install.ts';
import { startup } from '../lib/startup.ts';

export default defineBackground(() => {
  startup();
  // MV3: register listeners synchronously at the top level of the background script, or events
  // that wake a suspended service worker are missed (root CLAUDE.md, MV3 pitfalls).
  browser.runtime.onInstalled.addListener((details) => {
    void onInstalled(browser, details);
  });
});
