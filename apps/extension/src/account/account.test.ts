import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { crypto as tzCrypto } from '@tazamun/core';
import { detectBrowser, osDisplayName } from './device.ts';
import { recoveryKit, recoveryKitText } from './recovery-kit.ts';
import { refreshAccountState, signOut } from './session.ts';
import {
  forgetAccount,
  getAccountState,
  getSettings,
  markSignedOut,
  saveSignedIn,
  saveUnlockedKey,
  setRememberKey,
  type SignInResult,
} from './store.ts';

function signInResult(): SignInResult {
  return {
    serverUrl: 'https://sync.example.org',
    accountId: tzCrypto.randomId(),
    deviceId: tzCrypto.randomId(),
    deviceName: 'Firefox on Linux',
    token: tzCrypto.toBase64Url(tzCrypto.randomBytes(32)),
    accountKey: tzCrypto.generateAccountKey(),
  };
}

async function keyIn(area: 'local' | 'session'): Promise<unknown> {
  return (await fakeBrowser.storage[area].get('accountKey'))['accountKey'];
}

/** The browser closed: storage.session is gone, storage.local stays. */
async function restartBrowser(): Promise<void> {
  await fakeBrowser.storage.session.clear();
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('account storage (SEC-5, ACC-11)', () => {
  it('starts signed out, with the default settings (Q3: remember the key)', async () => {
    expect(await getAccountState(browser)).toEqual({ status: 'signed-out' });
    expect(await getSettings(browser)).toEqual({
      rememberKey: true,
      paused: false,
      modules: { tabs: true },
    });
  });

  it('remembers the key across a browser restart by default', async () => {
    const result = signInResult();
    await saveSignedIn(browser, result, true);
    await restartBrowser();
    const state = await getAccountState(browser);
    expect(state.status).toBe('signed-in');
    if (state.status !== 'signed-in') return;
    expect(tzCrypto.toBase64Url(state.accountKey)).toBe(tzCrypto.toBase64Url(result.accountKey));
    expect(await keyIn('session')).toBeUndefined();
  });

  it('keeps the key in memory only when not remembered, and locks after a restart', async () => {
    const result = signInResult();
    await saveSignedIn(browser, result, false);
    expect(await keyIn('local')).toBeUndefined();
    expect((await getAccountState(browser)).status).toBe('signed-in');

    await restartBrowser();
    expect((await getAccountState(browser)).status).toBe('locked');

    await saveUnlockedKey(browser, result.accountKey);
    expect((await getAccountState(browser)).status).toBe('signed-in');
    expect(await keyIn('local')).toBeUndefined();
  });

  it('moves an unlocked key when the setting changes', async () => {
    await saveSignedIn(browser, signInResult(), true);
    await setRememberKey(browser, false);
    expect(await keyIn('local')).toBeUndefined();
    expect(await keyIn('session')).toBeDefined();
    expect((await getSettings(browser)).rememberKey).toBe(false);

    await setRememberKey(browser, true);
    expect(await keyIn('local')).toBeDefined();
    expect(await keyIn('session')).toBeUndefined();
  });

  it('forgets the token and key on sign-out but keeps the account (ACC-11)', async () => {
    const result = signInResult();
    await saveSignedIn(browser, result, true);
    await markSignedOut(browser, 'revoked');
    const state = await getAccountState(browser);
    expect(state).toMatchObject({
      status: 'disconnected',
      account: {
        serverUrl: result.serverUrl,
        accountId: result.accountId,
        deviceId: result.deviceId,
        signedOut: 'revoked',
      },
    });
    expect(state.account?.token).toBeUndefined();
    expect(await keyIn('local')).toBeUndefined();
    expect(await keyIn('session')).toBeUndefined();

    await forgetAccount(browser);
    expect(await getAccountState(browser)).toEqual({ status: 'signed-out' });
  });

  it('treats a corrupted entry as signed out instead of throwing', async () => {
    await fakeBrowser.storage.local.set({ account: { serverUrl: 42 }, settings: 'nope' });
    expect(await getAccountState(browser)).toEqual({ status: 'signed-out' });
    expect((await getSettings(browser)).rememberKey).toBe(true);
  });
});

describe('talking to the server', () => {
  function respond(status: number, body: unknown) {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('signs out locally when the server says the device was revoked (ACC-8)', async () => {
    await saveSignedIn(browser, signInResult(), true);
    respond(401, { error: { code: 'UNAUTHORIZED', message: 'Not signed in' } });
    const state = await refreshAccountState(browser);
    expect(state).toMatchObject({ status: 'disconnected', account: { signedOut: 'revoked' } });
  });

  it('stays signed in while offline', async () => {
    await saveSignedIn(browser, signInResult(), true);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    expect((await refreshAccountState(browser)).status).toBe('signed-in');
  });

  it('signs out even when the server is unreachable', async () => {
    const result = signInResult();
    await saveSignedIn(browser, result, true);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    await signOut(browser);
    expect(await getAccountState(browser)).toMatchObject({
      status: 'disconnected',
      account: { signedOut: 'user' },
    });
  });

  it('ends the session on the server when signing out', async () => {
    const result = signInResult();
    await saveSignedIn(browser, result, true);
    const fetch = respond(204, undefined);
    await signOut(browser);
    expect(fetch).toHaveBeenCalledWith(
      'https://sync.example.org/v1/sessions/current',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('device identity (ACC-7)', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
      { family: 'firefox', version: '140', displayName: 'Firefox' },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
      { family: 'edge', version: '142', displayName: 'Edge' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      { family: 'chrome', version: '142', displayName: 'Chrome' },
    ],
    ['Something else', { family: 'chromium', version: '0', displayName: 'Chromium' }],
  ])('%s', (userAgent, expected) => {
    expect(detectBrowser(userAgent)).toEqual(expected);
  });

  it('names operating systems', () => {
    expect(osDisplayName('mac')).toBe('macOS');
    expect(osDisplayName('plan9')).toBeUndefined();
  });
});

describe('recovery kit (ACC-5)', () => {
  it('holds the server, account ID and pairing code, and no secrets', () => {
    fakeBrowser.i18n.getMessage = (key: string) => `[${key}]`;
    const accountId = tzCrypto.randomId();
    const kit = recoveryKit('https://sync.example.org', accountId);
    const text = recoveryKitText(kit, new Date('2026-11-25T12:00:00Z'));
    expect(text).toContain('https://sync.example.org');
    expect(text).toContain(accountId);
    expect(text).toContain(`tazamun:${accountId}@https://sync.example.org`);
    expect(text).toContain('2026-11-25');
  });
});
