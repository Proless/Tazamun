/**
 * Creating, connecting and recovering an account (SRS 3.1, ACC-1…3, ACC-5, ACC-7, ACC-8, ACC-13).
 * Shared by the extension's onboarding and, from P3, the dashboard's sign-in.
 *
 * The passphrase, the recovery key, both KEKs and the account key never leave this module towards
 * the server; only salts, KDF parameters, SHA-256 hashes of the auth keys, the wrapped account keys
 * and (at sign-in or recovery) an auth key do (ACC-3, SEC-4, ADR-0010).
 */
import {
  DEFAULT_KDF_PARAMS,
  SALT_BYTES,
  deriveMasterKeys,
  deriveRecoveryKeys,
  formatRecoveryKey,
  fromBase64Url,
  generateRecoveryKey,
  parseRecoveryKey,
  generateAccountKey,
  hashAuthKey,
  randomBytes,
  randomId,
  toBase64Url,
  unwrapAccountKey,
  unwrapAccountKeyWithRecovery,
  wrapAccountKey,
  wrapAccountKeyForRecovery,
  type KdfParams,
} from '../crypto/index.ts';
import type { DeviceRegistration, Device } from '../schema/api.ts';
import type { ApiClient } from '../api/client.ts';
import { MIN_PASSPHRASE_LENGTH, passphraseLength } from './passphrase.ts';
import { parseUsername } from './username.ts';

/** What a device keeps after signing in. Everything here is secret except the IDs and name. */
export interface SignedIn {
  readonly accountId: string;
  readonly username: string;
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
  /** Normalized here (`parseUsername`); throws UsernameError if invalid. */
  readonly username: string;
  readonly passphrase: string;
  readonly device: DeviceRegistration;
  /** Required when the server's registration mode is `invite` (ADM-2). */
  readonly invite?: string;
  /** Only for tests; production always uses the SEC-1 defaults. */
  readonly kdfParams?: KdfParams;
}

/** A new account, signed in, plus its recovery key to show once (ACC-5). */
export interface CreatedAccount extends SignedIn {
  /** Formatted (`ABCD-EFGH-…`). Show it once and never store it. */
  readonly recoveryKey: string;
}

/** The passphrase and recovery-key material the server stores (ACC-3, ACC-5). */
async function newSecrets(
  accountId: string,
  accountKey: Uint8Array<ArrayBuffer>,
  passphrase: string,
  kdfParams: KdfParams,
) {
  if (passphraseLength(passphrase) < MIN_PASSPHRASE_LENGTH) throw new PassphraseTooShortError();
  const salt = randomBytes(SALT_BYTES);
  const { authKey, kek } = await deriveMasterKeys(passphrase, salt, kdfParams);
  return {
    authKey,
    body: {
      salt: toBase64Url(salt),
      kdfParams: { ...kdfParams },
      authHash: toBase64Url(await hashAuthKey(authKey)),
      wrappedAccountKey: await wrapAccountKey(kek, accountKey, accountId),
    },
  };
}

/** A fresh recovery key and what the server stores for it (ACC-5). */
async function newRecovery(accountId: string, accountKey: Uint8Array<ArrayBuffer>) {
  const recoveryKey = generateRecoveryKey();
  const { authKey, kek } = await deriveRecoveryKeys(recoveryKey);
  const body = {
    recoveryAuthHash: toBase64Url(await hashAuthKey(authKey)),
    recoveryWrappedAccountKey: await wrapAccountKeyForRecovery(kek, accountKey, accountId),
  };
  authKey.fill(0);
  const formatted = formatRecoveryKey(recoveryKey);
  recoveryKey.fill(0);
  return { formatted, body };
}

/**
 * ACC-1…3, ACC-5, ACC-13: generate the account ID, account key and recovery key, derive keys from
 * the passphrase, register the account under the username, then sign this device in. One Argon2id
 * run. A taken username ends in `ApiError` with code `USERNAME_TAKEN`.
 */
export async function createAccount(
  client: ApiClient,
  input: CreateAccountInput,
): Promise<CreatedAccount> {
  const username = parseUsername(input.username);
  const accountId = randomId();
  const accountKey = generateAccountKey();
  const { authKey, body } = await newSecrets(
    accountId,
    accountKey,
    input.passphrase,
    input.kdfParams ?? DEFAULT_KDF_PARAMS,
  );
  const recovery = await newRecovery(accountId, accountKey);

  try {
    await client.createAccount({
      accountId,
      username,
      ...body,
      ...recovery.body,
      ...(input.invite === undefined ? {} : { invite: input.invite }),
    });
    const session = await client.createSession({
      accountId,
      authKey: toBase64Url(authKey),
      device: input.device,
    });
    return {
      accountId,
      username,
      accountKey,
      token: session.token,
      device: session.device,
      recoveryKey: recovery.formatted,
    };
  } finally {
    authKey.fill(0);
  }
}

