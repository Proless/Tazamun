import { describe, expect, it } from 'vitest';
import { api, crypto as tzCrypto, hlc, schema } from '@tazamun/core';
import { SyncEngine, type EngineSession, type EngineStatus } from './engine.ts';
import type { AnyModule } from './module.ts';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  FULL_RECONCILE_AFTER_MS,
  backoffDelay,
  planBatches,
} from './policy.ts';
import { MemoryStore, type OutboxEntry } from './store.ts';
import { FakeServer, FakeTabsModule, tabsWith } from './testing.ts';

const ACCOUNT_ID = tzCrypto.randomId();
const ACCOUNT_KEY = tzCrypto.generateAccountKey();
const SERVER_URL = 'https://sync.example.org';

interface Device {
  engine: SyncEngine;
  store: MemoryStore;
  module: FakeTabsModule;
  statuses: EngineStatus[];
  clock: { now: number };
  switches: { paused: boolean; modules: Record<string, boolean> };
  signedOut: { called: boolean };
  session: EngineSession | 'signed-out' | 'locked';
  setVersion(version: string): void;
}

function device(server: FakeServer, deviceId: string, extra: AnyModule[] = []): Device {
  const store = new MemoryStore();
  const module = new FakeTabsModule();
  const statuses: EngineStatus[] = [];
  const clock = { now: Date.parse('2026-11-25T10:00:00Z') };
  const switches = { paused: false, modules: {} as Record<string, boolean> };
  const signedOut = { called: false };
  let version = '0.1.0';
  const d: Device = {
    store,
    module,
    statuses,
    clock,
    switches,
    signedOut,
    session: {
      serverUrl: SERVER_URL,
      accountId: ACCOUNT_ID,
      deviceId,
      token: 'tok',
      accountKey: ACCOUNT_KEY,
    },
    setVersion(v) {
      version = v;
      d.engine = build();
    },
    engine: undefined as unknown as SyncEngine,
  };
  const build = () =>
    new SyncEngine({
      store,
      modules: [module, ...extra],
      session: () => Promise.resolve(d.session),
      switches: () => Promise.resolve(switches),
      client: (baseUrl, token) => new api.ApiClient({ baseUrl, token, fetch: server.fetch }),
      onUnauthorized: () => {
        signedOut.called = true;
        return Promise.resolve();
      },
      publishStatus: (s) => {
        statuses.push(s);
        return Promise.resolve();
      },
      clientVersion: version,
      now: () => clock.now,
      random: () => 0.5,
    });
  d.engine = build();
  return d;
}

/** What device B sees of device A's tabs. */
async function mirrored(d: Device, id: string): Promise<unknown> {
  return (await d.store.getMirror('tabs', id))?.payload;
}

