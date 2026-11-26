/**
 * The recovery key (ACC-5, ADR-0010): a second way to open the account key when the passphrase is
 * lost. 160 random bits, shown once as 32 Crockford base32 characters in groups of four.
 *
 *   recovery key ─HKDF-SHA256─▶ recovery auth key (info "tazamun/v1/recovery/auth")
 *                             └▶ recovery KEK      (info "tazamun/v1/recovery/kek")
 *   recovery KEK ─AES-GCM wrap─▶ account key (AAD "tazamun/v1/recovery-account-key|<accountId>")
 *
 * The key is uniformly random and long, so HKDF is enough; no Argon2id. The server stores
 * SHA-256(recovery auth key) and the wrapped account key, like it does for the passphrase.
 */
import { open, seal } from './aead.ts';
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from './encoding.ts';
import { ACCOUNT_KEY_BYTES, assertId } from './keys.ts';

export const RECOVERY_KEY_BYTES = 20;
/** Crockford base32: no I, L, O or U, so a handwritten key can't be misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHARS = (RECOVERY_KEY_BYTES * 8) / 5;
const GROUP = 4;

export class RecoveryKeyFormatError extends RangeError {
  constructor() {
    super(`A recovery key has ${String(CHARS)} characters`);
    this.name = 'RecoveryKeyFormatError';
  }
}

/** A fresh recovery key. Show it once; never store it (ACC-5). */
export function generateRecoveryKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(RECOVERY_KEY_BYTES);
}

/** `ABCD-EFGH-…`: 8 groups of 4 characters. */
export function formatRecoveryKey(key: Uint8Array): string {
  if (key.length !== RECOVERY_KEY_BYTES) throw new RecoveryKeyFormatError();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((value >> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return (out.match(new RegExp(`.{${String(GROUP)}}`, 'g')) ?? []).join('-');
}

/**
 * Parse a typed recovery key. Case, spaces and dashes don't matter, and the letters people confuse
 * with digits are read as Crockford does (I and L as 1, O as 0). Throws RecoveryKeyFormatError.
 */
export function parseRecoveryKey(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (clean.length !== CHARS) throw new RecoveryKeyFormatError();
  const out = new Uint8Array(RECOVERY_KEY_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new RecoveryKeyFormatError();
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
      value &= (1 << bits) - 1;
    }
  }
  return out;
}

export interface RecoveryKeys {
  /** Sent to the server to prove the recovery key; the server stores only its SHA-256. */
  readonly authKey: Uint8Array<ArrayBuffer>;
  /** Wraps the account key. Never leaves the client. */
  readonly kek: CryptoKey;
}

export async function deriveRecoveryKeys(key: Uint8Array<ArrayBuffer>): Promise<RecoveryKeys> {
  if (key.length !== RECOVERY_KEY_BYTES) throw new RecoveryKeyFormatError();
  const base = await crypto.subtle.importKey('raw', key, 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ]);
  const params = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    // The recovery key is uniformly random, so no salt is needed (RFC 5869, section 3.1).
    salt: new Uint8Array(0),
    info: utf8(info),
  });
  const authKey = new Uint8Array(
    await crypto.subtle.deriveBits(params('tazamun/v1/recovery/auth'), base, 256),
  );
  const kek = await crypto.subtle.deriveKey(
    params('tazamun/v1/recovery/kek'),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { authKey, kek };
}

function recoveryAad(accountId: string): Uint8Array<ArrayBuffer> {
  assertId(accountId, 'accountId');
  return utf8(`tazamun/v1/recovery-account-key|${accountId}`);
}

/** The account key sealed under the recovery KEK, as the server stores it. */
export async function wrapAccountKeyForRecovery(
  kek: CryptoKey,
  accountKey: Uint8Array<ArrayBuffer>,
  accountId: string,
): Promise<string> {
  if (accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new RangeError(`Account key must be ${String(ACCOUNT_KEY_BYTES)} bytes`);
  }
  return toBase64Url(await seal(kek, accountKey, recoveryAad(accountId)));
}

/** Throws DecryptError for a wrong recovery key or a tampered bundle. */
export async function unwrapAccountKeyWithRecovery(
  kek: CryptoKey,
  wrapped: string,
  accountId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const accountKey = await open(kek, fromBase64Url(wrapped), recoveryAad(accountId));
  if (accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new RangeError('Unwrapped account key has the wrong length');
  }
  return accountKey;
}
