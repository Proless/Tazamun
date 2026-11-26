/**
 * The sync engine (SRS 3.2, ADR-0001, ADR-0003). Generic over modules: nothing in here knows what a
 * tab or a bookmark is (rule 2).
 *
 * One sync run, in this order:
 *   1. detect: each enabled module diffs the browser against the mirror; changes are stamped with
 *      the HLC (ENG-7), encrypted (ENG-2) and queued in the outbox with the mirror update (ENG-3);
 *   2. push the outbox in batches (ENG-4); entries leave it only when the server confirms them;
 *   3. `GET /v1/info`, then pull only collections whose high-water mark moved (ENG-5, ENG-6, PERF-5);
 *      each page is decrypted, validated (ENG-10), merged with the mirror, applied, and only then
 *      is `lastSeq` saved (ADR-0003); merge results that differ from the server are queued (ENG-8);
 *   4. push again if merging queued anything.
 * Local changes are detected before pulling, so a merge always sees this device's latest edits.
 *
 * Every step ends in one atomic store commit, so a service worker killed at any point resumes
 * without losing or duplicating changes (ENG-11, REL-3). Logs and status never hold payloads,
 * URLs, keys or record IDs (ENG-14): only states, counts and error codes.
 */
import { api, crypto as tzCrypto, hlc, merge, schema } from '@tazamun/core';
import type { AnyModule, LocalChange, MirrorView, Payload, SyncRecord } from './module.ts';
import { FULL_RECONCILE_AFTER_MS, TOMBSTONE_TTL_MS, backoffDelay, planBatches } from './policy.ts';
import type { EngineMeta, EngineStore, MirrorEntry, OutboxEntry } from './store.ts';

/** What the engine needs to sync; absent when signed out or locked. */
export interface EngineSession {
  readonly serverUrl: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly accountKey: Uint8Array<ArrayBuffer>;
}

export type Trigger = 'startup' | 'alarm' | 'ui' | 'local-change' | 'retry';

export type EngineState =
  'signed-out' | 'locked' | 'paused' | 'idle' | 'syncing' | 'offline' | 'error';

/** ENG-13: what the UI shows. No content, no IDs. */
export interface EngineStatus {
  readonly state: EngineState;
  /** Error code for `error` (an `ERROR_CODES` value, `UPDATE_REQUIRED`, `DECRYPT_FAILED`, `INTERNAL`). */
  readonly reason?: string;
  /** ENG-10: records from a newer client are kept but not applied until this one is updated. */
  readonly updateRequired?: boolean;
  /** A remote clock was more than 24 h ahead; its stamps were applied but not adopted. */
  readonly clockWarning?: boolean;
  /**
   * ENG-15: this device's clock differs from the server's by more than 5 minutes. Positive: this
   * clock is ahead. Rounded to whole minutes.
   */
  readonly clockSkewMinutes?: number;
  /** Last successful sync, per collection, ms since epoch. */
  readonly lastSync: Readonly<Record<string, number>>;
  /** Last run that completed without an error. */
  readonly lastSuccessAt?: number;
  /** When the next automatic retry may run, while backing off. */
  readonly retryAt?: number;
  /** Records waiting in the outbox. */
  readonly pending: number;
  readonly updatedAt: number;
}

export interface EngineDeps {
  readonly store: EngineStore;
  readonly modules: readonly AnyModule[];
  /** Current session, or why there is none. */
  session(): Promise<EngineSession | 'signed-out' | 'locked'>;
  /** ENG-12: global pause and per-module switches. */
  switches(): Promise<{ paused: boolean; modules: Readonly<Record<string, boolean>> }>;
  client(serverUrl: string, token: string): api.ApiClient;
  /** ENG-9: a 401 means signed out (revoked), never a retry. */
  onUnauthorized(): Promise<void>;
  publishStatus(status: EngineStatus): Promise<void>;
  readonly clientVersion: string;
  now(): number;
  random(): number;
}

/** A failure the engine handled: it is in the status, nothing to rethrow. */
class StopSync extends Error {
  readonly status: Omit<EngineStatus, 'lastSync' | 'pending' | 'updatedAt'>;

  constructor(status: StopSync['status']) {
    super(status.state);
    this.name = 'StopSync';
    this.status = status;
  }
}

