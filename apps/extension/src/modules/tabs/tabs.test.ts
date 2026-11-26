import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { api, crypto as tzCrypto, schema } from '@tazamun/core';
import { getSettings, saveSettings } from '../../account/store.ts';
import { SyncEngine } from '../../engine/engine.ts';
import { MemoryStore } from '../../engine/store.ts';
import { FakeServer } from '../../engine/testing.ts';
import { isSyncableUrl, parseExclusion, parseExclusions } from '../../lib/exclusions.ts';
import { TabsModule } from './module.ts';
import { buildTabsData, syncableFavicon, type BrowserTab, type BrowserWindow } from './snapshot.ts';
import { displayHost, formatLastSeen, otherDevicesTabs } from './view.ts';

function tab(url: string, extra: Partial<BrowserTab> = {}): BrowserTab {
  return { url, title: url, pinned: false, active: false, incognito: false, index: -1, ...extra };
}

function win(tabs: BrowserTab[], extra: Partial<BrowserWindow> = {}): BrowserWindow {
  return {
    incognito: false,
    focused: false,
    type: 'normal',
    tabs: tabs.map((t, i) => ({ ...t, index: t.index >= 0 ? t.index : i })),
    ...extra,
  };
}

describe('exclusions (TAB-3, PRIV-3)', () => {
  it.each([
    'chrome://settings',
    'edge://favorites',
    'about:config',
    'moz-extension://abc/page.html',
    'chrome-extension://abc/popup.html',
    'file:///home/me/secret.pdf',
    'data:text/html,hi',
    'blob:https://example.org/1234',
    'javascript:alert(1)',
    'view-source:https://example.org',
    'not a url',
  ])('never syncs %s', (url) => {
    expect(isSyncableUrl(url, [])).toBe(false);
  });

  it('syncs ordinary web pages', () => {
    expect(isSyncableUrl('https://example.org/a?b=c#d', [])).toBe(true);
    expect(isSyncableUrl('http://localhost:3000/', [])).toBe(true);
  });

  it('matches hosts, subdomains, www and path prefixes', () => {
    const ex = parseExclusions(['Bank.example', '*.health.example', 'notes.example/private', '']);
    expect(ex).toHaveLength(3);
    expect(isSyncableUrl('https://bank.example/', ex)).toBe(false);
    expect(isSyncableUrl('https://www.bank.example/login', ex)).toBe(false);
    expect(isSyncableUrl('https://online.bank.example:8443/', ex)).toBe(false);
    expect(isSyncableUrl('https://notbank.example/', ex)).toBe(true);
    expect(isSyncableUrl('https://clinic.health.example/', ex)).toBe(false);
    expect(isSyncableUrl('https://notes.example/private/x', ex)).toBe(false);
    expect(isSyncableUrl('https://notes.example/public', ex)).toBe(true);
  });

  it('accepts patterns pasted as URLs, rejects unusable ones', () => {
    expect(parseExclusion('https://www.example.org/')).toEqual({
      host: 'example.org',
      pathPrefix: '',
    });
    expect(parseExclusion('ex*ample.org')).toBeUndefined();
    expect(parseExclusion('   ')).toBeUndefined();
  });
});

const OFF = { exclusions: [], includePrivate: false };

