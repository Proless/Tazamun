/**
 * Server-side secrets: token and auth-key hashing (SEC-4), the instance secret (DEP-11) and fake
 * prelogin values for unknown accounts (SEC-9). The server never sees keys that decrypt data.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crypto as tzCrypto } from '@tazamun/core';

export const INSTANCE_SECRET_FILE = 'instance-secret';

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/** Constant-time equality for two hashes (SEC-4). Unequal lengths are simply unequal. */
export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stand-in for a missing account's hash, so failed sign-ins take the same time either way. */
const DUMMY_HASH = new Uint8Array(32);

/**
 * Check an auth key against the stored SHA-256(authKey). Pass `undefined` for an unknown
 * account: the comparison still runs, so timing doesn't reveal whether the account exists.
 */
export function verifyAuthKey(authKeyB64: string, storedHash: Uint8Array | undefined): boolean {
  const hash = sha256(tzCrypto.fromBase64Url(authKeyB64));
  const equal = hashesEqual(hash, storedHash ?? DUMMY_HASH);
  return storedHash !== undefined && equal;
}

/** A random 256-bit token (session tokens, invite tokens), base64url-encoded. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored hashed (SEC-4); the hash of the token's text is its lookup key. */
export function tokenHash(token: string): Uint8Array {
  return sha256(token);
}

/**
 * The instance secret: from the configuration if set, otherwise read from (or generated once
 * into) `<dataDir>/instance-secret` with owner-only permissions (DEP-11).
 */
export function loadInstanceSecret(dataDir: string, configured: string | undefined): Uint8Array {
  if (configured !== undefined) return new TextEncoder().encode(configured);
  const path = join(dataDir, INSTANCE_SECRET_FILE);
  try {
    return new TextEncoder().encode(readFileSync(path, 'utf8').trim());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const secret = newToken();
  // `wx` fails if another process created the file in the meantime; then read theirs.
  try {
    writeFileSync(path, `${secret}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return new TextEncoder().encode(readFileSync(path, 'utf8').trim());
  }
  return new TextEncoder().encode(secret);
}

/**
 * A fake but stable salt for an unknown account ID (SEC-9): the same ID always gets the same
 * salt on this instance, and it can't be told apart from a real one.
 */
export function fakeSalt(instanceSecret: Uint8Array, accountId: string): string {
  const mac = createHmac('sha256', instanceSecret)
    .update(`tazamun/prelogin-salt|${accountId}`)
    .digest();
  return mac.subarray(0, tzCrypto.SALT_BYTES).toString('base64url');
}
