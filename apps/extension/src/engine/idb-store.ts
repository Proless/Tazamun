/**
 * IndexedDB implementation of the engine store (ENG-3). One database, three object stores; every
 * `commit` is one readwrite transaction over all three, so it is atomic.
 *
 * IndexedDB transactions commit as soon as no request is pending, so nothing inside a transaction
 * may `await` anything else (encryption happens before `commit`).
 */
import {
  emptyMeta,
  mergeMeta,
  type Commit,
  type EngineMeta,
  type EngineStore,
  type MirrorEntry,
  type OutboxEntry,
} from './store.ts';

const DB_NAME = 'tazamun-engine';
const DB_VERSION = 1;
const MIRROR = 'mirror';
const OUTBOX = 'outbox';
const META = 'meta';
const META_KEY = 'meta';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

/** The IndexedDB globals, injectable for tests (`fake-indexeddb`). */
export interface IdbEnvironment {
  readonly indexedDB: IDBFactory;
  readonly IDBKeyRange: typeof IDBKeyRange;
}

export async function openEngineStore(
  env: IdbEnvironment = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange },
): Promise<IdbStore> {
  const request = env.indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    // Version 1. Later versions add stores or indexes here, never change these (like server
    // migrations: existing profiles have run this).
    if (!db.objectStoreNames.contains(MIRROR)) {
      db.createObjectStore(MIRROR, { keyPath: ['collection', 'id'] });
    }
    if (!db.objectStoreNames.contains(OUTBOX)) {
      const outbox = db.createObjectStore(OUTBOX, { keyPath: ['collection', 'id'] });
      outbox.createIndex('queuedAt', 'queuedAt');
    }
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
  };
  return new IdbStore(await promisify(request), env.IDBKeyRange);
}

export class IdbStore implements EngineStore {
  readonly #db: IDBDatabase;
  readonly #keyRange: typeof IDBKeyRange;

  constructor(db: IDBDatabase, keyRange: typeof IDBKeyRange) {
    this.#db = db;
    this.#keyRange = keyRange;
  }

  async getMirror(collection: string, id: string): Promise<MirrorEntry | undefined> {
    const tx = this.#db.transaction(MIRROR, 'readonly');
    return (await promisify(tx.objectStore(MIRROR).get([collection, id]))) as
      MirrorEntry | undefined;
  }

  async listMirror(collection: string): Promise<MirrorEntry[]> {
    const tx = this.#db.transaction(MIRROR, 'readonly');
    const range = this.#keyRange.bound([collection], [collection, []]);
    return (await promisify(tx.objectStore(MIRROR).getAll(range))) as MirrorEntry[];
  }

  async listOutbox(): Promise<OutboxEntry[]> {
    const tx = this.#db.transaction(OUTBOX, 'readonly');
    return (await promisify(tx.objectStore(OUTBOX).index('queuedAt').getAll())) as OutboxEntry[];
  }

  async getMeta(): Promise<EngineMeta> {
    const tx = this.#db.transaction(META, 'readonly');
    const meta = (await promisify(tx.objectStore(META).get(META_KEY))) as EngineMeta | undefined;
    return meta ?? emptyMeta();
  }

  commit(commit: Commit): Promise<void> {
    const tx = this.#db.transaction([MIRROR, OUTBOX, META], 'readwrite');
    const finished = done(tx);
    try {
      this.#write(tx, commit);
    } catch (err) {
      // A put that throws (a value that can't be cloned) must not leave the other writes to
      // commit on their own: abort, so the commit is all or nothing.
      tx.abort();
      return finished.catch(() => undefined).then(() => Promise.reject(err as Error));
    }
    return finished;
  }

  #write(tx: IDBTransaction, commit: Commit): void {
    const mirror = tx.objectStore(MIRROR);
    const outbox = tx.objectStore(OUTBOX);
    for (const e of commit.mirrorPut ?? []) mirror.put(e);
    for (const e of commit.mirrorDelete ?? []) mirror.delete([e.collection, e.id]);
    for (const e of commit.outboxPut ?? []) outbox.put(e);
    for (const e of commit.outboxConfirm ?? []) {
      const get = outbox.get([e.collection, e.id]);
      get.onsuccess = () => {
        if ((get.result as OutboxEntry | undefined)?.rev === e.rev)
          outbox.delete([e.collection, e.id]);
      };
    }
    const update = commit.meta;
    if (update !== undefined) {
      const store = tx.objectStore(META);
      const get = store.get(META_KEY);
      get.onsuccess = () => {
        const current = (get.result as EngineMeta | undefined) ?? emptyMeta();
        store.put(mergeMeta(current, update), META_KEY);
      };
    }
  }

  clear(): Promise<void> {
    const tx = this.#db.transaction([MIRROR, OUTBOX, META], 'readwrite');
    const finished = done(tx);
    for (const name of [MIRROR, OUTBOX, META]) tx.objectStore(name).clear();
    return finished;
  }

  close(): void {
    this.#db.close();
  }
}