describe('buildTabsData (TAB-1…4)', () => {
  it('publishes windows and tabs in tab order', () => {
    const data = buildTabsData(
      [
        win(
          [
            tab('https://b.example/', { index: 1, active: true, lastAccessed: 1795000000000.7 }),
            tab('https://a.example/', { index: 0, pinned: true, title: 'A' }),
          ],
          { focused: true },
        ),
      ],
      OFF,
    );
    expect(data).toEqual({
      windows: [
        {
          focused: true,
          tabs: [
            { url: 'https://a.example/', title: 'A', pinned: true, active: false },
            {
              url: 'https://b.example/',
              title: 'https://b.example/',
              pinned: false,
              active: true,
              lastAccessed: 1795000000000,
            },
          ],
        },
      ],
    });
    expect(schema.COLLECTIONS.tabs.data.safeParse(data).success).toBe(true);
  });

  it('leaves private windows and tabs out by default, not even as empty windows (TAB-2)', () => {
    const data = buildTabsData(
      [
        win([tab('https://secret.example/')], { incognito: true }),
        win([tab('https://also-secret.example/', { incognito: true }), tab('https://ok.example/')]),
      ],
      OFF,
    );
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(data.windows).toHaveLength(1);
  });

  it('includes private windows, marked as such, when the user turned that on (TAB-2)', () => {
    const data = buildTabsData(
      [
        win([tab('https://private.example/', { incognito: true })], { incognito: true }),
        win([tab('https://bank.example/', { incognito: true })], { incognito: true }),
        win([tab('https://ok.example/')]),
      ],
      { exclusions: parseExclusions(['bank.example']), includePrivate: true },
    );
    // Exclusions and schemes still apply (TAB-3, PRIV-3).
    expect(data.windows).toEqual([
      expect.objectContaining({
        private: true,
        tabs: [expect.objectContaining({ url: 'https://private.example/' })],
      }),
      expect.not.objectContaining({ private: true }),
    ]);
    expect(schema.COLLECTIONS.tabs.data.safeParse(data).success).toBe(true);
  });

  it('drops privileged, local and excluded URLs, and windows left empty (TAB-3)', () => {
    const data = buildTabsData(
      [
        win([tab('chrome://newtab/'), tab('about:blank')]),
        win([tab('file:///etc/passwd'), tab('https://bank.example/'), tab('https://ok.example/')]),
        win([tab('https://ok.example/')], { type: 'popup' }),
      ],
      { exclusions: parseExclusions(['bank.example']), includePrivate: false },
    );
    expect(data.windows.map((w) => w.tabs.map((t) => t.url))).toEqual([['https://ok.example/']]);
  });

  it('keeps only short https favicons (TAB-4)', () => {
    expect(syncableFavicon('https://example.org/favicon.ico')).toBe(
      'https://example.org/favicon.ico',
    );
    expect(syncableFavicon('data:image/png;base64,AAAA')).toBeUndefined();
    expect(syncableFavicon('chrome://favicon/x')).toBeUndefined();
    expect(syncableFavicon(`https://example.org/${'a'.repeat(600)}`)).toBeUndefined();
    const data = buildTabsData(
      [win([tab('https://a.example/', { favIconUrl: 'data:image/png;base64,AAAA' })])],
      OFF,
    );
    expect(data.windows[0]?.tabs[0]).not.toHaveProperty('favIconUrl');
  });
});

