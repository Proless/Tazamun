/**
 * The account's device list (ACC-7) for names and last-seen times in the popup. Fetched from the
 * server when a page opens and cached in `storage.local`, so the popup can still name devices
 * offline. Names are plaintext on the server anyway (ADR-0009).
 */
import type { WxtBrowser } from 'wxt/browser';
import { z } from 'zod';
import { schema } from '@tazamun/core';
import { clientFor, handleUnauthorized } from './session.ts';
import { getAccountState } from './store.ts';

const CACHE_KEY = 'devices';
const cache = z.object({ accountId: schema.accountId, devices: z.array(schema.device) });

/** The device list, from the server if reachable, else the cache; undefined if neither. */
export async function loadDevices(browser: WxtBrowser): Promise<schema.Device[] | undefined> {
  const state = await getAccountState(browser);
  if (state.status !== 'signed-in' && state.status !== 'locked') return undefined;
  const { serverUrl, token, accountId } = state.account;
  try {
    const devices = await clientFor(serverUrl, token).listDevices();
    await browser.storage.local.set({ [CACHE_KEY]: { accountId, devices } });
    return devices;
  } catch (err) {
    if (await handleUnauthorized(browser, err)) return undefined;
    const cached = cache.safeParse((await browser.storage.local.get(CACHE_KEY))[CACHE_KEY]);
    return cached.success && cached.data.accountId === accountId ? cached.data.devices : undefined;
  }
}
