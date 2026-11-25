/**
 * Creating and connecting an account (SRS 3.1, ACC-1…3, ACC-7, ACC-8). Shared by the extension's
 * onboarding and, from P3, the dashboard's sign-in.
 *
 * The passphrase, the KEK and the account key never leave this module towards the server; only
 * the salt, the KDF parameters, SHA-256(authKey), the wrapped account key and (at sign-in) the
 * auth key do (ACC-3, SEC-4).
 */
import {
  DEFAULT_KDF_PARAMS,
  SALT_BYTES,
  deriveMasterKeys,
  fromBase64Url,
  generateAccountKey,
  hashAuthKey,
  randomBytes,
  randomId,
  toBase64Url,
  unwrapAccountKey,
  wrapAccountKey,
  type KdfParams,
} from '../crypto/index.ts';
import type { DeviceRegistration, Device } from '../schema/api.ts';
import type { ApiClient } from '../api/client.ts';
import { MIN_PASSPHRASE_LENGTH, passphraseLength } from './passphrase.ts';

/** What a device keeps after signing in. Everything here is secret except `accountId`. */
export interface SignedIn {
  readonly accountId: string;
  /** ACC-1: 32 random bytes. Kept per SEC-5; never sent to the server. */
  readonly accountKey: Uint8Array<ArrayBuffer>;
  /** ACC-8: this device's session token. */
  readonly token: string;
  readonly device: Device;
}

export class PassphraseTooShortError extends RangeError {
  constructor() {
    super(`The passphrase must have at least ${String(MIN_PASSPHRASE_LENGTH)} characters`);
    this.name = 'PassphraseTooShortError';
  }
}

/**
 * The passphrase doesn't open the account key. The server already accepted the auth key, so
 * this means the server sent a key bundle that doesn't match: tampering or a server bug.
 */
export class KeyBundleError extends Error {
  constructor() {
    super('The account key from the server could not be unwrapped');
    this.name = 'KeyBundleError';
  }
}

/** ACC-7: a random device ID, 128 bits like the account ID. */
export function newDeviceId(): string {
  return randomId();
}

export interface CreateAccountInput {
  readonly passphrase: string;
  readonly device: DeviceRegistration;
  /** Required when the server's registration mode is `invite` (ADM-2). */
  readonly invite?: string;
  /** Only for tests; production always uses the SEC-1 defaults. */
  readonly kdfParams?: KdfParams;
}

/**
 * ACC-1…3: generate the account ID and key, derive keys from the passphrase, register the account,
 * then sign this device in. One Argon2id run.
 */
export async function createAccount(
  client: ApiClient,
  input: CreateAccountInput,
): Promise<SignedIn> {
  if (passphraseLength(input.passphrase) < MIN_PASSPHRASE_LENGTH)
    throw new PassphraseTooShortError();
  const kdfParams = input.kdfParams ?? DEFAULT_KDF_PARAMS;
  const accountId = randomId();
  const accountKey = generateAccountKey();
  const salt = randomBytes(SALT_BYTES);
  const { authKey, kek } = await deriveMasterKeys(input.passphrase, salt, kdfParams);

  await client.createAccount({
    accountId,
    salt: toBase64Url(salt),
    kdfParams: { ...kdfParams },
    authHash: toBase64Url(await hashAuthKey(authKey)),
    wrappedAccountKey: await wrapAccountKey(kek, accountKey, accountId),
    ...(input.invite === undefined ? {} : { invite: input.invite }),
  });
  const session = await client.createSession({
    accountId,
    authKey: toBase64Url(authKey),
    device: input.device,
  });
  authKey.fill(0);
  return { accountId, accountKey, token: session.token, device: session.device };
}

export interface ConnectAccountInput {
  readonly accountId: string;
  readonly passphrase: string;
  readonly device: DeviceRegistration;
}

/**
 * SRS 3.1 step 2: prelogin, derive, sign in, fetch and unwrap the account key. One Argon2id run.
 *
 * A wrong passphrase and an unknown account both end in `ApiError` with code
 * `INVALID_CREDENTIALS` (the server doesn't say which, SEC-9). Parameters below the SEC-1 floor
 * from a hostile server throw `KdfParamsError` before any key is derived.
 */
export async function connectAccount(
  client: ApiClient,
  input: ConnectAccountInput,
): Promise<SignedIn> {
  const prelogin = await client.prelogin(input.accountId);
  const { authKey, kek } = await deriveMasterKeys(
    input.passphrase,
    fromBase64Url(prelogin.salt),
    prelogin.kdfParams,
  );
  const session = await client.createSession({
    accountId: input.accountId,
    authKey: toBase64Url(authKey),
    device: input.device,
  });
  authKey.fill(0);
  const bundle = await client.withToken(session.token).keys();
  const accountKey = await unwrapWithPassphraseKey(kek, bundle.wrappedAccountKey, input.accountId);
  return { accountId: input.accountId, accountKey, token: session.token, device: session.device };
}

/**
 * Unlock (SEC-5, *don't remember the key*): the device is still signed in, but the account key was
 * dropped when the browser closed. Derives the KEK from the passphrase and unwraps the key bundle.
 * A wrong passphrase throws `WrongPassphraseError`; no request is spent on it beyond `GET /v1/keys`.
 */
export async function unlockAccount(
  client: ApiClient,
  accountId: string,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const bundle = await client.keys();
  const { authKey, kek } = await deriveMasterKeys(
    passphrase,
    fromBase64Url(bundle.salt),
    bundle.kdfParams,
  );
  authKey.fill(0);
  try {
    return await unwrapAccountKey(kek, bundle.wrappedAccountKey, accountId);
  } catch {
    throw new WrongPassphraseError();
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase');
    this.name = 'WrongPassphraseError';
  }
}

async function unwrapWithPassphraseKey(
  kek: CryptoKey,
  wrapped: string,
  accountId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await unwrapAccountKey(kek, wrapped, accountId);
  } catch {
    throw new KeyBundleError();
  }
}
