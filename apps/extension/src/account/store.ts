/**
 * Where this device keeps its account (SRS 3.1, SEC-5, ACC-11).
 *
 * - `storage.local` `account`: server URL, account ID, device ID and name, session token. Kept
 *   after sign-out (without the token), so reconnecting needs only the passphrase.
 * - The account key: `storage.local` when *remember on this device* is on (the default, Q3),
 *   otherwise `storage.session`, which the browser keeps in memory and clears when it closes.
 *   Exactly one of the two holds it at any time.
 * - `storage.local` `settings`: remember-key choice and modules on or off.
 *
 * Everything is validated on read: a corrupted or older entry reads as missing, never throws.
 */
import type { WxtBrowser } from 'wxt/browser';
import { z } from 'zod';
import { crypto as tzCrypto, schema } from '@tazamun/core';

const ACCOUNT_KEY = 'account';
const ACCOUNT_KEY_KEY = 'accountKey';
const SETTINGS_KEY = 'settings';

const storedAccount = z.object({
  serverUrl: z.string().min(1),
  accountId: schema.accountId,
  deviceId: schema.deviceId,
  deviceName: schema.deviceName,
  /** Absent after sign-out or revocation. */
  token: schema.sessionToken.optional(),
  /** Why the token is gone, for the signed-out screen (ACC-11). */
  signedOut: z.enum(['user', 'revoked']).optional(),
});
export type StoredAccount = z.infer<typeof storedAccount>;

/** Module IDs that exist in this version. History, bookmarks and extensions follow (P2–P5). */
export const MODULES = ['tabs'] as const;
export type ModuleId = (typeof MODULES)[number];

const settings = z.object({
  rememberKey: z.boolean().default(true),
  /** ENG-12: all sync paused on this device. */
  paused: z.boolean().default(false),
  /** PRIV-3, TAB-3: sites that never leave this device (patterns: `src/lib/exclusions.ts`). */
  exclusions: z.array(z.string().max(500)).max(1000).default([]),
  modules: z.object({ tabs: z.boolean().default(true) }).prefault({}),
});
export type Settings = z.infer<typeof settings>;

const storedKey = schema.base64url.length(43);

export type AccountState =
  /** Never set up on this browser. */
  | { readonly status: 'signed-out'; readonly account?: undefined }
  /** Set up once, but signed out by the user or revoked from another device (ACC-11). */
  | { readonly status: 'disconnected'; readonly account: StoredAccount }
  /** Signed in, but the account key was dropped (SEC-5, not remembered): needs the passphrase. */
  | { readonly status: 'locked'; readonly account: StoredAccount & { token: string } }
  | {
      readonly status: 'signed-in';
      readonly account: StoredAccount & { token: string };
      readonly accountKey: Uint8Array<ArrayBuffer>;
    };

export async function getSettings(browser: WxtBrowser): Promise<Settings> {
  const raw = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const parsed = settings.safeParse(raw ?? {});
  return parsed.success ? parsed.data : settings.parse({});
}

export async function saveSettings(browser: WxtBrowser, value: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings.parse(value) });
}

export async function getAccountState(browser: WxtBrowser): Promise<AccountState> {
  const raw = (await browser.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY];
  const parsed = storedAccount.safeParse(raw);
  if (!parsed.success) return { status: 'signed-out' };
  const account = parsed.data;
  const { token } = account;
  if (token === undefined) return { status: 'disconnected', account };
  const accountKey = await readAccountKey(browser);
  if (accountKey === undefined) return { status: 'locked', account: { ...account, token } };
  return { status: 'signed-in', account: { ...account, token }, accountKey };
}

export interface SignInResult {
  readonly serverUrl: string;
  readonly accountId: string;
  readonly deviceName: string;
  readonly deviceId: string;
  readonly token: string;
  readonly accountKey: Uint8Array<ArrayBuffer>;
}

