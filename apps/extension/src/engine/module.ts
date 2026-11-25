/**
 * The module interface (ENG-1, ADR-0001). A module is everything that is specific to one data
 * type; the engine is everything else. Modules never talk to the network or the crypto layer, and
 * the engine never looks inside `data`.
 */
import type { schema } from '@tazamun/core';

/** A decrypted, validated payload of one collection: `{v, deleted, hlc, data?}`. */
export type Payload<Data> = schema.Payload<Data>;

/** One record as the engine and modules see it: decrypted, validated, with its record ID. */
export interface SyncRecord<Data> {
  readonly id: string;
  readonly payload: Payload<Data>;
}

/** A local change found by `detectLocalChanges`. The engine stamps it with the HLC (ENG-7). */
export type LocalChange<Data> =
  | {
      readonly id: string;
      readonly deleted?: false;
      readonly data: Data;
      readonly expiresAt?: string;
    }
  | { readonly id: string; readonly deleted: true };

/** Read access to what the engine last stored for this collection (the "mirror"). */
export interface MirrorView<Data> {
  get(id: string): Promise<SyncRecord<Data> | undefined>;
  all(): Promise<SyncRecord<Data>[]>;
}

export interface DetectContext<Data> {
  readonly mirror: MirrorView<Data>;
  /** This device's ID, which owned-by-one-device modules (tabs) use as their record ID. */
  readonly deviceId: string;
}

export interface SyncModule<Data> {
  /** Collection schema from `@tazamun/core`; its `version` is the module's schema version. */
  readonly collection: schema.AnyCollection;

  /**
   * Diff the browser's state against the mirror and return what changed (rule 4: events only
   * trigger this; they are never the source of truth). Return nothing when nothing changed: an
   * unchanged record must not be re-stamped, or every sync would push.
   */
  detectLocalChanges(ctx: DetectContext<Data>): Promise<LocalChange<Data>[]>;

  /**
   * Pure merge of the mirror's copy with a record from the server (rule 3: implemented in
   * `packages/core`). Must be commutative, associative and idempotent. If the result differs from
   * `remote`, the engine pushes it back (ENG-8).
   */
  merge(local: Payload<Data> | undefined, remote: Payload<Data>): Payload<Data>;

  /**
   * Bring the browser in line with records that changed through a pull, after merging. Must be
   * idempotent (REL-2): after a crash the engine may apply the same records again. Records owned by
   * other devices (tabs) usually need nothing here; the UI reads the mirror.
   */
  apply(records: SyncRecord<Data>[]): Promise<void>;

  /**
   * Optional: register the browser events that may mean a local change, calling `notify` for
   * each. The background calls it synchronously at its top level (MV3) and then runs
   * `detectLocalChanges` after `debounceMs` of quiet.
   */
  watch?(notify: () => void): void;
  /** Debounce for this module's change events; default PUSH_DEBOUNCE_MS (ENG-4). */
  readonly debounceMs?: number;
}

/** Any module, for the engine's registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the engine never touches `data`
export type AnyModule = SyncModule<any>;
