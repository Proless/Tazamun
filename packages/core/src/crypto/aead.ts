/**
 * AES-256-GCM sealing in Tazamun's wire format: `nonce(12) || ciphertext || tag(16)`.
 *
 * `seal` draws a fresh random nonce on every call. This is the one place where core uses
 * randomness internally instead of taking it as input: letting callers pass nonces invites reuse,
 * which breaks AES-GCM completely.
 */
import { concatBytes, randomBytes } from './encoding.ts';

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

/** Decryption failed: wrong key, wrong AAD, or tampered data. Deliberately carries no detail. */
export class DecryptError extends Error {
  constructor() {
    super('Decryption failed');
    this.name = 'DecryptError';
  }
}

/** Seal with an explicit nonce. Only for test vectors; production code must use `seal`. */
export async function sealWithNonce(
  key: CryptoKey,
  nonce: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (nonce.length !== NONCE_BYTES) {
    throw new RangeError(`Nonce must be ${String(NONCE_BYTES)} bytes`);
  }
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_BYTES * 8 },
    key,
    plaintext,
  );
  return concatBytes(nonce, new Uint8Array(sealed));
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return sealWithNonce(key, randomBytes(NONCE_BYTES), plaintext, aad);
}

/** Throws DecryptError if the data was modified, or the key or AAD differ. */
export async function open(
  key: CryptoKey,
  sealed: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new DecryptError();
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.subarray(0, NONCE_BYTES),
        additionalData: aad,
        tagLength: TAG_BYTES * 8,
      },
      key,
      sealed.subarray(NONCE_BYTES),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new DecryptError();
  }
}

/** Import 32 raw bytes as a non-extractable AES-256-GCM key. */
export async function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 32) {
    throw new RangeError('AES-256 keys are 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
