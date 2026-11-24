/**
 * Wire format of the HTTP API (SRS 4.4). This is everything the server can see: IDs, sequence
 * numbers, timestamps and ciphertext. Plaintext lives only in the decrypted payload (payload.ts).
 */
import { z } from 'zod';
import { base64url, isoDateTime, recordId, seq } from './primitives.ts';

/** SRS 4.4.1: at most 500 records per batch. */
export const MAX_BATCH_RECORDS = 500;
/** SRS 4.4.1: request bodies up to 2 MB. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** AES-GCM nonce (12 bytes) plus tag (16 bytes), base64url-encoded: the smallest possible payload. */
const MIN_PAYLOAD_CHARS = Math.ceil(((12 + 16) * 4) / 3);

/** Encrypted payload: `b64url(nonce(12) || ciphertext || tag(16))`. */
export const encryptedPayload = base64url.min(MIN_PAYLOAD_CHARS);

/** A record as the server returns it on pull. */
export const recordEnvelope = z.object({
  id: recordId,
  seq,
  /** Server time. Informational only; never used for merging. */
  modifiedAt: isoDateTime,
  /** The server deletes the record after this time. */
  expiresAt: isoDateTime.optional(),
  payload: encryptedPayload,
});
export type RecordEnvelope = z.infer<typeof recordEnvelope>;

/** `GET /v1/collections/{name}?since=&limit=` response. */
export const pullResponse = z.object({
  records: z.array(recordEnvelope),
  nextSince: seq,
  more: z.boolean(),
});
export type PullResponse = z.infer<typeof pullResponse>;

/** One record in a push batch. The server assigns `seq` and `modifiedAt`. */
export const pushRecord = recordEnvelope.pick({ id: true, expiresAt: true, payload: true });
export type PushRecord = z.infer<typeof pushRecord>;

/** `POST /v1/collections/{name}` request body. */
export const pushRequest = z.array(pushRecord).min(1).max(MAX_BATCH_RECORDS);
export type PushRequest = z.infer<typeof pushRequest>;

/** `POST /v1/collections/{name}` response: the `seq` assigned to each record. */
export const pushResponse = z.array(z.object({ id: recordId, seq }));
export type PushResponse = z.infer<typeof pushResponse>;

/** Error body for every non-2xx response (SRS 4.4.1). `code` values are stable. */
export const errorResponse = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string(),
    /** Seconds to wait before retrying, for rate limits and quotas. */
    retryAfter: z.number().int().min(0).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;