describe('SyncEngine', () => {
  it('pushes a local change and another device pulls, decrypts and applies it (SRS 3.2)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    a.module.browser = tabsWith('https://example.org/');

    expect((await a.engine.sync('local-change')).state).toBe('idle');
    expect(a.store.outbox.size).toBe(0);
    expect(server.collection('tabs').has('dev_A')).toBe(true);
    // The server holds ciphertext only.
    expect(server.collection('tabs').get('dev_A')?.payload).not.toContain('example.org');

    await b.engine.sync('alarm');
    expect(b.module.applied.map((r) => r.id)).toEqual(['dev_A']);
    expect(await mirrored(b, 'dev_A')).toMatchObject({
      deleted: false,
      data: tabsWith('https://example.org/'),
    });
  });

  it('pulls everything and pushes back what a restored server lost (ENG-16)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    a.module.browser = tabsWith('https://old.example/');
    await a.engine.sync('local-change');
    // The operator takes a backup here.
    const backup = new Map([...server.records].map(([name, rs]) => [name, new Map(rs)]));
    a.module.browser = tabsWith('https://new.example/');
    a.clock.now += 1000;
    await a.engine.sync('local-change');
    b.module.browser = tabsWith('https://b.example/');
    await b.engine.sync('local-change');
    await a.engine.sync('alarm');

    // Restore: older records, B's record gone, seq kept (Database.restore), new generation.
    server.records.clear();
    for (const [name, rs] of backup) server.records.set(name, rs);
    server.generation = 'gen-2';

    // Without the new generation nothing would be pulled: seq didn't go back.
    expect((await a.engine.sync('alarm')).state).toBe('idle');
    expect(server.collection('tabs').has('dev_B')).toBe(true);
    const c = device(server, 'dev_C');
    await c.engine.sync('alarm');
    expect(await mirrored(c, 'dev_A')).toMatchObject({ data: tabsWith('https://new.example/') });
    expect(await mirrored(c, 'dev_B')).toMatchObject({ data: tabsWith('https://b.example/') });
    // Nothing was deleted on A, and the new generation is remembered: the next run is quiet.
    expect(await mirrored(a, 'dev_B')).toMatchObject({ deleted: false });
    // (One more run picks up the records it just pushed; after that, an alarm costs one request.)
    await a.engine.sync('alarm');
    server.requests.length = 0;
    await a.engine.sync('alarm');
    expect(server.requests).toEqual(['GET /v1/info']);
  });

  it('warns when this clock is more than 5 minutes off the server (ENG-15)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    server.time = () => a.clock.now;
    expect((await a.engine.sync('alarm')).clockSkewMinutes).toBeUndefined();
    server.time = () => a.clock.now - 12 * 60_000;
    expect(await a.engine.sync('alarm')).toMatchObject({ state: 'idle', clockSkewMinutes: 12 });
    server.time = () => a.clock.now + 7 * 60_000;
    expect((await a.engine.sync('alarm')).clockSkewMinutes).toBe(-7);
    server.time = () => a.clock.now + 4 * 60_000;
    expect((await a.engine.sync('alarm')).clockSkewMinutes).toBeUndefined();
    // An older server that sends no time: nothing to compare.
    server.time = undefined;
    expect((await a.engine.sync('alarm')).clockSkewMinutes).toBeUndefined();
  });

  it('costs one GET /v1/info per alarm when nothing changed (PERF-5)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://example.org/');
    await a.engine.sync('alarm');
    server.requests.length = 0;
    await a.engine.sync('alarm');
    expect(server.requests).toEqual(['GET /v1/info']);
  });

  it('stamps local edits with a monotonic HLC (ENG-7)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://one.example/');
    await a.engine.sync('alarm');
    const first = (await mirrored(a, 'dev_A')) as schema.Payload<unknown>;
    a.clock.now -= 60_000; // the wall clock jumps back
    a.module.browser = tabsWith('https://two.example/');
    await a.engine.sync('alarm');
    const second = (await mirrored(a, 'dev_A')) as schema.Payload<unknown>;
    expect(hlc.compare(hlc.parse(second.hlc), hlc.parse(first.hlc))).toBeGreaterThan(0);
    expect(hlc.parse(second.hlc).deviceId).toBe('dev_A');
  });

  it('keeps the outbox through a network failure and backs off (ENG-3, ENG-9)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://example.org/');
    server.down = true;

    const offline = await a.engine.sync('local-change');
    expect(offline).toMatchObject({ state: 'offline', pending: 1 });
    expect(offline.retryAt).toBeGreaterThan(a.clock.now);
    expect(a.store.outbox.size).toBe(1);

    // An automatic trigger inside the backoff window doesn't touch the network.
    server.down = false;
    server.requests.length = 0;
    expect((await a.engine.sync('alarm')).state).toBe('offline');
    expect(server.requests).toEqual([]);

    // The retry (or the UI) goes through and the outbox drains.
    expect(await a.engine.sync('retry')).toMatchObject({ state: 'idle', pending: 0 });
    expect(server.collection('tabs').size).toBe(1);
    expect(a.store.meta.retry).toBeUndefined();
  });

  it('reports server errors with their code and retries them (ENG-9, ENG-13)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://example.org/');
    server.failPushes = 1;
    expect(await a.engine.sync('alarm')).toMatchObject({ state: 'error', reason: 'UNAVAILABLE' });
    expect(a.store.outbox.size).toBe(1);
    expect(await a.engine.sync('ui')).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('treats 401 as signed out, not as a retry (ENG-9, ACC-8)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    server.revoked = true;
    expect((await a.engine.sync('alarm')).state).toBe('signed-out');
    expect(a.signedOut.called).toBe(true);
    expect(a.store.meta.retry).toBeUndefined();
  });

  it('does nothing while signed out, locked or paused (ENG-12)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://example.org/');
    a.session = 'locked';
    expect((await a.engine.sync('alarm')).state).toBe('locked');
    a.session = 'signed-out';
    expect((await a.engine.sync('alarm')).state).toBe('signed-out');
    a.session = {
      serverUrl: SERVER_URL,
      accountId: ACCOUNT_ID,
      deviceId: 'dev_A',
      token: 't',
      accountKey: ACCOUNT_KEY,
    };
    a.switches.paused = true;
    expect((await a.engine.sync('ui')).state).toBe('paused');
    expect(server.requests).toEqual([]);
    expect(a.module.detectCalls).toBe(0);
  });

  it('skips a module that is off on this device (ENG-12)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    a.module.browser = tabsWith('https://example.org/');
    await a.engine.sync('alarm');
    b.switches.modules = { tabs: false };
    server.requests.length = 0;
    await b.engine.sync('alarm');
    expect(b.module.detectCalls).toBe(0);
    expect(b.module.applied).toEqual([]);
    expect(server.requests).toEqual(['GET /v1/info']);
  });

  it('pages through large pulls and saves lastSeq per page (ENG-6)', async () => {
    const server = new FakeServer();
    server.maxPullRecords = 2;
    const writers = [1, 2, 3, 4, 5].map((n) => device(server, `dev_${String(n)}`));
    for (const w of writers) {
      w.module.browser = tabsWith('https://x.example/');
      await w.engine.sync('alarm');
    }
    const reader = device(server, 'dev_R');
    await reader.engine.sync('alarm');
    expect(reader.module.applied.map((r) => r.id).sort()).toEqual([
      'dev_1',
      'dev_2',
      'dev_3',
      'dev_4',
      'dev_5',
    ]);
    expect(reader.store.meta.collections['tabs']?.lastSeq).toBe(server.seq);
    expect(
      server.requests.filter((r) => r === 'GET /v1/collections/tabs').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('resumes after the worker dies mid-pull without losing or doubling anything (ENG-11)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    await b.engine.sync('alarm');
    a.module.browser = tabsWith('https://example.org/');
    await a.engine.sync('alarm');

    // B applies the page, then dies before committing mirror and lastSeq.
    b.store.failNextCommit = true;
    expect((await b.engine.sync('alarm')).state).toBe('error');
    expect(b.store.meta.collections['tabs']?.lastSeq ?? 0).toBe(0);

    // The next run pulls the same page again; applying it twice is harmless (REL-2).
    expect((await b.engine.sync('ui')).state).toBe('idle');
    expect(await mirrored(b, 'dev_A')).toMatchObject({ data: tabsWith('https://example.org/') });
    expect(b.store.meta.collections['tabs']?.lastSeq).toBe(server.seq);
    // Nothing of B's own went to the server.
    expect([...server.collection('tabs').keys()]).toEqual(['dev_A']);
  });

  it('keeps a change queued while a push of the same record was in flight', async () => {
    const store = new MemoryStore();
    const entry = (rev: string): OutboxEntry => ({
      collection: 'tabs',
      id: 'r',
      payload: 'p',
      rev,
      queuedAt: 1,
    });
    await store.commit({ outboxPut: [entry('one')] });
    await store.commit({ outboxPut: [entry('two')] }); // re-queued during the push
    await store.commit({ outboxConfirm: [{ collection: 'tabs', id: 'r', rev: 'one' }] });
    expect([...store.outbox.values()].map((e) => e.rev)).toEqual(['two']);
  });

  it('pushes the merge result back when the server copy is behind (ENG-8)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://new.example/');
    await a.engine.sync('alarm');
    const current = server.collection('tabs').get('dev_A');

    // Another device re-pushes an older copy of A's record (a race, or a stale client).
    const key = await (await tzCrypto.deriveAccountKeys(ACCOUNT_KEY)).collectionKey('tabs');
    const stale = await tzCrypto.encryptPayload(
      key,
      { accountId: ACCOUNT_ID, collection: 'tabs', recordId: 'dev_A' },
      schema.livePayload(
        schema.COLLECTIONS.tabs,
        hlc.serialize({ wallTime: 1, counter: 0, deviceId: 'dev_A' }),
        tabsWith('https://old.example/'),
      ),
    );
    server.seq++;
    if (current === undefined) throw new Error('A did not push');
    server.collection('tabs').set('dev_A', { ...current, seq: server.seq, payload: stale });

    await a.engine.sync('alarm');
    // A kept its newer copy, applied nothing, and overwrote the stale one on the server.
    expect(await mirrored(a, 'dev_A')).toMatchObject({ data: tabsWith('https://new.example/') });
    expect(server.collection('tabs').get('dev_A')?.payload).not.toBe(stale);
    const b = device(server, 'dev_B');
    await b.engine.sync('alarm');
    expect(await mirrored(b, 'dev_A')).toMatchObject({ data: tabsWith('https://new.example/') });
  });

  it('skips records that were moved or tampered with (ENG-2)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://example.org/');
    await a.engine.sync('alarm');
    // A malicious server copies A's record under another ID.
    const original = server.collection('tabs').get('dev_A');
    if (original === undefined) throw new Error('A did not push');
    server.seq++;
    server.collection('tabs').set('dev_X', { ...original, id: 'dev_X', seq: server.seq });

    const b = device(server, 'dev_B');
    expect((await b.engine.sync('alarm')).state).toBe('idle');
    expect(b.module.applied.map((r) => r.id)).toEqual(['dev_A']);
    expect(await mirrored(b, 'dev_X')).toBeUndefined();
  });

  it('holds records from a newer schema version until the extension is updated (ENG-10)', async () => {
    const server = new FakeServer();
    const key = await (await tzCrypto.deriveAccountKeys(ACCOUNT_KEY)).collectionKey('tabs');
    const newer = {
      v: 2,
      deleted: false,
      hlc: hlc.serialize({ wallTime: 1_795_000_000_000, counter: 0, deviceId: 'dev_N' }),
      data: { windows: [], somethingNew: true },
    };
    server.seq++;
    server.collection('tabs').set('dev_N', {
      id: 'dev_N',
      seq: server.seq,
      modifiedAt: '2026-11-25T10:00:00Z',
      payload: await tzCrypto.encryptPayload(
        key,
        { accountId: ACCOUNT_ID, collection: 'tabs', recordId: 'dev_N' },
        newer,
      ),
    });

    const b = device(server, 'dev_B');
    expect(await b.engine.sync('alarm')).toMatchObject({ state: 'idle', updateRequired: true });
    expect(b.module.applied).toEqual([]);
    expect((await b.store.getMirror('tabs', 'dev_N'))?.held?.version).toBe(2);
    // Still flagged on the next run, which pulls nothing new.
    expect((await b.engine.sync('alarm')).updateRequired).toBe(true);
    // Never pushed over.
    expect(server.collection('tabs').get('dev_N')?.seq).toBe(1);
  });

  it('stops syncing when the server needs a newer client (SRS 4.4.1)', async () => {
    const server = new FakeServer();
    server.minClientVersion = '9.0.0';
    const a = device(server, 'dev_A');
    expect(await a.engine.sync('alarm')).toMatchObject({
      state: 'error',
      reason: 'UPDATE_REQUIRED',
      updateRequired: true,
    });
    expect(server.requests).toEqual(['GET /v1/info']);
  });

  it('reconciles fully after a long absence and drops records the server no longer has', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    const b = device(server, 'dev_B');
    a.module.browser = tabsWith('https://example.org/');
    await a.engine.sync('alarm');
    await b.engine.sync('alarm');
    expect(await mirrored(b, 'dev_A')).toBeDefined();

    // B is away for months; A's record (a tombstone, say) expired on the server meanwhile.
    server.collection('tabs').delete('dev_A');
    const c = device(server, 'dev_C');
    c.module.browser = tabsWith('https://c.example/');
    await c.engine.sync('alarm');
    b.clock.now += FULL_RECONCILE_AFTER_MS + 1;
    await b.engine.sync('alarm');
    expect(await mirrored(b, 'dev_A')).toBeUndefined();
    expect(b.module.applied.at(-1)).toMatchObject({ id: 'dev_A', payload: { deleted: true } });
    expect(await mirrored(b, 'dev_C')).toBeDefined();
  });

  it('starts from scratch when this browser signs in to another account', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://example.org/');
    server.down = true;
    await a.engine.sync('alarm');
    expect(a.store.outbox.size).toBe(1);

    a.session = {
      serverUrl: SERVER_URL,
      accountId: tzCrypto.randomId(),
      deviceId: 'dev_A',
      token: 't',
      accountKey: tzCrypto.generateAccountKey(),
    };
    a.module.browser = undefined;
    server.down = false;
    await a.engine.sync('ui');
    // The old account's queued record was dropped, not pushed into the new account.
    expect(server.collection('tabs').size).toBe(0);
    expect(a.store.outbox.size).toBe(0);
  });

  it('runs one sync at a time and coalesces triggers', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://example.org/');
    const runs = [a.engine.sync('alarm'), a.engine.sync('local-change'), a.engine.sync('ui')];
    await Promise.all(runs);
    // One run plus one coalesced re-run, not three.
    expect(a.module.detectCalls).toBe(2);
  });

  it('never puts content or IDs in the status (ENG-14)', async () => {
    const server = new FakeServer();
    const a = device(server, 'dev_A');
    a.module.browser = tabsWith('https://secret.example/');
    await a.engine.sync('alarm');
    server.down = true;
    await a.engine.sync('ui');
    const text = JSON.stringify(a.statuses);
    expect(text).not.toContain('secret.example');
    expect(text).not.toContain('dev_A');
    expect(text).not.toContain(ACCOUNT_ID);
  });
});

