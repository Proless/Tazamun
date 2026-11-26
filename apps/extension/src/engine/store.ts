/**
 * The engine's durable state (ENG-3, ENG-11, REL-3): the outbox, the mirror and the sync metadata.
 * IndexedDB in the extension (`idb-store.ts`); `MemoryStore` here for tests. Both implement the same
 * contract: every `commit` is atomic, so a suspended service worker leaves either all of a step's
 * writes or none.
 */

/** A pending upload. Encrypted when queued; the server never sees anything else. */
export interface OutboxEntry {
  readonly collection: string;
  readonly id: string;
  /** Encrypted payload, as pushed. */
  readonly payload: string;
  readonly expiresAt?: string;
  /**
   * Changes on every re-queue of the same record. A push confirmation removes the entry only if
   * `rev` still matches, so a change queued while the push was in flight is not lost.
   */
  readonly rev: string;
  readonly queuedAt: number;
}

/** What the engine last knew of a record: the merged, decrypted payload. */
export interface MirrorEntry {
  readonly collection: string;
  readonly id: string;
  /** Decoded payload. Absent when `held`. */
  readonly payload?: unknown;
  /**
   * ENG-10: a record with a newer schema version, kept as the server sent it (still encrypted)
   * until this client is updated. Never applied, never pushed over.
   */
  readonly held?: { readonly version: number; readonly payload: string };
}

export interface CollectionMeta {
  /** Highest `seq` processed and applied (ADR-0003: saved only after applying). */
  readonly lastSeq: number;
  /** Last successful pull, ms since epoch. */
  readonly lastSyncAt?: number;
}

export interface EngineMeta {
  /**
   * Server URL and account ID the data belongs to. A sign-in to another account (or server) on
   * this browser clears the store first, so nothing leaks across accounts.
   */
  readonly owner?: string;
  /** Serialized HLC of this device (ENG-7). */
  readonly clock?: string;
  readonly collections: Readonly<Record<string, CollectionMeta>>;
  /** Exponential backoff state (ENG-9). */
  readonly retry?: { readonly attempt: number; readonly notBefore: number };
  /** Extension version of the last sync; a change re-reads held records (ENG-10). */
  readonly clientVersion?: string;
  /** ENG-10: the mirror holds records from a newer client. */
  readonly updateRequired?: boolean;
  /** Last run that completed without an error, ms since epoch. */
  readonly lastSuccessAt?: number;
  /**
   * ENG-16: the server's data generation last seen. A different one means the server was restored
   * from a backup: everything is pulled again and what the server lost is pushed back.
   */
  readonly generation?: string;
}

export interface Commit {
  readonly mirrorPut?: readonly MirrorEntry[];
  readonly mirrorDelete?: readonly { collection: string; id: string }[];
  readonly outboxPut?: readonly OutboxEntry[];
  /** Removed only where `rev` matches. */
  readonly outboxConfirm?: readonly { collection: string; id: string; rev: string }[];
  /** Shallow merge into the metadata; `collections` merges per collection. */
  readonly meta?: {
    readonly clock?: string;
    /** Merged per field into each collection's metadata. */
    readonly collections?: Readonly<Record<string, Partial<CollectionMeta>>>;
    /** `null` clears it. */
    readonly retry?: EngineMeta['retry'] | null;
    readonly clientVersion?: string;
    readonly updateRequired?: boolean;
    readonly owner?: string;
    readonly lastSuccessAt?: number;
    readonly generation?: string;
  };
}

export interface EngineStore {
  getMirror(collection: string, id: string): Promise<MirrorEntry | undefined>;
  listMirror(collection: string): Promise<MirrorEntry[]>;
  /** Oldest first. */
  listOutbox(): Promise<OutboxEntry[]>;
  getMeta(): Promise<EngineMeta>;
  commit(commit: Commit): Promise<void>;
  /** Everything, for sign-out with removal and for tests. */
  clear(): Promise<void>;
}

export function emptyMeta(): EngineMeta {
  return { collections: {} };
}

/** Apply a commit's metadata part. Shared by both stores so they behave the same. */
export function mergeMeta(current: EngineMeta, update: NonNullable<Commit['meta']>): EngineMeta {
  const collections: Record<string, CollectionMeta> = { ...current.collections };
  for (const [name, fields] of Object.entries(update.collections ?? {})) {
    collections[name] = { lastSeq: 0, ...collections[name], ...fields };
  }
  const next: { -readonly [K in keyof EngineMeta]: EngineMeta[K] } = { ...current, collections };
  if (update.clock !== undefined) next.clock = update.clock;
  if (update.clientVersion !== undefined) next.clientVersion = update.clientVersion;
  if (update.owner !== undefined) next.owner = update.owner;
  if (update.lastSuccessAt !== undefined) next.lastSuccessAt = update.lastSuccessAt;
  if (update.updateRequired !== undefined) next.updateRequired = update.updateRequired;
  if (update.generation !== undefined) next.generation = update.generation;
  if (update.retry === null) delete next.retry;
  else if (update.retry !== undefined) next.retry = update.retry;
  return next;
}

const key = (collection: string, id: string) => `${collection}\u0000${id}`;

/** In-memory store with the same semantics, for tests. */
export class MemoryStore implements EngineStore {
  readonly mirror = new Map<string, MirrorEntry>();
  readonly outbox = new Map<string, OutboxEntry>();
  meta: EngineMeta = emptyMeta();
  /** Throw on the next commit, to simulate a crash mid-step. */
  failNextCommit = false;

  getMirror(collection: string, id: string): Promise<MirrorEntry | undefined> {
    return Promise.resolve(structuredClone(this.mirror.get(key(collection, id))));
  }

  listMirror(collection: string): Promise<MirrorEntry[]> {
    return Promise.resolve(
      [...this.mirror.values()]
        .filter((e) => e.collection === collection)
        .map((e) => structuredClone(e)),
    );
  }

  listOutbox(): Promise<OutboxEntry[]> {
    return Promise.resolve(
      [...this.outbox.values()]
        .sort((a, b) => a.queuedAt - b.queuedAt)
        .map((e) => structuredClone(e)),
    );
  }

  getMeta(): Promise<EngineMeta> {
    return Promise.resolve(structuredClone(this.meta));
  }

  commit(commit: Commit): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return Promise.reject(new Error('Simulated crash'));
    }
    for (const e of commit.mirrorPut ?? [])
      this.mirror.set(key(e.collection, e.id), structuredClone(e));
    for (const e of commit.mirrorDelete ?? []) this.mirror.delete(key(e.collection, e.id));
    for (const e of commit.outboxPut ?? [])
      this.outbox.set(key(e.collection, e.id), structuredClone(e));
    for (const e of commit.outboxConfirm ?? []) {
      const k = key(e.collection, e.id);
      if (this.outbox.get(k)?.rev === e.rev) this.outbox.delete(k);
    }
    if (commit.meta !== undefined) this.meta = mergeMeta(this.meta, commit.meta);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.mirror.clear();
    this.outbox.clear();
    this.meta = emptyMeta();
    return Promise.resolve();
  }
}
