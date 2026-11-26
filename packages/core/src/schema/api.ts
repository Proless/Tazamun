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

/**
 * A username (ACC-13): what people type to sign in. 3–32 characters, lowercase ASCII letters,
 * digits, `.`, `_` and `-`, starting and ending with a letter or digit. ASCII only, so look-alike
 * letters from other scripts can't imitate another user. Clients normalize first
 * (`account.normalizeUsername`); the server accepts only the normalized form.
 */
export const username = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/, 'Invalid username');

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
  'USERNAME_TAKEN',
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

/** `POST /v1/accounts` (ACC-3, ACC-5, ACC-13). */
export const createAccountRequest = z.object({
  accountId,
  username,
  salt: kdfSalt,
  kdfParams,
  authHash,
  wrappedAccountKey,
  recoveryAuthHash: authHash,
  recoveryWrappedAccountKey: wrappedAccountKey,
  invite: inviteToken.optional(),
});
export type CreateAccountRequest = z.infer<typeof createAccountRequest>;

export const createAccountResponse = z.object({ accountId });
export type CreateAccountResponse = z.infer<typeof createAccountResponse>;

/** `POST /v1/prelogin`: the username in the body, so it stays out of proxy access logs. */
export const preloginRequest = z.object({ username });
export type PreloginRequest = z.infer<typeof preloginRequest>;

/** Looks the same for unknown usernames: a stable fake account ID and salt (SEC-9). */
export const preloginResponse = z.object({ accountId, salt: kdfSalt, kdfParams });
export type PreloginResponse = z.infer<typeof preloginResponse>;

/** `GET /v1/accounts/me`. `username` is null for accounts created before usernames existed. */
export const accountResponse = z.object({
  accountId,
  username: username.nullable(),
  /** Whether a recovery key is set (ACC-5). */
  recoveryKey: z.boolean(),
});
export type AccountResponse = z.infer<typeof accountResponse>;

/** `PUT /v1/accounts/me/username` (ACC-13): set or change the username. */
export const updateUsernameRequest = z.object({ username });
export type UpdateUsernameRequest = z.infer<typeof updateUsernameRequest>;

/** `DELETE /v1/accounts/me` (ACC-10): the passphrase is needed again. */
export const deleteAccountRequest = z.object({ authKey });
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequest>;

// ---- Devices and sessions --------------------------------------------------------------------

/**
 * A device's user-editable name (ACC-7). Plaintext, readable by the server (ADR-0009). The
 * generous limit leaves room for ciphertext if a later ADR encrypts names.
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

// ---- Recovery (ACC-5, ADR-0010) --------------------------------------------------------------

/** `PUT /v1/recovery`: set or replace the recovery key. The passphrase is needed again. */
export const setRecoveryRequest = z.object({
  authKey,
  recoveryAuthHash: authHash,
  recoveryWrappedAccountKey: wrappedAccountKey,
});
export type SetRecoveryRequest = z.infer<typeof setRecoveryRequest>;

/** `POST /v1/recovery/key`: prove the recovery key, get the account key wrapped under it. */
export const recoveryKeyRequest = z.object({ username, recoveryAuthKey: authKey });
export type RecoveryKeyRequest = z.infer<typeof recoveryKeyRequest>;

export const recoveryKeyResponse = z.object({ accountId, wrappedAccountKey });
export type RecoveryKeyResponse = z.infer<typeof recoveryKeyResponse>;

/**
 * `POST /v1/recovery/passphrase`: set a new passphrase with the recovery key. Every session ends,
 * as with a passphrase change (ACC-9); the device then signs in with the new passphrase.
 */
export const recoverPassphraseRequest = z.object({
  username,
  recoveryAuthKey: authKey,
  salt: kdfSalt,
  kdfParams,
  authHash,
  wrappedAccountKey,
});
export type RecoverPassphraseRequest = z.infer<typeof recoverPassphraseRequest>;

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
  /**
   * The server's clock when it answered (ENG-15). Clients compare it with their own and warn
   * beyond 5 minutes (`hlc.isClockSkewed`). Optional: older servers don't send it.
   */
  time: isoDateTime.optional(),
  /**
   * The data generation (ENG-16): changes whenever the server's database is restored from a backup.
   * A client that saw another one pulls everything again and pushes back what the server lost.
   * Optional: older servers don't send it.
   */
  generation: z.string().min(1).max(64).optional(),
  minClientVersion: z.string(),
  registration: registrationMode,
  limits: serverLimits,
  account: accountInfo.optional(),
});
export type InfoResponse = z.infer<typeof infoResponse>;

/** `GET /v1/health`. */
export const healthResponse = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponse>;
