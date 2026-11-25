/**
 * Context menu (UI-4): *Send page to → device* and *Send link to → device*. Rebuilt from the
 * cached device list whenever it or the account changes; empty when signed out.
 *
 * Menu item IDs carry the target device ID only, never a URL (the URL comes with the click).
 */
import type { WxtBrowser } from 'wxt/browser';
import { getAccountState } from '../account/store.ts';
import { t } from '../lib/i18n.ts';
import { sendRefusal } from '../modules/commands/send.ts';
import { z } from 'zod';
import { schema } from '@tazamun/core';

const PAGE = 'tz-send-page';
const LINK = 'tz-send-link';

const cached = z.object({ accountId: z.string(), devices: z.array(schema.device) });

export interface MenuTarget {
  readonly id: string;
  readonly name: string;
}

/** Targets for the menu: the cached device list minus this device, by name. */
export async function menuTargets(browser: WxtBrowser): Promise<MenuTarget[] | undefined> {
  const state = await getAccountState(browser);
  if (state.status !== 'signed-in' && state.status !== 'locked') return undefined;
  const parsed = cached.safeParse((await browser.storage.local.get('devices'))['devices']);
  if (!parsed.success || parsed.data.accountId !== state.account.accountId) return [];
  return parsed.data.devices
    .filter((d) => d.id !== state.account.deviceId)
    .map((d) => ({ id: d.id, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function rebuildMenus(browser: WxtBrowser): Promise<void> {
  const targets = await menuTargets(browser);
  await browser.contextMenus.removeAll();
  if (targets === undefined) return;
  const create = (props: Parameters<WxtBrowser['contextMenus']['create']>[0]) =>
    new Promise<void>((resolve) => {
      // create() reports errors through a callback, not a promise.
      browser.contextMenus.create(props, () => {
        // Reading lastError marks it handled (a duplicate ID after a racing rebuild is harmless).
        if (browser.runtime.lastError !== undefined) resolve();
        else resolve();
      });
    });
  for (const [root, context, title] of [
    [PAGE, 'page', t('menuSendPage')],
    [LINK, 'link', t('menuSendLink')],
  ] as const) {
    await create({ id: root, title, contexts: [context] });
    if (targets.length === 0) {
      await create({
        id: `${root}:none`,
        parentId: root,
        title: t('menuNoDevices'),
        enabled: false,
        contexts: [context],
      });
    }
    for (const target of targets) {
      await create({
        id: `${root}:${target.id}`,
        parentId: root,
        title: target.name,
        contexts: [context],
      });
    }
  }
}

export interface MenuSend {
  readonly target: string;
  readonly url: string;
  readonly title?: string;
}

/** Turn a menu click into a send, or a reason not to. */
export function menuClickToSend(
  info: { menuItemId: string | number; linkUrl?: string; pageUrl?: string },
  tab: { url?: string | undefined; title?: string | undefined; incognito?: boolean } | undefined,
): MenuSend | { refused: 'private' | 'not-a-web-page' } | undefined {
  const id = String(info.menuItemId);
  const [root, target] = id.split(':');
  if ((root !== PAGE && root !== LINK) || target === undefined || target === 'none')
    return undefined;
  const isLink = root === LINK;
  const url = isLink ? info.linkUrl : (tab?.url ?? info.pageUrl);
  const refusal = sendRefusal({
    ...(url === undefined ? {} : { url }),
    incognito: tab?.incognito === true,
  });
  if (refusal !== undefined || url === undefined) return { refused: refusal ?? 'not-a-web-page' };
  const title = isLink ? undefined : tab?.title;
  return { target, url, ...(title === undefined || title === '' ? {} : { title }) };
}
