import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { crypto as tzCrypto } from '@tazamun/core';
import { saveSignedIn } from '../account/store.ts';
import { MemoryStore } from '../engine/store.ts';
import { STATUS_KEY, badgeFor, parseStatus, statusMessageKey } from '../engine/status.ts';
import { FakeServer, FakeTabsModule, tabsWith } from '../engine/testing.ts';
import { BackgroundSync, POLL_ALARM, RETRY_ALARM, isSyncMessage } from './sync.ts';

let server: FakeServer;

beforeEach(async () => {
  fakeBrowser.reset();
  fakeBrowser.runtime.getManifest = () => ({
    manifest_version: 3,
    name: 'Tazamun',
    version: '0.1.0',
  });
  server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
  await saveSignedIn(
    browser,
    {
      serverUrl: 'https://sync.example.org',
      accountId: tzCrypto.randomId(),
      username: 'hasan',
      deviceId: 'dev_A',
      deviceName: 'Test',
      token: tzCrypto.toBase64Url(tzCrypto.randomBytes(32)),
      accountKey: tzCrypto.generateAccountKey(),
    },
    true,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function storedStatus() {
  return parseStatus((await fakeBrowser.storage.local.get(STATUS_KEY))[STATUS_KEY]);
}

describe('BackgroundSync', () => {
  it('creates the poll alarm once and keeps its schedule (ENG-5)', async () => {
    const sync = new BackgroundSync(browser, { store: Promise.resolve(new MemoryStore()) });
    await sync.ensureAlarm();
    const first = await fakeBrowser.alarms.get(POLL_ALARM);
    expect(first?.periodInMinutes).toBe(1);
    await sync.ensureAlarm();
    expect((await fakeBrowser.alarms.get(POLL_ALARM))?.scheduledTime).toBe(first?.scheduledTime);
  });

  it('syncs on the alarm and publishes the status for the UI (ENG-13)', async () => {
    const module = new FakeTabsModule(tabsWith('https://example.org/'));
    const sync = new BackgroundSync(browser, {
      store: Promise.resolve(new MemoryStore()),
      modules: [module],
    });
    await sync.onAlarm(POLL_ALARM);
    expect(server.collection('tabs').size).toBe(1);
    expect(await storedStatus()).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('schedules a retry alarm when offline, and clears it after success (ENG-9)', async () => {
    const module = new FakeTabsModule(tabsWith('https://example.org/'));
    const sync = new BackgroundSync(browser, {
      store: Promise.resolve(new MemoryStore()),
      modules: [module],
    });
    server.down = true;
    expect((await sync.sync('alarm')).state).toBe('offline');
    expect(await fakeBrowser.alarms.get(RETRY_ALARM)).toBeDefined();
    server.down = false;
    await sync.onAlarm(RETRY_ALARM);
    expect(await fakeBrowser.alarms.get(RETRY_ALARM)).toBeUndefined();
    expect(server.collection('tabs').size).toBe(1);
  });

  it('debounces local changes into one push after 2 s (ENG-4)', async () => {
    vi.useFakeTimers();
    const module = new FakeTabsModule(tabsWith('https://example.org/'));
    const sync = new BackgroundSync(browser, {
      store: Promise.resolve(new MemoryStore()),
      modules: [module],
    });
    sync.localChange();
    await vi.advanceTimersByTimeAsync(1_500);
    sync.localChange();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(module.detectCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(server.collection('tabs').size).toBe(1);
    });
    expect(module.detectCalls).toBe(1);
  });

  it('syncs when the account or settings change, not on its own status writes', async () => {
    const module = new FakeTabsModule();
    const sync = new BackgroundSync(browser, {
      store: Promise.resolve(new MemoryStore()),
      modules: [module],
    });
    await sync.onStorageChanged([STATUS_KEY]);
    expect(module.detectCalls).toBe(0);
    await sync.onStorageChanged(['settings']);
    expect(module.detectCalls).toBe(1);
  });

  it('accepts only its own message shapes', () => {
    expect(isSyncMessage({ type: 'sync-now' })).toBe(true);
    expect(isSyncMessage({ type: 'local-change' })).toBe(true);
    expect(isSyncMessage({ type: 'delete-everything' })).toBe(false);
    expect(isSyncMessage('sync-now')).toBe(false);
  });
});

describe('status display (ENG-13, UI-6)', () => {
  const base = { lastSync: {}, pending: 0, updatedAt: 1 };

  it('shows a badge only for states that need attention, never a count', () => {
    expect(badgeFor({ ...base, state: 'idle', pending: 12 }).text).toBe('');
    expect(badgeFor({ ...base, state: 'offline' }).text).toBe('');
    expect(badgeFor({ ...base, state: 'paused' }).text).toBe('II');
    expect(badgeFor({ ...base, state: 'error', reason: 'INTERNAL' }).text).toBe('!');
    expect(badgeFor({ ...base, state: 'idle', updateRequired: true }).text).toBe('!');
  });

  it('picks the status line', () => {
    expect(statusMessageKey({ ...base, state: 'idle' })).toBe('statusIdleNever');
    expect(statusMessageKey({ ...base, state: 'idle', lastSuccessAt: 5 })).toBe('statusIdle');
    expect(statusMessageKey({ ...base, state: 'error', reason: 'QUOTA_EXCEEDED' })).toBe(
      'statusQuota',
    );
    expect(statusMessageKey({ ...base, state: 'idle', updateRequired: true })).toBe(
      'statusUpdateRequired',
    );
  });

  it('reads a corrupt stored status as missing', () => {
    expect(parseStatus({ state: 'exploded' })).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });
});