/** After creating or connecting an account (onboarding) or signing in again. */
export async function saveSignedIn(
  browser: WxtBrowser,
  result: SignInResult,
  rememberKey: boolean,
): Promise<void> {
  const account: StoredAccount = {
    serverUrl: result.serverUrl,
    accountId: result.accountId,
    deviceId: result.deviceId,
    deviceName: result.deviceName,
    token: result.token,
  };
  await writeAccountKey(browser, result.accountKey, rememberKey);
  await browser.storage.local.set({ [ACCOUNT_KEY]: storedAccount.parse(account) });
  const current = await getSettings(browser);
  await saveSettings(browser, { ...current, rememberKey });
}

/** Unlock (SEC-5): the passphrase gave the account key back. */
export async function saveUnlockedKey(
  browser: WxtBrowser,
  accountKey: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const { rememberKey } = await getSettings(browser);
  await writeAccountKey(browser, accountKey, rememberKey);
}

/**
 * Change SEC-5's setting. Moves a key that is already unlocked to the other storage area, so
 * turning *remember* off takes effect without signing out.
 */
export async function setRememberKey(browser: WxtBrowser, rememberKey: boolean): Promise<void> {
  const key = await readAccountKey(browser);
  if (key !== undefined) await writeAccountKey(browser, key, rememberKey);
  const current = await getSettings(browser);
  await saveSettings(browser, { ...current, rememberKey });
}

/**
 * ACC-11: forget the token and the account key, keep everything else (server, account ID, device
 * ID, and later the module data) until the user chooses to remove it.
 */
export async function markSignedOut(
  browser: WxtBrowser,
  reason: 'user' | 'revoked',
): Promise<void> {
  const raw = (await browser.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY];
  const parsed = storedAccount.safeParse(raw);
  await clearAccountKey(browser);
  if (!parsed.success) return;
  const signedOut: StoredAccount = { ...parsed.data, signedOut: reason };
  delete signedOut.token;
  await browser.storage.local.set({ [ACCOUNT_KEY]: signedOut });
}

/**
 * Remove the account from this browser entirely ("Remove from this browser" after sign-out). The
 * engine's synced data in IndexedDB is the caller's to clear (`clearEngineData`), since this module
 * only owns `storage`.
 */
export async function forgetAccount(browser: WxtBrowser): Promise<void> {
  await clearAccountKey(browser);
  await browser.storage.local.remove([
    ACCOUNT_KEY,
    'engineStatus',
    'devices',
    // The commands module's queues (src/modules/commands/module.ts).
    'commandsOutgoing',
    'commandsToDelete',
    'commandsDone',
  ]);
}

async function readAccountKey(browser: WxtBrowser): Promise<Uint8Array<ArrayBuffer> | undefined> {
  for (const area of [browser.storage.session, browser.storage.local]) {
    const parsed = storedKey.safeParse((await area.get(ACCOUNT_KEY_KEY))[ACCOUNT_KEY_KEY]);
    if (parsed.success) return tzCrypto.fromBase64Url(parsed.data);
  }
  return undefined;
}

async function writeAccountKey(
  browser: WxtBrowser,
  accountKey: Uint8Array<ArrayBuffer>,
  remember: boolean,
): Promise<void> {
  const value = { [ACCOUNT_KEY_KEY]: tzCrypto.toBase64Url(accountKey) };
  // Write the new place first, then clear the other, so a crash in between never loses the key.
  if (remember) {
    await browser.storage.local.set(value);
    await browser.storage.session.remove(ACCOUNT_KEY_KEY);
  } else {
    await browser.storage.session.set(value);
    await browser.storage.local.remove(ACCOUNT_KEY_KEY);
  }
}

async function clearAccountKey(browser: WxtBrowser): Promise<void> {
  await browser.storage.session.remove(ACCOUNT_KEY_KEY);
  await browser.storage.local.remove(ACCOUNT_KEY_KEY);
}
