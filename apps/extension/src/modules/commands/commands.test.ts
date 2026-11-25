import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { api, crypto as tzCrypto, schema } from '@tazamun/core';
import { menuClickToSend } from '../../background/menus.ts';
import { isSyncMessage } from '../../background/sync.ts';
import { SyncEngine } from '../../engine/engine.ts';
import { MemoryStore } from '../../engine/store.ts';
import { FakeServer } from '../../engine/testing.ts';
import { ICONS } from '../../manifest.ts';
import { CommandsModule, type SentTab } from './module.ts';
import { isSendableUrl, sendRefusal } from './send.ts';

const accountId = tzCrypto.randomId();
const accountKey = tzCrypto.generateAccountKey();

interface Device {
  id: string;
  module: CommandsModule;
  engine: SyncEngine;
  store: MemoryStore;
  opened: { tab: SentTab; sender: string }[];
  clock: { now: number };
}

/**
 * Each device needs its own storage.local, but the fake browser has one. The module only uses
 * `storage.local` through get/set, so give each device a namespaced view.
 */
function scopedBrowser(prefix: string): typeof browser {
  const local = {
    get: async (key: string) => {
      const value = (await fakeBrowser.storage.local.get(`${prefix}:${key}`))[`${prefix}:${key}`];
      return value === undefined ? {} : { [key]: value };
    },
    set: async (items: Record<string, unknown>) => {
      await fakeBrowser.storage.local.set(
        Object.fromEntries(Object.entries(items).map(([k, v]) => [`${prefix}:${k}`, v])),
      );
    },
  };
  return { ...browser, storage: { ...browser.storage, local } } as unknown as typeof browser;
}

function device(server: FakeServer, id: string): Device {
  const store = new MemoryStore();
  const opened: Device['opened'] = [];
  const clock = { now: Date.parse('2026-11-25T10:00:00Z') };
  const module = new CommandsModule(scopedBrowser(id), {
    receiver: {
      open: (tab, sender) => {
        opened.push({ tab, sender });
        return Promise.resolve(true);
      },
    },
    deviceId: () => Promise.resolve(id),
    now: () => clock.now,
  });
  const engine = new SyncEngine({
    store,
    modules: [module],
    session: () =>
      Promise.resolve({
        serverUrl: 'https://s.example',
        accountId,
        deviceId: id,
        token: 't',
        accountKey,
      }),
    switches: () => Promise.resolve({ paused: false, modules: {} }),
    client: (baseUrl, token) => new api.ApiClient({ baseUrl, token, fetch: server.fetch }),
    onUnauthorized: () => Promise.resolve(),
    publishStatus: () => Promise.resolve(),
    clientVersion: '0.1.0',
    now: () => clock.now,
    random: () => 0.5,
  });
  return { id, module, engine, store, opened, clock };
}

const TAB = { url: 'https://example.org/article', title: 'An article' };

beforeEach(() => {
  fakeBrowser.reset();
});

