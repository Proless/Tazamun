/**
 * Request and response bodies of the account, session, key, device and info endpoints
 * (SRS 4.4.3). Shared by the server and the API client, so both validate the same shapes.
 * Records and collections are in envelope.ts.
 *
 * Wire objects use plain `z.object`: unknown fields are dropped, never stored or echoed.
 */
import { z } from 'zod';
import {
  ACCOUNT_ID_BYTES,
  AUTH_KEY_BYTES,
  KDF_PARAMS_LIMITS,
  NONCE_BYTES,
  SALT_BYTES,
  TAG_BYTES,
} from '../crypto/index.ts';
import { base64url, deviceId, isoDateTime, seq } from './primitives.ts';

/** Length of `bytes` bytes in unpadded base64url. */
function b64Chars(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/** Exactly `bytes` bytes, base64url-encoded. */
function b64Bytes(bytes: number) {
  return base64url.length(b64Chars(bytes));
}

/** ACC-1: a 128-bit random account ID. */
export const accountId = b64Bytes(ACCOUNT_ID_BYTES);

/** SEC-1: 16-byte random salt. */
export const kdfSalt = b64Bytes(SALT_BYTES);

/** The 32-byte auth key, sent at sign-in and for operations that need the passphrase again. */
export const authKey = b64Bytes(AUTH_KEY_BYTES);

/** SEC-4: SHA-256 of the auth key, sent once at registration and on a passphrase change. */
export const authHash = b64Bytes(32);

/** SEC-2: the 32-byte account key sealed with AES-256-GCM under the KEK. */
export const wrappedAccountKey = b64Bytes(NONCE_BYTES + 32 + TAG_BYTES);

function bounded(range: { min: number; max: number }) {
  return z.number().int().min(range.min).max(range.max);
}

/**
 * Argon2id parameters, within the same bounds clients enforce (ADR-0008), so the server never
 * stores parameters that no client would accept.
 */
export const kdfParams = z.object({
  algorithm: z.literal('argon2id'),
  memoryKiB: bounded(KDF_PARAMS_LIMITS.memoryKiB),
  iterations: bounded(KDF_PARAMS_LIMITS.iterations),
  parallelism: bounded(KDF_PARAMS_LIMITS.parallelism),
});
export type KdfParamsBody = z.infer<typeof kdfParams>;

/** Collection names: lowercase, so the server can stay ignorant of which collections exist. */
export const collectionName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Invalid collection');

/** A one-time invite token (ADM-2). */
export const inviteToken = base64url.min(16).max(64);

/** Registration modes (ADM-2). */
export const registrationMode = z.enum(['open', 'invite', 'closed']);
export type RegistrationMode = z.infer<typeof registrationMode>;

/**
 * Stable error codes (SRS 4.4.1). Clients branch on these, so never rename one; add new ones.
 * `errorResponse` in envelope.ts accepts any code, so older clients survive new ones.
 */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'NOT_FOUND',
  'ACCOUNT_EXISTS',
  'REGISTRATION_CLOSED',
  'INVITE_REQUIRED',
  'INVITE_INVALID',
  'QUOTA_EXCEEDED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---- Accounts --------------------------------------------------------------------------------

/** `POST /v1/accounts` (ACC-3). */
export const createAccountRequest = z.object({
  accountId,
  salt: kdfSalt,
  kdfParams,
  authHash,
  wrappedAccountKey,
  invite: inviteToken.optional(),
});
export type CreateAccountRequest = z.infer<typeof createAccountRequest>;

export const createAccountResponse = z.object({ accountId });
export type CreateAccountResponse = z.infer<typeof createAccountResponse>;

/** `GET /v1/accounts/{id}/prelogin`. Looks the same for unknown accounts (SEC-9). */
export const preloginResponse = z.object({ salt: kdfSalt, kdfParams });
export type PreloginResponse = z.infer<typeof preloginResponse>;

/** `DELETE /v1/accounts/me` (ACC-10): the passphrase is needed again. */
export const deleteAccountRequest = z.object({ authKey });
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequest>;

// ---- Devices and sessions --------------------------------------------------------------------

/**
 * A device's user-editable name (ACC-7). Plaintext for now; if Q2 decides to encrypt names, this
 * holds ciphertext instead, hence the generous limit.
 */
export const deviceName = z.string().trim().min(1).max(256);

/** Browser family and version (ACC-7). Free text, so new browsers need no schema change. */
export const browserInfo = z.object({
  family: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
});

export const deviceRegistration = z.object({
  id: deviceId,
  name: deviceName,
  browser: browserInfo,
});
export type DeviceRegistration = z.infer<typeof deviceRegistration>;

/** `POST /v1/sessions`: sign in one device (ACC-8). */
export const createSessionRequest = z.object({
  accountId,
  authKey,
  device: deviceRegistration,
});
export type CreateSessionRequest = z.infer<typeof createSessionRequest>;

/** A random 256-bit session token (SRS 4.4.1). */
export const sessionToken = b64Bytes(32);

export const device = z.object({
  id: deviceId,
  name: deviceName,
  browser: browserInfo,
  createdAt: isoDateTime,
  lastSeenAt: isoDateTime,
  /** True for the device making the request. */
  current: z.boolean(),
});
export type Device = z.infer<typeof device>;

export const createSessionResponse = z.object({ token: sessionToken, device });
export type CreateSessionResponse = z.infer<typeof createSessionResponse>;

export const listDevicesResponse = z.object({ devices: z.array(device) });
export type ListDevicesResponse = z.infer<typeof listDevicesResponse>;

/** `PUT /v1/devices/{id}`: rename. */
export const updateDeviceRequest = z.object({ name: deviceName });
export type UpdateDeviceRequest = z.infer<typeof updateDeviceRequest>;

// ---- Keys ------------------------------------------------------------------------------------

/** `GET /v1/keys`: everything a signed-in device needs to unwrap the account key. */
export const keyBundle = z.object({ salt: kdfSalt, kdfParams, wrappedAccountKey });
export type KeyBundle = z.infer<typeof keyBundle>;

/**
 * `PUT /v1/keys` (ACC-9): re-wrap after a passphrase change. `authKey` is the current one; the
 * rest describes the new passphrase. Other devices' sessions end.
 */
export const updateKeysRequest = z.object({
  authKey,
  salt: kdfSalt,
  kdfParams,
  authHash,
  wrappedAccountKey,
});
export type UpdateKeysRequest = z.infer<typeof updateKeysRequest>;

// ---- Info ------------------------------------------------------------------------------------

export const serverLimits = z.object({
  maxRequestBytes: z.number().int().positive(),
  maxBatchRecords: z.number().int().positive(),
  maxPullRecords: z.number().int().positive(),
  storageQuotaBytes: z.number().int().positive(),
});
export type ServerLimits = z.infer<typeof serverLimits>;

/** Present in `/v1/info` when the request is signed in. */
export const accountInfo = z.object({
  /** High-water `seq` per collection that has records. Pull a collection when it grows. */
  collections: z.record(collectionName, seq),
  storageUsedBytes: z.number().int().min(0),
});
export type AccountInfo = z.infer<typeof accountInfo>;

/** `GET /v1/info` (SRS 4.4.3, PERF-5: kept small, as it is polled every alarm). */
export const infoResponse = z.object({
  version: z.string(),
  minClientVersion: z.string(),
  registration: registrationMode,
  limits: serverLimits,
  account: accountInfo.optional(),
});
export type InfoResponse = z.infer<typeof infoResponse>;

/** `GET /v1/health`. */
export const healthResponse = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponse>;
