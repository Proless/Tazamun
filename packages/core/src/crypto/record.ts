/**
 * Record payload encryption (SEC-3, ENG-2). AAD = `accountId|collection|recordId`, checked on
 * decrypt, so a server can't move a ciphertext to another record, collection or account.
 * The `|` separator is unambiguous because all three parts are base64url.
 */
import { open, seal } from './aead.ts';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding.ts';
import { DecryptError } from './aead.ts';
import { assertId } from './keys.ts';

export interface RecordAddress {
  readonly accountId: string;
  readonly collection: string;
  readonly recordId: string;
}

export function recordAad({
  accountId,
  collection,
  recordId,
}: RecordAddress): Uint8Array<ArrayBuffer> {
  assertId(accountId, 'accountId');
  assertId(collection, 'collection');
  assertId(recordId, 'recordId');
  return utf8(`${accountId}|${collection}|${recordId}`);
}

/** Encrypt a payload object to the envelope's `payload` string. */
export async function encryptPayload(
  key: CryptoKey,
  address: RecordAddress,
  payload: unknown,
): Promise<string> {
  return toBase64Url(await seal(key, utf8(JSON.stringify(payload)), recordAad(address)));
}

/**
 * Decrypt an envelope's `payload` and parse the JSON. Validate the result with
 * `schema.decodePayload`. Throws DecryptError for anything that doesn't decrypt to JSON.
 */
export async function decryptPayload(
  key: CryptoKey,
  address: RecordAddress,
  payload: string,
): Promise<unknown> {
  let sealed: Uint8Array<ArrayBuffer>;
  try {
    sealed = fromBase64Url(payload);
  } catch {
    throw new DecryptError();
  }
  const plaintext = await open(key, sealed, recordAad(address));
  try {
    return JSON.parse(fromUtf8(plaintext)) as unknown;
  } catch {
    throw new DecryptError();
  }
}
