import { z } from 'zod';
import { MAX_WALL_TIME, isSerializedHlc } from '../hlc/index.ts';

/** Record ID (SRS 4.4): a GUID, a device ID, or an HMAC of the URL (history). 1–64 base64url chars. */
export const recordId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Expected 1–64 base64url characters');

/** Device ID (ACC-7). Same alphabet as record IDs, because tabs and extensions use it as one. */
export const deviceId = recordId;

/** A serialized HLC stamp (SRS 4.4), e.g. `001795000000000:000000ff:dev_A-1`. */
export const hlcStamp = z.string().refine(isSerializedHlc, 'Expected a serialized HLC');

/** Milliseconds since the Unix epoch, as used by browser APIs. */
export const epochMs = z.number().int().min(0).max(MAX_WALL_TIME);

/** Server sequence number (ADR-0003). */
export const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Non-empty base64url without padding (SRS 4.4.1: all binary values are base64url). */
export const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url');

/** RFC 3339 timestamp in UTC, as the server sends it (`2026-11-24T10:00:00Z`). */
export const isoDateTime = z.iso.datetime();

/** A URL as reported by the browser. Not validated further: tabs may hold non-openable URLs. */
export const browserUrl = z.string().min(1);
