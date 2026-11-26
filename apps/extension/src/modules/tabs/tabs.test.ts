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
import {
  buildTabsData,
  syncableFavicon,
  withRecent,
  type BrowserTab,
  type BrowserWindow,
} from './snapshot.ts';
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

const NOW = Date.parse('2026-11-26T12:00:00Z');

describe('recently closed (TAB-10)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const open = (...urls: string[]): schema.TabsData => ({
    windows: [
      {
        focused: true,
        tabs: urls.map((url) => ({ url, title: url, pinned: false, active: false })),
      },
    ],
  });
  const all = () => true;

  it('moves closed tabs to the front, newest first, and drops reopened ones', () => {
    const before = { ...open('https://a.example/', 'https://b.example/'), recent: [] };
    const first = withRecent(open('https://a.example/'), before, NOW, all);
    expect(first.recent).toEqual([
      { url: 'https://b.example/', title: 'https://b.example/', closedAt: NOW },
    ]);
    const second = withRecent(open('https://b.example/'), first, NOW + 1, all);
    expect(second.recent?.map((r) => r.url)).toEqual(['https://a.example/']);
  });

  it('keeps each URL once, the newest', () => {
    const previous = {
      ...open('https://a.example/'),
      recent: [{ url: 'https://a.example/', title: 'old', closedAt: NOW - DAY }],
    };
    expect(withRecent(open(), previous, NOW, all).recent).toEqual([
      { url: 'https://a.example/', title: 'https://a.example/', closedAt: NOW },
    ]);
  });

  it('forgets entries after 7 days and keeps at most 50', () => {
    const recent = Array.from({ length: 60 }, (_, i) => ({
      url: `https://x.example/${String(i)}`,
      title: '',
      closedAt: NOW - i * 1000,
    }));
    const aged = {
      windows: [],
      recent: [...recent, { url: 'https://old/', title: '', closedAt: NOW - 8 * DAY }],
    };
    const result = withRecent(open(), aged, NOW, all);
    expect(result.recent).toHaveLength(schema.RECENT_TABS_MAX);
    expect(result.recent?.[0]?.url).toBe('https://x.example/0');
    expect(result.recent?.some((r) => r.url === 'https://old/')).toBe(false);
  });

  it('applies the same rules as open tabs, and marks private ones', () => {
    const previous: schema.TabsData = {
      windows: [
        {
          focused: false,
          private: true,
          tabs: [{ url: 'https://p.example/', title: 'P', pinned: false, active: false }],
        },
        ...open('https://bank.example/').windows,
      ],
    };
    const keepAll = withRecent(open(), previous, NOW, all);
    expect(keepAll.recent).toContainEqual({
      url: 'https://p.example/',
      title: 'P',
      closedAt: NOW,
      private: true,
    });
    const filtered = withRecent(open(), previous, NOW, (r) => !r.url.includes('bank'));
    expect(filtered.recent?.map((r) => r.url)).toEqual(['https://p.example/']);
  });

  it('adds nothing when nothing was open before', () => {
    expect(withRecent(open('https://a.example/'), undefined, NOW, all)).toEqual(
      open('https://a.example/'),
    );
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
    const module = new TabsModule(browser, () => NOW);
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

  it('keeps the tabs as recently closed when the last window closes (TAB-10)', async () => {
    const server = new FakeServer();
    const a = engine(server, 'dev_A');
    await a.engine.sync('local-change');
    windows = [];
    await a.engine.sync('local-change');
    const mirrored = (await a.store.getMirror('tabs', 'dev_A'))
      ?.payload as schema.Payload<schema.TabsData>;
    expect(mirrored.deleted ? undefined : mirrored.data).toEqual({
      windows: [],
      recent: [{ url: 'https://example.org/', title: 'https://example.org/', closedAt: NOW }],
    });
    // Reopened: back to open, gone from recently closed.
    windows = [win([tab('https://example.org/')], { focused: true })];
    await a.engine.sync('local-change');
    const again = (await a.store.getMirror('tabs', 'dev_A'))
      ?.payload as schema.Payload<schema.TabsData>;
    expect(again.deleted ? undefined : again.data.recent).toBeUndefined();
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
    const groups = otherDevicesTabs(records, devices, 'self', Date.parse('2026-11-25T10:05:00Z'));
    expect(groups.map((g) => [g.deviceId, g.name, g.tabCount, g.windows.length])).toEqual([
      ['new', 'Name new', 2, 1],
      ['old', 'Name old', 1, 1],
    ]);
  });

  it('still shows tabs when the device list is unavailable (offline)', () => {
    const groups = otherDevicesTabs([live('x', [['https://a.example/']])], undefined, 'self', 0);
    expect(groups).toMatchObject([
      { deviceId: 'x', name: undefined, lastSeenAt: undefined, live: undefined },
    ]);
  });

  it('marks devices not seen for over 10 minutes as not live (TAB-11)', () => {
    const now = Date.parse('2026-11-25T10:00:00Z');
    const groups = otherDevicesTabs(
      [live('on', [['https://a.example/']]), live('off', [['https://b.example/']])],
      [device('on', '2026-11-25T09:51:00Z'), device('off', '2026-11-25T09:49:00Z')],
      'self',
      now,
    );
    expect(groups.map((g) => [g.deviceId, g.live])).toEqual([
      ['on', true],
      ['off', false],
    ]);
  });

  it('shows a device with only recently closed tabs (TAB-10)', () => {
    const record = live('closed', [[]]);
    if (!record.payload.deleted) {
      record.payload.data.recent = [{ url: 'https://a.example/', title: 'A', closedAt: 1 }];
    }
    const groups = otherDevicesTabs([record], undefined, 'self', 0);
    expect(groups).toMatchObject([{ deviceId: 'closed', tabCount: 0, recent: [{ title: 'A' }] }]);
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