describe('policy', () => {
  it('backs off exponentially with jitter between 1 s and 15 min (ENG-9)', () => {
    expect(backoffDelay(1, 0)).toBe(BACKOFF_MIN_MS);
    expect(backoffDelay(3, 0.999)).toBeLessThanOrEqual(4_000);
    expect(backoffDelay(30, 0.999)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    expect(backoffDelay(30, 0.999)).toBeGreaterThan(BACKOFF_MAX_MS - 1_000);
    expect(backoffDelay(1, 0, 120)).toBe(120_000);
  });

  it('batches by collection, 500 records and about 1 MB (ENG-4)', () => {
    const e = (collection: string, i: number, size = 10): OutboxEntry => ({
      collection,
      id: `r${String(i)}`,
      payload: 'x'.repeat(size),
      rev: 'r',
      queuedAt: i,
    });
    const many = Array.from({ length: 1_201 }, (_, i) => e('history', i));
    expect(planBatches(many).map((b) => b.length)).toEqual([500, 500, 201]);
    const big = Array.from({ length: 5 }, (_, i) => e('tabs', i, 400_000));
    expect(planBatches(big).map((b) => b.length)).toEqual([2, 2, 1]);
    const mixed = planBatches([e('tabs', 1), e('history', 2), e('tabs', 3)]);
    expect(mixed.map((b) => b.map((x) => x.collection))).toEqual([['tabs', 'tabs'], ['history']]);
  });
});
