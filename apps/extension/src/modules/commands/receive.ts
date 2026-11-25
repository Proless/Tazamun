/**
 * A tab arrives (TAB-7): open it in the background (not stealing focus), and say so with a
 * notification; clicking the notification shows the tab. If the browser refuses the URL (TAB-8),
 * the notification says that instead. The background script has no clipboard, so the URL is shown
 * in the notification for the user to copy.
 */
import type { WxtBrowser } from 'wxt/browser';
import type { schema } from '@tazamun/core';
import { z } from 'zod';
import { t } from '../../lib/i18n.ts';
import { ICONS } from '../../manifest.ts';
import type { Receiver, SentTab } from './module.ts';

const NOTIFICATION_PREFIX = 'tz-tab:';

const cachedDevices = z.object({
  devices: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** The sender's device name from the cached device list, if known. */
async function senderName(browser: WxtBrowser, sender: string): Promise<string> {
  const parsed = cachedDevices.safeParse((await browser.storage.local.get('devices'))['devices']);
  const name = parsed.success ? parsed.data.devices.find((d) => d.id === sender)?.name : undefined;
  return name ?? t('tabsUnknownDevice');
}

export class TabReceiver implements Receiver {
  readonly #browser: WxtBrowser;

  constructor(browser: WxtBrowser) {
    this.#browser = browser;
  }

  async open(tab: SentTab, sender: string): Promise<boolean> {
    const from = await senderName(this.#browser, sender);
    const label = tab.title !== undefined && tab.title !== '' ? tab.title : tab.url;
    try {
      const created = await this.#browser.tabs.create({ url: tab.url, active: false });
      await this.#notify(`${NOTIFICATION_PREFIX}${String(created.id ?? '')}`, {
        title: t('sentTabTitle', [from]),
        message: label,
      });
      return true;
    } catch {
      await this.#notify(`${NOTIFICATION_PREFIX}refused:${String(Date.now())}`, {
        title: t('sentTabRefusedTitle', [from]),
        message: t('sentTabRefused', [tab.url]),
      });
      return false;
    }
  }

  async #notify(id: string, content: { title: string; message: string }): Promise<void> {
    try {
      await this.#browser.notifications.create(id, {
        type: 'basic',
        iconUrl: this.#browser.runtime.getURL(`/${ICONS['128']}`),
        ...content,
      });
    } catch {
      // Notifications turned off for the browser or the extension: the tab is open anyway.
    }
  }
}

/** Notification clicked: bring the received tab to the front. Register at the top level. */
export async function onNotificationClicked(browser: WxtBrowser, id: string): Promise<void> {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return;
  const tabId = Number(id.slice(NOTIFICATION_PREFIX.length));
  await browser.notifications.clear(id);
  if (!Number.isSafeInteger(tabId)) return;
  try {
    const tab = await browser.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
  } catch {
    // The tab was closed meanwhile.
  }
}

/** Devices a tab can be sent to: everyone on the account except this one. */
export function sendTargets(devices: readonly schema.Device[], selfId: string): schema.Device[] {
  return devices.filter((d) => d.id !== selfId);
}
