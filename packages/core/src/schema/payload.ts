/**
 * Decrypted record payload (SRS 4.4): `{v, deleted, hlc, data}`.
 *
 * Versioning (ENG-10):
 * - `v` is the collection's major schema version. It changes only for breaking changes.
 * - Additive changes (new optional fields) keep `v`. Every object is parsed as a loose object, so a
 *   client that doesn't know a new field still keeps it and pushes it back unchanged after a merge.
 * - A payload with a newer `v` than the client knows is reported as `newer-version`: the engine
 *   keeps the record but doesn't apply it, and tells the user to update.
 */
import { z } from 'zod';
import { hlcStamp } from './primitives.ts';

export const COLLECTION_NAMES = ['tabs', 'commands', 'history', 'extensions'] as const;
export type CollectionName = (typeof COLLECTION_NAMES)[number];

/** Schema of one collection's payload data. */
export interface CollectionSchema<Name extends CollectionName, Data extends z.ZodType> {
  readonly name: Name;
  /** Current major schema version written by this client. */
  readonly version: number;
  readonly data: Data;
}

export function defineCollection<Name extends CollectionName, Data extends z.ZodType>(
  schema: CollectionSchema<Name, Data>,
): CollectionSchema<Name, Data> {
  return schema;
}

/** Any collection schema. */
export type AnyCollection = CollectionSchema<CollectionName, z.ZodType>;
/** The parsed data type of a collection. */
export type DataOf<C extends AnyCollection> = z.output<C['data']>;

const version = z.number().int().min(1);

/** A live record: carries the module's data. */
export interface LivePayload<Data> {
  v: number;
  deleted: false;
  hlc: string;
  data: Data;
}

/** A deleted record (tombstone). It has no data; the server can't tell it from a live record. */
export interface TombstonePayload {
  v: number;
  deleted: true;
  hlc: string;
}

export type Payload<Data> = LivePayload<Data> | TombstonePayload;

/** Build the zod schema for a collection's full payload. */
export function payloadSchema<Data extends z.ZodType>(data: Data) {
  return z.discriminatedUnion('deleted', [
    z.looseObject({ v: version, deleted: z.literal(false), hlc: hlcStamp, data }),
    z.looseObject({ v: version, deleted: z.literal(true), hlc: hlcStamp }),
  ]);
}

/** Where a validation problem is, without the offending value (rule 5: never log plaintext). */
export interface PayloadIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

export type DecodeResult<Data> =
  | { readonly status: 'ok'; readonly payload: Payload<Data> }
  | { readonly status: 'newer-version'; readonly version: number }
  | { readonly status: 'invalid'; readonly issues: readonly PayloadIssue[] };

/**
 * Validate a decrypted, JSON-parsed payload against a collection's schema. Never throws for bad
 * input: a malicious server or a buggy client must not be able to crash the engine.
 */
export function decodePayload<C extends AnyCollection>(
  collection: C,
  value: unknown,
): DecodeResult<DataOf<C>> {
  const header = z.looseObject({ v: version }).safeParse(value);
  if (header.success && header.data.v > collection.version) {
    return { status: 'newer-version', version: header.data.v };
  }
  if (header.success && header.data.v < collection.version) {
    // No collection has an older version yet. Add a migration here when one does.
    return { status: 'invalid', issues: [{ path: ['v'], code: 'unsupported_version' }] };
  }

  const result = payloadSchema(collection.data).safeParse(value);
  if (!result.success) {
    return {
      status: 'invalid',
      issues: result.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    };
  }
  return { status: 'ok', payload: result.data as Payload<DataOf<C>> };
}

/** Build a live payload stamped with the collection's current version. */
export function livePayload<C extends AnyCollection>(
  collection: C,
  hlc: string,
  data: z.input<C['data']>,
): LivePayload<DataOf<C>> {
  return {
    v: collection.version,
    deleted: false,
    hlc: hlcStamp.parse(hlc),
    data: collection.data.parse(data) as DataOf<C>,
  };
}

/** Build a tombstone stamped with the collection's current version. */
export function tombstonePayload(collection: AnyCollection, hlc: string): TombstonePayload {
  return { v: collection.version, deleted: true, hlc: hlcStamp.parse(hlc) };
}
