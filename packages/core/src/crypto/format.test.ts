/** Tazamun's own formats (SEC-2, SEC-3, HIS-1). A failure here means stored data would break. */
import { describe, expect, it } from 'vitest';
import kat from '../../test/vectors/tazamun-format-v1.json' with { type: 'json' };
import { sealWithNonce } from './aead.ts';
import { toBase64Url, utf8 } from './encoding.ts';
import { keyedId } from './ids.ts';
import { type KdfParams, deriveMasterKeys } from './kdf.ts';
import { deriveAccountKeys, unwrapAccountKey } from './keys.ts';
import { decryptPayload, recordAad } from './record.ts';

const hex = (value: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array((value.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const { inputs, expected } = kat;
const address = { accountId: inputs.accountId, ...inputs.record };

describe('Tazamun format v1', () => {
  it('splits Argon2id output into authKey and a KEK that opens the wrapped account key', async () => {
    const { authKey, kek } = await deriveMasterKeys(
      inputs.passphrase,
      hex(inputs.saltHex),
      inputs.kdf as KdfParams,
    );
    expect(toHex(authKey)).toBe(expected.authKeyHex);
    expect(toHex(await unwrapAccountKey(kek, expected.wrappedAccountKey, inputs.accountId))).toBe(
      inputs.accountKeyHex,
    );
  }, 30_000);

  it('derives collection keys and binds the record address as AAD', async () => {
    const keys = await deriveAccountKeys(hex(inputs.accountKeyHex));
    const key = await keys.collectionKey(inputs.record.collection);
    const sealed = await sealWithNonce(
      key,
      hex(inputs.nonceHex),
      utf8(inputs.plaintext),
      recordAad(address),
    );
    expect(toBase64Url(sealed)).toBe(expected.payload);
    expect(await decryptPayload(key, address, expected.payload)).toEqual(
      JSON.parse(inputs.plaintext),
    );
  });

  it('derives history IDs', async () => {
    const keys = await deriveAccountKeys(hex(inputs.accountKeyHex));
    expect(await keyedId(await keys.historyIdKey(), inputs.historyUrl)).toBe(expected.historyId);
  });
});