export interface ConnectAccountInput {
  readonly username: string;
  readonly passphrase: string;
  readonly device: DeviceRegistration;
}

/**
 * SRS 3.1 step 2: prelogin by username, derive, sign in, fetch and unwrap the account key. One
 * Argon2id run.
 *
 * A wrong passphrase and an unknown username both end in `ApiError` with code
 * `INVALID_CREDENTIALS` (the server doesn't say which, SEC-9). Parameters below the SEC-1 floor
 * from a hostile server throw `KdfParamsError` before any key is derived.
 */
export async function connectAccount(
  client: ApiClient,
  input: ConnectAccountInput,
): Promise<SignedIn> {
  const username = parseUsername(input.username);
  const prelogin = await client.prelogin(username);
  const { accountId } = prelogin;
  const { authKey, kek } = await deriveMasterKeys(
    input.passphrase,
    fromBase64Url(prelogin.salt),
    prelogin.kdfParams,
  );
  const session = await client
    .createSession({ accountId, authKey: toBase64Url(authKey), device: input.device })
    .finally(() => authKey.fill(0));
  const bundle = await client.withToken(session.token).keys();
  const accountKey = await unwrapWithPassphraseKey(kek, bundle.wrappedAccountKey, accountId);
  return { accountId, username, accountKey, token: session.token, device: session.device };
}

export interface RecoverAccountInput {
  readonly username: string;
  /** As typed; `crypto.parseRecoveryKey` rules. Throws RecoveryKeyFormatError if malformed. */
  readonly recoveryKey: string;
  readonly newPassphrase: string;
  readonly device: DeviceRegistration;
  /** Only for tests; production always uses the SEC-1 defaults. */
  readonly kdfParams?: KdfParams;
}

/**
 * ACC-5: the passphrase is lost. Prove the recovery key, open the account key with it, set a new
 * passphrase (every other session ends, as with ACC-9), then sign this device in with it. The
 * recovery key stays valid. A wrong recovery key or unknown username ends in `ApiError` with code
 * `INVALID_CREDENTIALS`.
 */
export async function recoverAccount(
  client: ApiClient,
  input: RecoverAccountInput,
): Promise<SignedIn> {
  const username = parseUsername(input.username);
  if (passphraseLength(input.newPassphrase) < MIN_PASSPHRASE_LENGTH) {
    throw new PassphraseTooShortError();
  }
  const recoveryKey = parseRecoveryKey(input.recoveryKey);
  const recovery = await deriveRecoveryKeys(recoveryKey);
  recoveryKey.fill(0);
  const recoveryAuthKey = toBase64Url(recovery.authKey);
  recovery.authKey.fill(0);

  const { accountId, wrappedAccountKey } = await client.recoveryKey({ username, recoveryAuthKey });
  let accountKey: Uint8Array<ArrayBuffer>;
  try {
    accountKey = await unwrapAccountKeyWithRecovery(recovery.kek, wrappedAccountKey, accountId);
  } catch {
    // The server accepted the recovery auth key, so the bundle doesn't match it (ACC-3).
    throw new KeyBundleError();
  }
  const { authKey, body } = await newSecrets(
    accountId,
    accountKey,
    input.newPassphrase,
    input.kdfParams ?? DEFAULT_KDF_PARAMS,
  );
  try {
    await client.recoverPassphrase({ username, recoveryAuthKey, ...body });
    const session = await client.createSession({
      accountId,
      authKey: toBase64Url(authKey),
      device: input.device,
    });
    return { accountId, username, accountKey, token: session.token, device: session.device };
  } finally {
    authKey.fill(0);
  }
}

/**
 * ACC-5: create a new recovery key for a signed-in device (`client` carries its token), replacing
 * any earlier one. Needs the passphrase again; one Argon2id run. Returns the formatted key to show
 * once. A wrong passphrase ends in `ApiError` with code `INVALID_CREDENTIALS`.
 */
export async function createRecoveryKey(
  client: ApiClient,
  accountId: string,
  accountKey: Uint8Array<ArrayBuffer>,
  passphrase: string,
): Promise<string> {
  const bundle = await client.keys();
  const { authKey } = await deriveMasterKeys(
    passphrase,
    fromBase64Url(bundle.salt),
    bundle.kdfParams,
  );
  const recovery = await newRecovery(accountId, accountKey);
  try {
    await client.setRecovery({ authKey: toBase64Url(authKey), ...recovery.body });
  } finally {
    authKey.fill(0);
  }
  return recovery.formatted;
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