interface RunContext {
  readonly session: EngineSession;
  readonly client: api.ApiClient;
  readonly modules: readonly AnyModule[];
  readonly keys: tzCrypto.AccountKeys;
  clock: hlc.Hlc;
  clockWarning: boolean;
  /** ENG-15, set by the info step when the skew is over the warning threshold. */
  clockSkewMs: number | undefined;
  updateRequired: boolean;
}

export class SyncEngine {
  readonly #deps: EngineDeps;
  #running: Promise<EngineStatus> | undefined;
  #again: Trigger | undefined;
  /** PRIV-2: collections whose records from this device should be deleted on the server. */
  readonly #retiring = new Set<string>();

  constructor(deps: EngineDeps) {
    this.#deps = deps;
  }

  /**
   * Run a sync. Only one runs at a time; a request during a run schedules one more run right
   * after it (coalesced), so no trigger is lost.
   */
  sync(trigger: Trigger): Promise<EngineStatus> {
    if (this.#running !== undefined) {
      this.#again = this.#again === 'ui' || trigger === 'ui' ? 'ui' : trigger;
      return this.#running;
    }
    const run = async (): Promise<EngineStatus> => {
      let status = await this.#runOnce(trigger);
      while (this.#again !== undefined) {
        const next = this.#again;
        this.#again = undefined;
        status = await this.#runOnce(next);
      }
      return status;
    };
    this.#running = run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /**
   * PRIV-2: a module was turned off and the user chose to delete this device's data for it from
   * the server. The module's `retire` names the records; they are queued as deletions (even while
   * paused, so the choice survives) and pushed with the next run, which starts right away.
   */
  retire(collection: string): Promise<EngineStatus> {
    this.#retiring.add(collection);
    return this.sync('ui');
  }

