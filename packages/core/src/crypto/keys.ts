/**
 * Key hierarchy (SEC-2, ADR-0002):
 *
 *   passphrase ─Argon2id─▶ authKey, KEK
 *   KEK ─AES-GCM wrap─▶ account key (32 random bytes, ACC-1)
 *   account key ─HKDF-SHA256─▶ one AES key per collection  (info "tazamun/v1/enc/<collection>")
 *                            └▶ history ID key (HMAC)      (info "tazamun/v1/id/history")
 *
 * Changing the passphrase re-wraps the account key; records are never re-encrypted (ACC-9).
 */
import { open, seal } from './aead.ts';
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from './encoding.ts';

export const ACCOUNT_KEY_BYTES = 32;
/** ACC-1: 128-bit account IDs. */
export const ACCOUNT_ID_BYTES = 16;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertId(value: string, name: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new RangeError(`${name} must be 1–64 base64url characters`);
  }
}

/** A random ID of `bytes` random bytes, base64url-encoded (account IDs, device IDs, GUIDs). */
export function randomId(bytes = ACCOUNT_ID_BYTES): string {
  return toBase64Url(randomBytes(bytes));
}

/** ACC-1: a fresh random account key. Keep the raw bytes only as long as needed (SEC-5). */
export function generateAccountKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(ACCOUNT_KEY_BYTES);
}

function wrapAad(accountId: string): Uint8Array<ArrayBuffer> {
  assertId(accountId, 'accountId');
  return utf8(`tazamun/v1/account-key|${accountId}`);
}

/**
 * Encrypt the account key under the KEK. The result is what the server stores as
 * `wrappedAccountKey`. The account ID is bound as AAD, so a wrapped key only opens for its account.
 */
export async function wrapAccountKey(
  kek: CryptoKey,
  accountKey: Uint8Array<ArrayBuffer>,
  accountId: string,
): Promise<string> {
  if (accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new RangeError(`Account key must be ${String(ACCOUNT_KEY_BYTES)} bytes`);
  }
  return toBase64Url(await seal(kek, accountKey, wrapAad(accountId)));
}

/** Throws DecryptError for a wrong passphrase (wrong KEK) or a tampered key bundle. */
export async function unwrapAccountKey(
  kek: CryptoKey,
  wrapped: string,
  accountId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const accountKey = await open(kek, fromBase64Url(wrapped), wrapAad(accountId));
  if (accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new RangeError('Unwrapped account key has the wrong length');
  }
  return accountKey;
}

/** Keys derived from the account key. All are non-extractable. */
export interface AccountKeys {
  /** AES-256-GCM key for one collection's payloads. */
  collectionKey(collection: string): Promise<CryptoKey>;
  /** HMAC-SHA256 key for history record IDs (HIS-1). */
  historyIdKey(): Promise<CryptoKey>;
}

type DeriveKey = typeof crypto.subtle.deriveKey;
type DerivedKeyAlgorithm = Parameters<DeriveKey>[2];
type KeyUsages = Parameters<DeriveKey>[4];

async function hkdfKey(
  base: CryptoKey,
  info: string,
  algorithm: DerivedKeyAlgorithm,
  usages: KeyUsages,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    // The account key is uniformly random, so no salt is needed (RFC 5869, section 3.1).
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    base,
    algorithm,
    false,
    usages,
  );
}

/** Derive the per-collection and history-ID keys from the raw account key (SEC-2). */
export async function deriveAccountKeys(accountKey: Uint8Array<ArrayBuffer>): Promise<AccountKeys> {
  if (accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new RangeError(`Account key must be ${String(ACCOUNT_KEY_BYTES)} bytes`);
  }
  const base = await crypto.subtle.importKey('raw', accountKey, 'HKDF', false, ['deriveKey']);
  const cache = new Map<string, Promise<CryptoKey>>();
  let historyIdKey: Promise<CryptoKey> | undefined;
  return {
    collectionKey(collection: string) {
      assertId(collection, 'collection');
      let key = cache.get(collection);
      if (!key) {
        key = hkdfKey(base, `tazamun/v1/enc/${collection}`, { name: 'AES-GCM', length: 256 }, [
          'encrypt',
          'decrypt',
        ]);
        cache.set(collection, key);
      }
      return key;
    },
    historyIdKey() {
      historyIdKey ??= hkdfKey(
        base,
        'tazamun/v1/id/history',
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        ['sign'],
      );
      return historyIdKey;
    },
  };
}
