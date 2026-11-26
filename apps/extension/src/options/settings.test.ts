import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { api, crypto as tzCrypto, type schema } from '@tazamun/core';
import { getAccountState, getSettings, saveSignedIn } from '../account/store.ts';
import { SyncEngine } from '../engine/engine.ts';
import { MemoryStore } from '../engine/store.ts';
import { FakeServer } from '../engine/testing.ts';
import { TabsModule } from '../modules/tabs/module.ts';
import {
  changeUsername,
  loadAccountInfo,
  orderDevices,
  parseExclusionText,
  renameThisDevice,
  revokeDevice,
  setModuleEnabled,
} from './settings.ts';

const ACCOUNT_ID = tzCrypto.randomId();

beforeEach(async () => {
  fakeBrowser.reset();
  await saveSignedIn(
    browser,
    {
      serverUrl: 'https://sync.example.org',
      accountId: ACCOUNT_ID,
      username: 'hasan',
      deviceId: 'dev_A',
      deviceName: 'Old name',
      token: tzCrypto.toBase64Url(tzCrypto.randomBytes(32)),
      accountKey: tzCrypto.generateAccountKey(),
    },
    true,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body?: unknown) {
  const fetch = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('username (ACC-13)', () => {
  it('changes the username on the server and here', async () => {
    const fetch = respond(204);
    expect(await changeUsername(browser, ' Hasan.D ')).toEqual({ ok: true, username: 'hasan.d' });
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe('https://sync.example.org/v1/accounts/me/username');
    expect(JSON.parse(call?.[1].body as string)).toEqual({ username: 'hasan.d' });
    expect((await getAccountState(browser)).account?.username).toBe('hasan.d');
  });

  it('refuses an invalid username without calling the server, and reports a taken one', async () => {
    const fetch = respond(409, { error: { code: 'USERNAME_TAKEN', message: 'Taken' } });
    expect(await changeUsername(browser, 'a')).toEqual({ ok: false, error: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await changeUsername(browser, 'other')).toEqual({ ok: false, error: 'taken' });
    expect((await getAccountState(browser)).account?.username).toBe('hasan');
  });

  it('keeps the username the server reports', async () => {
    respond(200, { accountId: ACCOUNT_ID, username: 'renamed', recoveryKey: false });
    expect(await loadAccountInfo(browser)).toEqual({
      accountId: ACCOUNT_ID,
      username: 'renamed',
      recoveryKey: false,
    });
    expect((await getAccountState(browser)).account?.username).toBe('renamed');
  });
});

describe('device name and devices (ACC-7, ACC-8)', () => {
  it('renames this device on the server and locally', async () => {
    const fetch = respond(204);
    expect(await renameThisDevice(browser, '  Work laptop  ')).toEqual({ ok: true });
    const rename = fetch.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(rename?.[0]).toBe('https://sync.example.org/v1/devices/dev_A');
    expect(JSON.parse(rename?.[1].body as string)).toEqual({ name: 'Work laptop' });
    expect((await getAccountState(browser)).account?.deviceName).toBe('Work laptop');
  });

  it('refuses an empty name without calling the server', async () => {
    const fetch = respond(204);
    expect(await renameThisDevice(browser, '   ')).toEqual({ ok: false, error: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('revokes another device but never this one', async () => {
    const fetch = respond(204);
    expect(await revokeDevice(browser, 'dev_A')).toEqual({ ok: false, error: 'invalid' });
    expect(await revokeDevice(browser, 'dev_B')).toEqual({ ok: true });
    expect(
      fetch.mock.calls.some(
        ([url, init]) => url.endsWith('/v1/devices/dev_B') && init.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('notices when this device was revoked meanwhile', async () => {
    respond(401, { error: { code: 'UNAUTHORIZED', message: 'Not signed in' } });
    expect(await revokeDevice(browser, 'dev_B')).toEqual({ ok: false, error: 'signed-out' });
    expect((await getAccountState(browser)).status).toBe('disconnected');
  });

  it('lists this device first, then by name', () => {
    const d = (id: string, name: string, current = false): schema.Device => ({
      id,
      name,
      current,
      browser: { family: 'chrome', version: '142' },
      createdAt: '2026-11-01T00:00:00Z',
      lastSeenAt: '2026-11-25T00:00:00Z',
    });
    expect(
      orderDevices([d('b', 'Zed'), d('c', 'Alpha'), d('a', 'Me', true)]).map((x) => x.id),
    ).toEqual(['a', 'c', 'b']);
  });
});

describe('modules and PRIV-2', () => {
  it('asks the background to delete server data only when chosen', async () => {
    const sent: unknown[] = [];
    fakeBrowser.runtime.sendMessage = (message: unknown) => {
      sent.push(message);
      return Promise.resolve(undefined);
    };
    await setModuleEnabled(browser, 'tabs', false, false);
    expect((await getSettings(browser)).modules.tabs).toBe(false);
    expect(sent).toEqual([]);
    await setModuleEnabled(browser, 'tabs', false, true);
    expect(sent).toEqual([{ type: 'retire', collection: 'tabs' }]);
    await setModuleEnabled(browser, 'tabs', true, true);
    expect((await getSettings(browser)).modules.tabs).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('deletes this device tabs record from the server when tabs is retired', async () => {
    const server = new FakeServer();
    fakeBrowser.windows.getAll = () =>
      Promise.resolve([
        {
          incognito: false,
          focused: true,
          type: 'normal',
          tabs: [
            {
              url: 'https://example.org/',
              title: 'x',
              pinned: false,
              active: true,
              incognito: false,
              index: 0,
            },
          ],
        },
      ] as never);
    const switches = { paused: false, modules: { tabs: true } as Record<string, boolean> };
    const engine = new SyncEngine({
      store: new MemoryStore(),
      modules: [new TabsModule(browser)],
      session: () =>
        Promise.resolve({
          serverUrl: 'https://s.example',
          accountId: 'q4FIt0kT1zxqI0Z9Jq2cXw',
          deviceId: 'dev_A',
          token: 't',
          accountKey: tzCrypto.generateAccountKey(),
        }),
      switches: () => Promise.resolve(switches),
      client: (baseUrl, token) => new api.ApiClient({ baseUrl, token, fetch: server.fetch }),
      onUnauthorized: () => Promise.resolve(),
      publishStatus: () => Promise.resolve(),
      clientVersion: '0.1.0',
      now: () => Date.now(),
      random: () => 0.5,
    });
    await engine.sync('alarm');
    const published = server.collection('tabs').get('dev_A')?.seq;
    expect(published).toBe(1);

    // Turned off with "delete": the module is skipped from now on, but its deletion goes out.
    switches.modules = { tabs: false };
    await engine.retire('tabs');
    expect(server.collection('tabs').get('dev_A')?.seq).toBe(2);
    // Nothing more after that, while tabs stays off.
    await engine.sync('alarm');
    expect(server.collection('tabs').get('dev_A')?.seq).toBe(2);
  });
});

describe('exclusion list text (PRIV-3)', () => {
  it('keeps valid patterns once, ignores blank lines and reports unusable ones', () => {
    expect(
      parseExclusionText('bank.example\n\n  health.example/records \r\nbank.example\nex*ample'),
    ).toEqual({
      patterns: ['bank.example', 'health.example/records'],
      invalid: ['ex*ample'],
    });
  });
});