  async #runOnce(trigger: Trigger): Promise<EngineStatus> {
    const { store } = this.#deps;
    const session = await this.#deps.session();
    if (session === 'signed-out' || session === 'locked') {
      return this.#publish({ state: session });
    }
    if (this.#retiring.size > 0) await this.#queueRetirements(session);
    const switches = await this.#deps.switches();
    if (switches.paused) return this.#publish({ state: 'paused' });

    const meta = await store.getMeta();
    const now = this.#deps.now();
    // Backing off: automatic triggers wait; opening the UI or "Sync now" goes through (ENG-5).
    if (
      meta.retry !== undefined &&
      meta.retry.notBefore > now &&
      trigger !== 'ui' &&
      trigger !== 'retry'
    ) {
      return this.#publish({ state: 'offline', retryAt: meta.retry.notBefore }, meta);
    }

    await this.#publish({ state: 'syncing' }, meta);
    const modules = this.#deps.modules.filter((m) => switches.modules[m.collection.name] !== false);
    const ctx: RunContext = {
      session,
      client: this.#deps.client(session.serverUrl, session.token),
      modules,
      keys: await tzCrypto.deriveAccountKeys(session.accountKey),
      clock: loadClock(meta, session.deviceId),
      clockWarning: false,
      clockSkewMs: undefined,
      updateRequired: false,
    };
    try {
      const owner = `${session.serverUrl} ${session.accountId}`;
      if (meta.owner !== owner) {
        // Another account's mirror and outbox (encrypted for that account) must never be merged
        // into or pushed to this one. The clock keeps its wall time, so stamps never go back.
        await store.clear();
        await store.commit({ meta: { owner, clock: hlc.serialize(ctx.clock) } });
      }
      await this.#detect(ctx);
      await this.#push(ctx);
      await this.#pullAll(ctx);
      await this.#push(ctx);
      await store.commit({
        meta: { clock: hlc.serialize(ctx.clock), retry: null, lastSuccessAt: this.#deps.now() },
      });
      return await this.#publish({
        state: 'idle',
        ...(ctx.clockWarning ? { clockWarning: true } : {}),
        ...(ctx.clockSkewMs === undefined
          ? {}
          : { clockSkewMinutes: Math.round(ctx.clockSkewMs / 60_000) }),
      });
    } catch (err) {
      return this.#fail(err, ctx);
    }
  }

  // ---- 1. Detect -------------------------------------------------------------------------------

  async #detect(ctx: RunContext): Promise<void> {
    for (const module of ctx.modules) {
      const name = module.collection.name;
      const changes = await module.detectLocalChanges({
        mirror: this.#mirrorView(name),
        deviceId: ctx.session.deviceId,
      });
      await this.#queueChanges(ctx, module, changes);
    }
  }

  async #queueRetirements(session: EngineSession): Promise<void> {
    const meta = await this.#deps.store.getMeta();
    if (meta.owner !== `${session.serverUrl} ${session.accountId}`) return;
    const ctx = {
      session,
      keys: await tzCrypto.deriveAccountKeys(session.accountKey),
      clock: loadClock(meta, session.deviceId),
    };
    for (const name of [...this.#retiring]) {
      const module = this.#deps.modules.find((m) => m.collection.name === name);
      const changes =
        (await module?.retire?.({ mirror: this.#mirrorView(name), deviceId: session.deviceId })) ??
        [];
      if (module !== undefined) await this.#queueChanges(ctx, module, changes);
      this.#retiring.delete(name);
    }
  }

  /** Stamp, encrypt and queue local changes with the mirror update, in one commit. */
  async #queueChanges(
    ctx: Pick<RunContext, 'session' | 'keys' | 'clock'>,
    module: AnyModule,
    changes: readonly LocalChange<unknown>[],
  ): Promise<void> {
    if (changes.length === 0) return;
    const name = module.collection.name;
    const key = await ctx.keys.collectionKey(name);
    const mirrorPut: MirrorEntry[] = [];
    const outboxPut: OutboxEntry[] = [];
    for (const change of changes) {
      ctx.clock = hlc.tick(ctx.clock, this.#deps.now());
      const stamp = hlc.serialize(ctx.clock);
      const payload: Payload<unknown> =
        change.deleted === true
          ? schema.tombstonePayload(module.collection, stamp)
          : schema.livePayload(module.collection, stamp, change.data);
      const expiresAt = change.deleted === true ? this.#tombstoneExpiry() : change.expiresAt;
      mirrorPut.push({ collection: name, id: change.id, payload });
      outboxPut.push(await this.#outboxEntry(ctx, key, name, change.id, payload, expiresAt));
    }
    await this.#deps.store.commit({
      mirrorPut,
      outboxPut,
      meta: { clock: hlc.serialize(ctx.clock) },
    });
  }

  // ---- 2. Push ---------------------------------------------------------------------------------

  async #push(ctx: RunContext): Promise<void> {
    const entries = await this.#deps.store.listOutbox();
    for (const batch of planBatches(entries)) {
      const collection = batch[0]?.collection;
      if (collection === undefined) continue;
      await ctx.client.push(
        collection,
        batch.map((e) => ({
          id: e.id,
          payload: e.payload,
          ...(e.expiresAt === undefined ? {} : { expiresAt: e.expiresAt }),
        })),
      );
      await this.#deps.store.commit({
        outboxConfirm: batch.map((e) => ({ collection: e.collection, id: e.id, rev: e.rev })),
      });
    }
  }

  // ---- 3. Pull ---------------------------------------------------------------------------------

  async #pullAll(ctx: RunContext): Promise<void> {
    const sentAt = this.#deps.now();
    const info = await ctx.client.info();
    if (info.time !== undefined) {
      // ENG-15: compare with the moment halfway through the request, so latency doesn't count.
      const local = (sentAt + this.#deps.now()) / 2;
      const server = Date.parse(info.time);
      if (hlc.isClockSkewed(local, server)) ctx.clockSkewMs = hlc.clockSkewMs(local, server);
    }
    if (!api.isClientSupported(this.#deps.clientVersion, info.minClientVersion)) {
      throw new StopSync({ state: 'error', reason: 'UPDATE_REQUIRED', updateRequired: true });
    }
    const highWater = info.account?.collections ?? {};
    const meta = await this.#deps.store.getMeta();
    // ENG-16: the server was restored from a backup since the last sync. Its records may be older
    // than this device's, and records newer than the backup are gone from it.
    const restored =
      info.generation !== undefined &&
      meta.generation !== undefined &&
      info.generation !== meta.generation;
    const versionChanged = meta.clientVersion !== this.#deps.clientVersion;
    const now = this.#deps.now();
    for (const module of ctx.modules) {
      const name = module.collection.name;
      const state = meta.collections[name] ?? { lastSeq: 0 };
      const top = highWater[name] ?? 0;
      // A full reconcile when tombstones may have expired while away (ADR-0003), or when the server
      // is behind what this device saw (a restore from backup, or a different server).
      const full =
        (state.lastSyncAt !== undefined && now - state.lastSyncAt > FULL_RECONCILE_AFTER_MS) ||
        top < state.lastSeq;
      if (versionChanged) await this.#retryHeld(ctx, module);
      if (restored) await this.#pull(ctx, module, 0, 'restored');
      else if (full) await this.#pull(ctx, module, 0, 'reconcile');
      else if (top > state.lastSeq) await this.#pull(ctx, module, state.lastSeq, 'incremental');
      await this.#deps.store.commit({ meta: { collections: { [name]: { lastSyncAt: now } } } });
    }
    // ENG-10: held records stay held until an update; after one, they were all re-read above.
    const stillHeld = ctx.updateRequired || (!versionChanged && meta.updateRequired === true);
    await this.#deps.store.commit({
      meta: {
        clientVersion: this.#deps.clientVersion,
        updateRequired: stillHeld,
        // Only after every module was re-read: a crash midway repeats the whole recovery.
        ...(info.generation === undefined ? {} : { generation: info.generation }),
      },
    });
  }

  /**
   * `incremental`: from the last `seq`. `reconcile`: everything, and records the server no longer
   * has are gone (their tombstones expired). `restored` (ENG-16): everything, and records the server
   * no longer has are newer than its backup, so they are pushed back, never deleted here.
   */
  async #pull(
    ctx: RunContext,
    module: AnyModule,
    since: number,
    mode: 'incremental' | 'reconcile' | 'restored',
  ): Promise<void> {
    const name = module.collection.name;
    const key = await ctx.keys.collectionKey(name);
    const seen = new Set<string>();
    let cursor = since;
    for (;;) {
      const page = await ctx.client.pull(name, cursor);
      const records = page.records.map((r) => ({ id: r.id, payload: r.payload }));
      for (const r of records) seen.add(r.id);
      await this.#processRemote(ctx, module, key, records, {
        collections: { [name]: { lastSeq: page.nextSince } },
      });
      cursor = page.nextSince;
      if (!page.more) break;
    }
    if (mode === 'reconcile') await this.#dropMissing(ctx, module, seen, cursor);
    if (mode === 'restored') await this.#pushMissing(ctx, module, key, seen);
  }

  /**
   * ENG-16, rule 6: after a restore, records in the mirror that the server lacks were written after
   * its backup. Queue them for push again, unchanged (same HLC, fresh nonce), so the server gets
   * back what it lost. Records waiting in the outbox are pushed anyway. Held records (ENG-10) are
   * left alone: this client can't read them, another device that can will push them.
   */
  async #pushMissing(
    ctx: RunContext,
    module: AnyModule,
    key: CryptoKey,
    seen: ReadonlySet<string>,
  ): Promise<void> {
    const name = module.collection.name;
    const pending = new Set(
      (await this.#deps.store.listOutbox()).filter((e) => e.collection === name).map((e) => e.id),
    );
    const outboxPut: OutboxEntry[] = [];
    for (const entry of await this.#deps.store.listMirror(name)) {
      if (seen.has(entry.id) || pending.has(entry.id) || entry.payload === undefined) continue;
      const payload = entry.payload as Payload<unknown>;
      const expiresAt = payload.deleted ? this.#tombstoneExpiry() : undefined;
      outboxPut.push(await this.#outboxEntry(ctx, key, name, entry.id, payload, expiresAt));
    }
    if (outboxPut.length > 0) await this.#deps.store.commit({ outboxPut });
  }

  /**
   * Decrypt, validate, merge, apply, then commit the mirror, pushes-back and `lastSeq` together.
   * If the worker dies before the commit, the same page is pulled and merged again; merging is
   * idempotent, so the second run changes nothing it shouldn't (REL-2).
   */
  async #processRemote(
    ctx: RunContext,
    module: AnyModule,
    key: CryptoKey,
    records: readonly { id: string; payload: string }[],
    meta: NonNullable<Parameters<EngineStore['commit']>[0]['meta']>,
  ): Promise<void> {
    const name = module.collection.name;
    const changed: SyncRecord<unknown>[] = [];
    const mirrorPut: MirrorEntry[] = [];
    const outboxPut: OutboxEntry[] = [];
    for (const record of records) {
      const address = { accountId: ctx.session.accountId, collection: name, recordId: record.id };
      let decoded: schema.DecodeResult<unknown>;
      try {
        decoded = schema.decodePayload(
          module.collection,
          await tzCrypto.decryptPayload(key, address, record.payload),
        );
      } catch (err) {
        // ENG-2: a record that doesn't decrypt under its own address was tampered with or moved.
        // Skip it; never apply it, never let it stop the sync of the others.
        if (err instanceof tzCrypto.DecryptError) continue;
        throw err;
      }
      if (decoded.status === 'newer-version') {
        ctx.updateRequired = true;
        mirrorPut.push({
          collection: name,
          id: record.id,
          held: { version: decoded.version, payload: record.payload },
        });
        continue;
      }
      if (decoded.status === 'invalid') continue;
      const remote = decoded.payload;
      ctx.clock = this.#receive(ctx, remote.hlc);
      const local = (await this.#deps.store.getMirror(name, record.id))?.payload as
        Payload<unknown> | undefined;
      const merged = module.merge(local, remote);
      if (!merge.jsonEqual(merged, local)) {
        changed.push({ id: record.id, payload: merged });
        mirrorPut.push({ collection: name, id: record.id, payload: merged });
      }
      if (!merge.jsonEqual(merged, remote)) {
        // ENG-8: the server's copy is behind the merge result; push the result.
        const expiresAt = merged.deleted ? this.#tombstoneExpiry() : undefined;
        outboxPut.push(await this.#outboxEntry(ctx, key, name, record.id, merged, expiresAt));
      }
    }
    if (changed.length > 0) await module.apply(changed);
    await this.#deps.store.commit({
      mirrorPut,
      outboxPut,
      meta: { ...meta, clock: hlc.serialize(ctx.clock) },
    });
  }

  /** ENG-10: after an update, records held for a newer version may now be readable. */
  async #retryHeld(ctx: RunContext, module: AnyModule): Promise<void> {
    const name = module.collection.name;
    const held = (await this.#deps.store.listMirror(name)).filter((e) => e.held !== undefined);
    if (held.length === 0) return;
    // Remove the held copies first, in the same commit as their re-processing below: a record
    // that is still too new is held again.
    const key = await ctx.keys.collectionKey(name);
    await this.#deps.store.commit({
      mirrorDelete: held.map((e) => ({ collection: name, id: e.id })),
    });
    await this.#processRemote(
      ctx,
      module,
      key,
      held.map((e) => ({ id: e.id, payload: e.held?.payload ?? '' })),
      {},
    );
  }

  /**
   * After a full pull: records in the mirror that the server no longer has (their tombstones
   * expired, or the server was restored) are gone. Apply them as deletions locally, without
   * pushing anything. Records still in the outbox are this device's unsent changes and stay.
   */
  async #dropMissing(
    ctx: RunContext,
    module: AnyModule,
    seen: ReadonlySet<string>,
    lastSeq: number,
  ): Promise<void> {
    const name = module.collection.name;
    const pending = new Set(
      (await this.#deps.store.listOutbox()).filter((e) => e.collection === name).map((e) => e.id),
    );
    const missing = (await this.#deps.store.listMirror(name)).filter(
      (e) => !seen.has(e.id) && !pending.has(e.id),
    );
    if (missing.length === 0) return;
    ctx.clock = hlc.tick(ctx.clock, this.#deps.now());
    const stamp = hlc.serialize(ctx.clock);
    await module.apply(
      missing.map((e) => ({
        id: e.id,
        payload: schema.tombstonePayload(module.collection, stamp),
      })),
    );
    await this.#deps.store.commit({
      mirrorDelete: missing.map((e) => ({ collection: name, id: e.id })),
      meta: { collections: { [name]: { lastSeq } }, clock: stamp },
    });
  }

  // ---- Helpers ---------------------------------------------------------------------------------

  #receive(ctx: RunContext, stamp: string): hlc.Hlc {
    try {
      return hlc.receive(ctx.clock, hlc.parse(stamp), this.#deps.now());
    } catch (err) {
      // packages/core CLAUDE.md: keep our clock, still apply the record, warn the user.
      if (err instanceof hlc.HlcDriftError) {
        ctx.clockWarning = true;
        return ctx.clock;
      }
      throw err;
    }
  }

  async #outboxEntry(
    ctx: Pick<RunContext, 'session'>,
    key: CryptoKey,
    collection: string,
    id: string,
    payload: Payload<unknown>,
    expiresAt: string | undefined,
  ): Promise<OutboxEntry> {
    const address = { accountId: ctx.session.accountId, collection, recordId: id };
    return {
      collection,
      id,
      payload: await tzCrypto.encryptPayload(key, address, payload),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      rev: tzCrypto.randomId(8),
      queuedAt: this.#deps.now(),
    };
  }

  #tombstoneExpiry(): string {
    return new Date(this.#deps.now() + TOMBSTONE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  #mirrorView(collection: string): MirrorView<unknown> {
    const { store } = this.#deps;
    const toRecord = (e: MirrorEntry): SyncRecord<unknown> | undefined =>
      e.payload === undefined ? undefined : { id: e.id, payload: e.payload as Payload<unknown> };
    return {
      async get(id) {
        const entry = await store.getMirror(collection, id);
        return entry === undefined ? undefined : toRecord(entry);
      },
      async all() {
        return (await store.listMirror(collection))
          .map(toRecord)
          .filter((r): r is SyncRecord<unknown> => r !== undefined);
      },
    };
  }

  async #fail(err: unknown, ctx: RunContext): Promise<EngineStatus> {
    const { store } = this.#deps;
    // Keep the clock even on failure: stamps already handed out must never be reissued.
    await store.commit({ meta: { clock: hlc.serialize(ctx.clock) } }).catch(() => undefined);
    if (err instanceof StopSync) return this.#publish(err.status);
    if (err instanceof api.ApiError && err.code === 'UNAUTHORIZED') {
      await this.#deps.onUnauthorized();
      return this.#publish({ state: 'signed-out' });
    }
    const meta = await store.getMeta();
    const attempt = (meta.retry?.attempt ?? 0) + 1;
    const retryAfter = err instanceof api.ApiError ? err.retryAfter : undefined;
    const notBefore = this.#deps.now() + backoffDelay(attempt, this.#deps.random(), retryAfter);
    await store.commit({ meta: { retry: { attempt, notBefore } } });
    if (err instanceof api.NetworkError && err.kind !== 'invalid-response') {
      return this.#publish({ state: 'offline', retryAt: notBefore });
    }
    const reason = err instanceof api.ApiError ? err.code : 'INTERNAL';
    return this.#publish({ state: 'error', reason, retryAt: notBefore });
  }

  async #publish(
    partial: Omit<EngineStatus, 'lastSync' | 'pending' | 'updatedAt'>,
    known?: EngineMeta,
  ): Promise<EngineStatus> {
    const meta = known ?? (await this.#deps.store.getMeta());
    const lastSync: Record<string, number> = {};
    for (const [name, c] of Object.entries(meta.collections)) {
      if (c.lastSyncAt !== undefined) lastSync[name] = c.lastSyncAt;
    }
    const status: EngineStatus = {
      ...(meta.updateRequired === true ? { updateRequired: true } : {}),
      ...(meta.lastSuccessAt === undefined ? {} : { lastSuccessAt: meta.lastSuccessAt }),
      ...partial,
      lastSync,
      pending: (await this.#deps.store.listOutbox()).length,
      updatedAt: this.#deps.now(),
    };
    await this.#deps.publishStatus(status);
    return status;
  }
}

function loadClock(meta: EngineMeta, deviceId: string): hlc.Hlc {
  if (meta.clock !== undefined) {
    try {
      const clock = hlc.parse(meta.clock);
      // A clock from another device ID (signed in as a new device) starts over; its wall time is
      // kept, so stamps never go backwards on this browser.
      return clock.deviceId === deviceId ? clock : { ...clock, deviceId };
    } catch {
      // Corrupted: start fresh. Wall time comes from Date.now() at the next tick.
    }
  }
  return hlc.createHlc(deviceId);
}
