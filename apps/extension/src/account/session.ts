/**
 * Onboarding and sign-in, wired to the browser: the shared flows from @tazamun/core, plus this
 * device's identity, the host permission and storage (SRS 3.1, UI-2).
 */
import type { WxtBrowser } from 'wxt/browser';
import { account, api, type schema } from '@tazamun/core';
import { t } from '../lib/i18n.ts';
import { detectBrowser, osDisplayName } from './device.ts';
import {
  getAccountState,
  markSignedOut,
  saveSignedIn,
  saveUnlockedKey,
  type AccountState,
} from './store.ts';

/** The server isn't compatible, or registration isn't possible. Codes map to UI messages. */
export class OnboardingError extends Error {
  readonly reason: 'client-too-old' | 'registration-closed' | 'permission-denied';

  constructor(reason: OnboardingError['reason']) {
    super(reason);
    this.name = 'OnboardingError';
    this.reason = reason;
  }
}

export function clientVersion(browser: WxtBrowser): string {
  return browser.runtime.getManifest().version;
}

export function clientFor(serverUrl: string, token?: string): api.ApiClient {
  return new api.ApiClient({ baseUrl: serverUrl, ...(token === undefined ? {} : { token }) });
}

/**
 * Ask for the host permission on the server (SRS 2.7: optional, for this one origin).
 *
 * **Call this first thing in a click handler, before any `await`.** Browsers grant permission
 * requests only during a user gesture, and an `await` before the call ends it.
 */
export function requestServerPermission(browser: WxtBrowser, serverUrl: string): Promise<boolean> {
  return browser.permissions.request({ origins: [account.hostPermissionPattern(serverUrl)] });
}

/** Check the server after the permission is granted: reachable, a Tazamun server, compatible. */
export async function checkServer(
  browser: WxtBrowser,
  serverUrl: string,
): Promise<schema.InfoResponse> {
  const info = await clientFor(serverUrl).info();
  if (!api.isClientSupported(clientVersion(browser), info.minClientVersion)) {
    throw new OnboardingError('client-too-old');
  }
  return info;
}

/** ACC-7: browser family and version, and the default name. */
export async function thisDevice(
  browser: WxtBrowser,
  userAgent: string,
): Promise<{ browser: schema.DeviceRegistration['browser']; defaultName: string }> {
  const identity = detectBrowser(userAgent);
  const { os } = await browser.runtime.getPlatformInfo();
  const osName = osDisplayName(os);
  return {
    browser: { family: identity.family, version: identity.version },
    defaultName:
      osName === undefined
        ? identity.displayName
        : t('deviceDefaultName', [identity.displayName, osName]),
  };
}

export interface DeviceChoice {
  readonly name: string;
  readonly browser: schema.DeviceRegistration['browser'];
}

/** The device ID stays the same across sign-outs, so this browser's records keep their IDs. */
async function deviceIdFor(browser: WxtBrowser): Promise<string> {
  const state = await getAccountState(browser);
  return state.account?.deviceId ?? account.newDeviceId();
}

/** SRS 3.1 step 1. Returns the account ID for the recovery kit. */
export async function createAndSignIn(
  browser: WxtBrowser,
  input: {
    serverUrl: string;
    passphrase: string;
    invite?: string;
    device: DeviceChoice;
    rememberKey: boolean;
  },
): Promise<string> {
  const deviceId = await deviceIdFor(browser);
  const signedIn = await account.createAccount(clientFor(input.serverUrl), {
    passphrase: input.passphrase,
    device: { id: deviceId, name: input.device.name, browser: input.device.browser },
    ...(input.invite === undefined || input.invite === '' ? {} : { invite: input.invite }),
  });
  await saveSignedIn(
    browser,
    {
      serverUrl: input.serverUrl,
      accountId: signedIn.accountId,
      deviceId,
      deviceName: signedIn.device.name,
      token: signedIn.token,
      accountKey: signedIn.accountKey,
    },
    input.rememberKey,
  );
  return signedIn.accountId;
}

/** SRS 3.1 step 2, and signing in again after a sign-out or revocation. */
export async function connectAndSignIn(
  browser: WxtBrowser,
  input: {
    serverUrl: string;
    accountId: string;
    passphrase: string;
    device: DeviceChoice;
    rememberKey: boolean;
  },
): Promise<void> {
  const deviceId = await deviceIdFor(browser);
  const signedIn = await account.connectAccount(clientFor(input.serverUrl), {
    accountId: input.accountId,
    passphrase: input.passphrase,
    device: { id: deviceId, name: input.device.name, browser: input.device.browser },
  });
  await saveSignedIn(
    browser,
    {
      serverUrl: input.serverUrl,
      accountId: signedIn.accountId,
      deviceId,
      deviceName: signedIn.device.name,
      token: signedIn.token,
      accountKey: signedIn.accountKey,
    },
    input.rememberKey,
  );
}

/** SEC-5: the key wasn't remembered; get it back with the passphrase. */
export async function unlock(browser: WxtBrowser, passphrase: string): Promise<void> {
  const state = await getAccountState(browser);
  if (state.status !== 'locked') return;
  const { serverUrl, accountId, token } = state.account;
  try {
    const key = await account.unlockAccount(clientFor(serverUrl, token), accountId, passphrase);
    await saveUnlockedKey(browser, key);
  } catch (err) {
    await handleUnauthorized(browser, err);
    throw err;
  }
}

/** ACC-11: sign out on the server (best effort) and locally; local data stays. */
export async function signOut(browser: WxtBrowser): Promise<void> {
  const state = await getAccountState(browser);
  if (state.status === 'locked' || state.status === 'signed-in') {
    try {
      await clientFor(state.account.serverUrl, state.account.token).deleteSession();
    } catch {
      // Offline or already revoked: the local sign-out still happens. The server drops the
      // session when the device is revoked or the account deleted.
    }
  }
  await markSignedOut(browser, 'user');
}

/**
 * ACC-8 on this side: a 401 means the device was revoked (or the account deleted). Drop the token
 * and the key, keep the rest (ACC-11). Returns true if it was a 401.
 */
export async function handleUnauthorized(browser: WxtBrowser, err: unknown): Promise<boolean> {
  if (err instanceof api.ApiError && err.code === 'UNAUTHORIZED') {
    await markSignedOut(browser, 'revoked');
    return true;
  }
  return false;
}

/**
 * Popup and options: confirm with the server that this device is still signed in. Returns the
 * state after the check. Network errors leave the state as it is (offline is not signed out).
 */
export async function refreshAccountState(browser: WxtBrowser): Promise<AccountState> {
  const state = await getAccountState(browser);
  if (state.status !== 'signed-in' && state.status !== 'locked') return state;
  try {
    const info = await clientFor(state.account.serverUrl, state.account.token).info();
    // /v1/info answers without auth too; `account` is present only for a valid token.
    if (info.account === undefined) await markSignedOut(browser, 'revoked');
  } catch (err) {
    await handleUnauthorized(browser, err);
  }
  return getAccountState(browser);
}
