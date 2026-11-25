import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { onInstalled } from '../background/install.ts';
import { menuClickToSend, rebuildMenus } from '../background/menus.ts';
import { BackgroundSync, isSyncMessage } from '../background/sync.ts';
import { loadDevices } from '../account/devices.ts';
import { onNotificationClicked } from '../modules/commands/receive.ts';
import { startup } from '../lib/startup.ts';

export default defineBackground(() => {
  startup();
  const sync = new BackgroundSync(browser);
  sync.watchModules();

  // MV3: register listeners synchronously at the top level of the background script, or events
  // that wake a suspended service worker are missed (apps/extension/CLAUDE.md, MV3 pitfalls).
  const start = async () => {
    await sync.ensureAlarm();
    await rebuildMenus(browser);
    await sync.sync('startup');
    // Fresh device names for the context menu and notifications; rebuilds the menu on change.
    await loadDevices(browser);
  };
  browser.runtime.onInstalled.addListener((details) => {
    void onInstalled(browser, details);
    void start();
  });
  browser.runtime.onStartup.addListener(() => {
    void start();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    void sync.onAlarm(alarm.name);
  });
  browser.storage.onChanged.addListener((changes) => {
    const keys = Object.keys(changes);
    void sync.onStorageChanged(keys);
    if (keys.includes('devices') || keys.includes('account')) void rebuildMenus(browser);
  });
  // UI-4: Send page/link to → device.
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const send = menuClickToSend(info, tab);
    if (send === undefined || 'refused' in send) return;
    void sync.sendTab(send.target, send);
  });
  browser.notifications.onClicked.addListener((id) => {
    void onNotificationClicked(browser, id);
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // Only our own pages may drive the engine.
    if (sender.id !== browser.runtime.id || !isSyncMessage(message)) return false;
    if (message.type === 'local-change') {
      sync.localChange();
      return false;
    }
    if (message.type === 'send-tab') {
      const { target, url, title } = message;
      void sync
        .sendTab(target, { url, ...(title === undefined ? {} : { title }) })
        .then(sendResponse);
      return true;
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
