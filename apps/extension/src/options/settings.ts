/**
 * Options page logic (UI-3), outside the `.vue` file so it is tested: username (ACC-13), recovery
 * key (ACC-5), device name (ACC-7), revoking devices (ACC-8), modules on or off with PRIV-2, and
 * the exclusion list (PRIV-3).
 */
import type { WxtBrowser } from 'wxt/browser';
import { account as coreAccount, api, type schema } from '@tazamun/core';
import { loadDevices } from '../account/devices.ts';
import { clientFor, handleUnauthorized } from '../account/session.ts';
import {
  getAccountState,
  getSettings,
  saveSettings,
  setDeviceName,
  setUsername,
  type ModuleId,
} from '../account/store.ts';
import type { SyncMessage } from '../background/sync.ts';
import { parseExclusion } from '../lib/exclusions.ts';
import { validateDeviceName, validateUsername } from '../onboarding/form.ts';

export type ActionResult = { ok: true } | { ok: false; error: 'invalid' | 'signed-out' | 'failed' };

async function signedIn(browser: WxtBrowser) {
  const state = await getAccountState(browser);
  return state.status === 'signed-in' || state.status === 'locked' ? state.account : undefined;
}

async function call(browser: WxtBrowser, action: () => Promise<void>): Promise<ActionResult> {
  try {
    await action();
    return { ok: true };
  } catch (err) {
    if (await handleUnauthorized(browser, err)) return { ok: false, error: 'signed-out' };
    return { ok: false, error: 'failed' };
  }
}

/**
 * The account as the server sees it: username (null for accounts from before usernames) and
 * whether a recovery key is set. Undefined when offline or signed out.
 */
export async function loadAccountInfo(
  browser: WxtBrowser,
): Promise<schema.AccountResponse | undefined> {
  const account = await signedIn(browser);
  if (account === undefined) return undefined;
  try {
    const info = await clientFor(account.serverUrl, account.token).account();
    if (info.username !== null) await setUsername(browser, info.username);
    return info;
  } catch (err) {
    await handleUnauthorized(browser, err);
    return undefined;
  }
}

export type UsernameResult =
  | { ok: true; username: string }
  | { ok: false; error: 'invalid' | 'taken' | 'signed-out' | 'failed' };

/** ACC-13: set or change the username. Other browsers keep working; they sign in with it next time. */
export async function changeUsername(browser: WxtBrowser, input: string): Promise<UsernameResult> {
  const username = validateUsername(input);
  if (!username.ok) return { ok: false, error: 'invalid' };
  const account = await signedIn(browser);
  if (account === undefined) return { ok: false, error: 'signed-out' };
  try {
    await clientFor(account.serverUrl, account.token).updateUsername(username.value);
    await setUsername(browser, username.value);
    return { ok: true, username: username.value };
  } catch (err) {
    if (await handleUnauthorized(browser, err)) return { ok: false, error: 'signed-out' };
    if (err instanceof api.ApiError && err.code === 'USERNAME_TAKEN') {
      return { ok: false, error: 'taken' };
    }
    return { ok: false, error: 'failed' };
  }
}

export type RecoveryKeyResult =
  | { ok: true; recoveryKey: string }
  | { ok: false; error: 'wrong-passphrase' | 'locked' | 'signed-out' | 'failed' };

/**
 * ACC-5: a new recovery key, replacing the old one (which stops working). Needs the passphrase,
 * and this browser must be unlocked, since the key wraps the account key.
 */
export async function newRecoveryKey(
  browser: WxtBrowser,
  passphrase: string,
): Promise<RecoveryKeyResult> {
  const state = await getAccountState(browser);
  if (state.status === 'locked') return { ok: false, error: 'locked' };
  if (state.status !== 'signed-in') return { ok: false, error: 'signed-out' };
  const { serverUrl, token, accountId } = state.account;
  try {
    const recoveryKey = await coreAccount.createRecoveryKey(
      clientFor(serverUrl, token),
      accountId,
      state.accountKey,
      passphrase,
    );
    return { ok: true, recoveryKey };
  } catch (err) {
    if (await handleUnauthorized(browser, err)) return { ok: false, error: 'signed-out' };
    if (err instanceof api.ApiError && err.code === 'INVALID_CREDENTIALS') {
      return { ok: false, error: 'wrong-passphrase' };
    }
    return { ok: false, error: 'failed' };
  }
}

/** ACC-7: rename this device on the server and here. */
export async function renameThisDevice(browser: WxtBrowser, input: string): Promise<ActionResult> {
  const name = validateDeviceName(input);
  if (!name.ok) return { ok: false, error: 'invalid' };
  const account = await signedIn(browser);
  if (account === undefined) return { ok: false, error: 'signed-out' };
  return call(browser, async () => {
    await clientFor(account.serverUrl, account.token).renameDevice(account.deviceId, name.value);
    await setDeviceName(browser, name.value);
    await loadDevices(browser);
  });
}

/** ACC-8: revoke another device. Its session ends at once; it shows the revoked state. */
export async function revokeDevice(browser: WxtBrowser, deviceId: string): Promise<ActionResult> {
  const account = await signedIn(browser);
  if (account === undefined) return { ok: false, error: 'signed-out' };
  if (deviceId === account.deviceId) return { ok: false, error: 'invalid' };
  return call(browser, async () => {
    await clientFor(account.serverUrl, account.token).revokeDevice(deviceId);
    await loadDevices(browser);
  });
}

/**
 * ENG-12 and PRIV-2: switch a module on this device. Turning it off can also delete this
 * device's data for it from the server; the engine then publishes the module's deletions.
 */
export async function setModuleEnabled(
  browser: WxtBrowser,
  module: ModuleId,
  enabled: boolean,
  deleteFromServer: boolean,
): Promise<void> {
  const settings = await getSettings(browser);
  await saveSettings(browser, { ...settings, modules: { ...settings.modules, [module]: enabled } });
  if (!enabled && deleteFromServer) {
    const message: SyncMessage = { type: 'retire', collection: module };
    await browser.runtime.sendMessage(message);
  }
}

/** One pattern per line. Blank lines are ignored; unusable ones are reported by line. */
export function parseExclusionText(text: string): { patterns: string[]; invalid: string[] } {
  const patterns: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (parseExclusion(line) === undefined) invalid.push(line);
    else if (!patterns.includes(line)) patterns.push(line);
  }
  return { patterns, invalid };
}

export async function saveExclusions(browser: WxtBrowser, patterns: string[]): Promise<void> {
  const settings = await getSettings(browser);
  await saveSettings(browser, { ...settings, exclusions: patterns });
}

/** The device list for the Devices section, this device first. */
export function orderDevices(devices: readonly schema.Device[]): schema.Device[] {
  return [...devices].sort(
    (a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name),
  );
}