describe('TabsModule with the engine', () => {
  const accountId = tzCrypto.randomId();
  const accountKey = tzCrypto.generateAccountKey();

  let windows: BrowserWindow[];
  beforeEach(() => {
    fakeBrowser.reset();
    windows = [win([tab('https://example.org/')], { focused: true })];
    // The fake browser's windows API doesn't populate tabs; serve the test's windows instead.
    fakeBrowser.windows.getAll = () => Promise.resolve(windows as never);
  });

  function engine(server: FakeServer, deviceId: string, store = new MemoryStore()) {
    const module = new TabsModule(browser);
    return {
      store,
      module,
      engine: new SyncEngine({
        store,
        modules: [module],
        session: () =>
          Promise.resolve({
            serverUrl: 'https://s.example',
            accountId,
            deviceId,
            token: 't',
            accountKey,
          }),
        switches: () => Promise.resolve({ paused: false, modules: {} }),
        client: (baseUrl, token) => new api.ApiClient({ baseUrl, token, fetch: server.fetch }),
        onUnauthorized: () => Promise.resolve(),
        publishStatus: () => Promise.resolve(),
        clientVersion: '0.1.0',
        now: () => Date.now(),
        random: () => 0.5,
      }),
    };
  }

  it('publishes once, then only when something relevant changed (TAB-5)', async () => {
    const server = new FakeServer();
    const a = engine(server, 'dev_A');
    await a.engine.sync('local-change');
    expect(server.seq).toBe(1);
    await a.engine.sync('local-change');
    expect(server.seq).toBe(1);
    windows = [win([tab('https://example.org/'), tab('https://new.example/')], { focused: true })];
    await a.engine.sync('local-change');
    expect(server.seq).toBe(2);
  });

  it('re-reads exclusions on every run', async () => {
    const server = new FakeServer();
    const a = engine(server, 'dev_A');
    await a.engine.sync('local-change');
    await saveSettings(browser, { ...(await getSettings(browser)), exclusions: ['example.org'] });
    await a.engine.sync('local-change');
    const mirrored = (await a.store.getMirror('tabs', 'dev_A'))
      ?.payload as schema.Payload<schema.TabsData>;
    expect(mirrored.deleted).toBe(false);
    expect(mirrored.deleted ? [] : mirrored.data.windows).toEqual([]);
  });

  it('shows the tabs on another device and never writes them to its browser', async () => {
    const server = new FakeServer();
    const a = engine(server, 'dev_A');
    await a.engine.sync('local-change');
    const created: unknown[] = [];
    fakeBrowser.tabs.create = (props) => {
      created.push(props);
      return Promise.resolve({} as never);
    };
    const b = engine(server, 'dev_B');
    await b.engine.sync('alarm');
    expect(await b.store.getMirror('tabs', 'dev_A')).toBeDefined();
    expect(created).toEqual([]);
  });
});

describe('Tabs on other browsers (TAB-6)', () => {
  const live = (
    id: string,
    urls: string[][],
  ): { id: string; payload: schema.Payload<schema.TabsData> } => ({
    id,
    payload: {
      v: 1,
      deleted: false,
      hlc: '001795000000000:00000000:x',
      data: {
        windows: urls.map((u) => ({
          focused: false,
          tabs: u.map((url) => ({ url, title: url, pinned: false, active: false })),
        })),
      },
    },
  });
  const device = (id: string, lastSeenAt: string): schema.Device => ({
    id,
    name: `Name ${id}`,
    browser: { family: 'firefox', version: '140' },
    createdAt: '2026-11-01T00:00:00Z',
    lastSeenAt,
    current: false,
  });

  it('lists other devices by last seen, without this one, revoked ones or empty ones', () => {
    const records = [
      live('self', [['https://me.example/']]),
      live('old', [['https://a.example/']]),
      live('new', [['https://b.example/', 'https://c.example/'], []]),
      live('revoked', [['https://d.example/']]),
      live('empty', [[]]),
      { id: 'gone', payload: { v: 1, deleted: true as const, hlc: '001795000000000:00000000:x' } },
    ];
    const devices = [
      device('old', '2026-11-20T10:00:00Z'),
      device('new', '2026-11-25T10:00:00Z'),
      device('empty', '2026-11-25T10:00:00Z'),
      device('self', '2026-11-25T10:00:00Z'),
    ];
    const groups = otherDevicesTabs(records, devices, 'self');
    expect(groups.map((g) => [g.deviceId, g.name, g.tabCount, g.windows.length])).toEqual([
      ['new', 'Name new', 2, 1],
      ['old', 'Name old', 1, 1],
    ]);
  });

  it('still shows tabs when the device list is unavailable (offline)', () => {
    const groups = otherDevicesTabs([live('x', [['https://a.example/']])], undefined, 'self');
    expect(groups).toMatchObject([{ deviceId: 'x', name: undefined, lastSeenAt: undefined }]);
  });

  it('formats last seen and hosts', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    expect(formatLastSeen(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago');
    expect(formatLastSeen(now - 26 * 3_600_000, now, 'en')).toBe('yesterday');
    expect(formatLastSeen(now - 10_000, now, 'en')).toBe('this minute');
    expect(displayHost('https://www.example.org:8443/x')).toBe('www.example.org:8443');
    expect(displayHost('weird')).toBe('weird');
  });
});
