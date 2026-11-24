/**
 * Passphrase key derivation (SEC-1, ACC-2): Argon2id → 64 bytes → authKey (first 32) and KEK
 * (last 32). The auth key is sent to the server to sign in; the KEK never leaves the client.
 *
 * Argon2id is slow on purpose (about 0.5–1 s at the defaults). Run it at sign-in and unlock only.
 */
import { argon2id } from 'hash-wasm';
import { utf8 } from './encoding.ts';

export interface KdfParams {
  readonly algorithm: 'argon2id';
  /** Memory cost in KiB. */
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

/** SEC-1 defaults: m = 64 MiB, t = 3, p = 1. */
export const DEFAULT_KDF_PARAMS: KdfParams = Object.freeze({
  algorithm: 'argon2id',
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
});

/**
 * Accepted range for parameters received from the server (prelogin). The lower bound is the
 * default: parameters may be raised over time but never lowered, so a malicious server can't make
 * the auth key cheap to brute-force by sending weak parameters. The upper bound stops a server
 * from freezing the client with absurd costs.
 */
export const KDF_PARAMS_LIMITS = Object.freeze({
  memoryKiB: { min: DEFAULT_KDF_PARAMS.memoryKiB, max: 1024 * 1024 },
  iterations: { min: DEFAULT_KDF_PARAMS.iterations, max: 10 },
  parallelism: { min: DEFAULT_KDF_PARAMS.parallelism, max: 4 },
});

/** SEC-1: 16-byte random salt per account. */
export const SALT_BYTES = 16;
export const AUTH_KEY_BYTES = 32;

export class KdfParamsError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'KdfParamsError';
  }
}

/** Throws KdfParamsError unless `params` is Argon2id within KDF_PARAMS_LIMITS. */
export function assertKdfParams(params: KdfParams): void {
  if ((params.algorithm as string) !== 'argon2id') {
    throw new KdfParamsError('Unsupported KDF algorithm');
  }
  for (const name of ['memoryKiB', 'iterations', 'parallelism'] as const) {
    const value = params[name];
    const { min, max } = KDF_PARAMS_LIMITS[name];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new KdfParamsError(`KDF ${name} must be between ${String(min)} and ${String(max)}`);
    }
  }
}

/**
 * Raw Argon2id (version 0x13). Exposed for test vectors; use `deriveMasterKeys` instead.
 * Doesn't check KDF_PARAMS_LIMITS, because reference vectors use smaller parameters.
 */
export async function argon2idRaw(
  password: Uint8Array,
  salt: Uint8Array,
  params: Omit<KdfParams, 'algorithm'>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = await argon2id({
    password,
    salt,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    parallelism: params.parallelism,
    hashLength: length,
    outputType: 'binary',
  });
  return new Uint8Array(out);
}

/**
 * Passphrases are normalized to Unicode NFC before hashing, so the same passphrase typed on
 * systems that compose characters differently (macOS vs Windows) derives the same keys.
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFC');
}

export interface MasterKeys {
  /** Sent to the server at sign-in; the server stores only SHA-256(authKey) (SEC-4). */
  readonly authKey: Uint8Array<ArrayBuffer>;
  /** Key-encryption key: wraps and unwraps the account key. Non-extractable. */
  readonly kek: CryptoKey;
}

export async function deriveMasterKeys(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<MasterKeys> {
  assertKdfParams(params);
  if (salt.length !== SALT_BYTES) {
    throw new RangeError(`Salt must be ${String(SALT_BYTES)} bytes`);
  }
  const output = await argon2idRaw(utf8(normalizePassphrase(passphrase)), salt, params, 64);
  const authKey = output.slice(0, AUTH_KEY_BYTES);
  const kek = await crypto.subtle.importKey('raw', output.slice(AUTH_KEY_BYTES), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  output.fill(0);
  return { authKey, kek };
}

/** SEC-4: what the server stores instead of the auth key. */
export async function hashAuthKey(
  authKey: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', authKey));
}
