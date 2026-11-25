import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openEngineStore } from './idb-store.ts';
import { MemoryStore, type EngineStore, type OutboxEntry } from './store.ts';

const entry = (id: string, rev: string, queuedAt: number): OutboxEntry => ({
  collection: 'tabs',
  id,
  payload: `p-${id}`,
  rev,
  queuedAt,
});

/** The same contract for both stores, so tests on MemoryStore say something about IndexedDB. */
describe.each([
  ['IndexedDB', () => openEngineStore({ indexedDB: new IDBFactory(), IDBKeyRange })],
  ['memory', () => Promise.resolve(new MemoryStore())],
] as [string, () => Promise<EngineStore>][])('%s store', (_name, open) => {
  it('commits mirror, outbox and metadata together', async () => {
    const store = await open();
    await store.commit({
      mirrorPut: [
        { collection: 'tabs', id: 'a', payload: { v: 1 } },
        { collection: 'tabs', id: 'b', payload: { v: 1 } },
        { collection: 'history', id: 'a', payload: { v: 1 } },
      ],
      outboxPut: [entry('b', 'r1', 2), entry('a', 'r1', 1)],
      meta: { clock: 'c1', collections: { tabs: { lastSeq: 5 } } },
    });
    expect((await store.listMirror('tabs')).map((e) => e.id)).toEqual(['a', 'b']);
    expect(await store.getMirror('history', 'a')).toMatchObject({ payload: { v: 1 } });
    expect((await store.listOutbox()).map((e) => e.id)).toEqual(['a', 'b']);
    expect(await store.getMeta()).toMatchObject({
      clock: 'c1',
      collections: { tabs: { lastSeq: 5 } },
    });
  });

  it('merges collection metadata per field and clears retry with null', async () => {
    const store = await open();
    await store.commit({
      meta: { collections: { tabs: { lastSeq: 7 } }, retry: { attempt: 2, notBefore: 9 } },
    });
    await store.commit({ meta: { collections: { tabs: { lastSyncAt: 100 } } } });
    expect((await store.getMeta()).collections['tabs']).toEqual({ lastSeq: 7, lastSyncAt: 100 });
    await store.commit({ meta: { retry: null } });
    expect((await store.getMeta()).retry).toBeUndefined();
  });

  it('confirms outbox entries only when the revision matches', async () => {
    const store = await open();
    await store.commit({ outboxPut: [entry('a', 'one', 1)] });
    await store.commit({ outboxPut: [entry('a', 'two', 2)] });
    await store.commit({ outboxConfirm: [{ collection: 'tabs', id: 'a', rev: 'one' }] });
    expect((await store.listOutbox()).map((e) => e.rev)).toEqual(['two']);
    await store.commit({ outboxConfirm: [{ collection: 'tabs', id: 'a', rev: 'two' }] });
    expect(await store.listOutbox()).toEqual([]);
  });

  it('deletes mirror entries and clears everything', async () => {
    const store = await open();
    await store.commit({
      mirrorPut: [{ collection: 'tabs', id: 'a', payload: {} }],
      outboxPut: [entry('a', 'r', 1)],
      meta: { clock: 'c' },
    });
    await store.commit({ mirrorDelete: [{ collection: 'tabs', id: 'a' }] });
    expect(await store.getMirror('tabs', 'a')).toBeUndefined();
    await store.clear();
    expect(await store.listOutbox()).toEqual([]);
    expect(await store.getMeta()).toEqual({ collections: {} });
  });
});

describe('IndexedDB store durability', () => {
  it('keeps data across reopening the database (a restarted service worker)', async () => {
    const factory = new IDBFactory();
    const first = await openEngineStore({ indexedDB: factory, IDBKeyRange });
    await first.commit({ outboxPut: [entry('a', 'r', 1)], meta: { clock: 'c' } });
    first.close();
    const second = await openEngineStore({ indexedDB: factory, IDBKeyRange });
    expect((await second.listOutbox()).map((e) => e.id)).toEqual(['a']);
    expect((await second.getMeta()).clock).toBe('c');
  });

  it('writes nothing from a commit that fails', async () => {
    const factory = new IDBFactory();
    const store = await openEngineStore({ indexedDB: factory, IDBKeyRange });
    // A value IndexedDB can't clone aborts the whole transaction.
    const bad = { collection: 'tabs', id: 'b', payload: { f: () => 1 } };
    await expect(
      store.commit({ outboxPut: [entry('a', 'r', 1)], mirrorPut: [bad] }),
    ).rejects.toThrow();
    expect(await store.listOutbox()).toEqual([]);
  });
});