describe('send tab (TAB-7)', () => {
  it('opens on the target once, then deletes the command', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    await a.module.send('dev_B', 'dev_A', TAB);
    await a.engine.sync('ui');
    const [record] = [...server.collection('commands').values()];
    expect(record?.expiresAt).toBe('2026-12-02T10:00:00Z');
    // Encrypted: the server never sees the URL.
    expect(record?.payload).not.toContain('example.org');

    await b.engine.sync('alarm');
    expect(b.opened).toEqual([{ tab: TAB, sender: 'dev_A' }]);

    // The tombstone goes out on the next run, and opening doesn't repeat.
    await b.engine.sync('local-change');
    await b.engine.sync('alarm');
    expect(b.opened).toHaveLength(1);
    const after = await b.store.getMirror('commands', record?.id ?? '');
    expect(after?.payload).toMatchObject({ deleted: true });

    // The sender sees the deletion too.
    await a.engine.sync('alarm');
    expect((await a.store.getMirror('commands', record?.id ?? ''))?.payload).toMatchObject({
      deleted: true,
    });
  });

  it('is not opened by other devices, nor by the sender', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    const c = device(server, 'dev_C');
    await a.module.send('dev_C', 'dev_A', TAB);
    await a.engine.sync('ui');
    await b.engine.sync('alarm');
    await a.engine.sync('alarm');
    expect(b.opened).toEqual([]);
    expect(a.opened).toEqual([]);
    await c.engine.sync('alarm');
    expect(c.opened).toHaveLength(1);
  });

  it('opens a tab only once when a page is applied twice after a crash (REL-2)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    await b.engine.sync('alarm');
    await a.module.send('dev_B', 'dev_A', TAB);
    await a.engine.sync('ui');
    b.store.failNextCommit = true; // dies after apply, before saving lastSeq
    await b.engine.sync('alarm');
    await b.engine.sync('ui');
    expect(b.opened).toHaveLength(1);
  });

  it('keeps a queued send through a network failure and publishes it once', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    await a.module.send('dev_B', 'dev_A', TAB);
    server.down = true;
    await a.engine.sync('ui');
    server.down = false;
    await a.engine.sync('retry');
    await a.engine.sync('ui');
    await a.engine.sync('ui');
    expect(server.collection('commands').size).toBe(1);
  });

  it('deletes a command that waited longer than 7 days without opening it', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    await a.module.send('dev_B', 'dev_A', TAB);
    await a.engine.sync('ui');
    b.clock.now += schema.COMMAND_TTL_MS + 60_000;
    await b.engine.sync('alarm');
    await b.engine.sync('local-change');
    expect(b.opened).toEqual([]);
    const [record] = [...server.collection('commands').values()];
    expect((await b.store.getMirror('commands', record?.id ?? ''))?.payload).toMatchObject({
      deleted: true,
    });
  });
});

describe('what can be sent', () => {
  it('sends web pages only, never from private windows', () => {
    expect(isSendableUrl('https://example.org/')).toBe(true);
    expect(isSendableUrl('http://localhost:3000/')).toBe(true);
    for (const url of [
      'chrome://settings',
      'about:config',
      'file:///x',
      'ftp://x.example',
      undefined,
    ]) {
      expect(isSendableUrl(url)).toBe(false);
    }
    expect(sendRefusal({ url: 'https://example.org/', incognito: true })).toBe('private');
    expect(sendRefusal({ url: 'about:blank' })).toBe('not-a-web-page');
    expect(sendRefusal({ url: 'https://example.org/' })).toBeUndefined();
  });

  it('turns context menu clicks into sends (UI-4)', () => {
    const tab = { url: 'https://page.example/', title: 'Page', incognito: false };
    expect(menuClickToSend({ menuItemId: 'tz-send-page:dev_B' }, tab)).toEqual({
      target: 'dev_B',
      url: 'https://page.example/',
      title: 'Page',
    });
    expect(
      menuClickToSend({ menuItemId: 'tz-send-link:dev_B', linkUrl: 'https://link.example/' }, tab),
    ).toEqual({ target: 'dev_B', url: 'https://link.example/' });
    expect(
      menuClickToSend({ menuItemId: 'tz-send-page:dev_B' }, { ...tab, incognito: true }),
    ).toEqual({
      refused: 'private',
    });
    expect(
      menuClickToSend({ menuItemId: 'tz-send-link:dev_B', linkUrl: 'javascript:alert(1)' }, tab),
    ).toEqual({ refused: 'not-a-web-page' });
    expect(menuClickToSend({ menuItemId: 'tz-send-page:none' }, tab)).toBeUndefined();
    expect(menuClickToSend({ menuItemId: 'something-else' }, tab)).toBeUndefined();
  });

  it('accepts only well-formed send messages', () => {
    expect(isSyncMessage({ type: 'send-tab', target: 'dev_B', url: 'https://x.example/' })).toBe(
      true,
    );
    expect(isSyncMessage({ type: 'send-tab', target: 'dev_B' })).toBe(false);
    expect(isSyncMessage({ type: 'send-tab', target: 1, url: 'https://x.example/' })).toBe(false);
  });

  it('ships every icon the manifest names', () => {
    for (const file of Object.values(ICONS)) {
      expect(existsSync(join(import.meta.dirname, '../../../public', file))).toBe(true);
    }
  });
});
