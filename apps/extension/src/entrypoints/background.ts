import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { onInstalled } from '../background/install.ts';
import { BackgroundSync, isSyncMessage } from '../background/sync.ts';
import { startup } from '../lib/startup.ts';

export default defineBackground(() => {
  startup();
  const sync = new BackgroundSync(browser);
  sync.watchModules();

  // MV3: register listeners synchronously at the top level of the background script, or events
  // that wake a suspended service worker are missed (apps/extension/CLAUDE.md, MV3 pitfalls).
  browser.runtime.onInstalled.addListener((details) => {
    void onInstalled(browser, details);
    void sync.ensureAlarm().then(() => sync.sync('startup'));
  });
  browser.runtime.onStartup.addListener(() => {
    void sync.ensureAlarm().then(() => sync.sync('startup'));
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    void sync.onAlarm(alarm.name);
  });
  browser.storage.onChanged.addListener((changes) => {
    void sync.onStorageChanged(Object.keys(changes));
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Only our own pages may drive the engine.
    if (sender.id !== browser.runtime.id || !isSyncMessage(message)) return false;
    if (message.type === 'local-change') {
      sync.localChange();
      return false;
    }
    // ENG-5: opening the popup or "Sync now" pulls immediately. The reply is the new status.
    // sendResponse plus `return true` works in Chrome and Firefox; a returned promise only in
    // Firefox (WXT uses the plain chrome API on Chromium, without a polyfill).
    void sync.sync('ui').then(sendResponse);
    return true;
  });

  // A worker woken by any event also makes sure the poll exists (it can be lost on some updates).
  void sync.ensureAlarm();
});
