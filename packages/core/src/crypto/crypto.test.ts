import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DecryptError, NONCE_BYTES, TAG_BYTES } from './aead.ts';
import { fromBase64Url, toBase64Url } from './encoding.ts';
import { keyedId } from './ids.ts';
import {
  DEFAULT_KDF_PARAMS,
  type KdfParams,
  KdfParamsError,
  SALT_BYTES,
  assertKdfParams,
  deriveMasterKeys,
  hashAuthKey,
} from './kdf.ts';
import {
  deriveAccountKeys,
  generateAccountKey,
  randomId,
  unwrapAccountKey,
  wrapAccountKey,
} from './keys.ts';
import { type RecordAddress, decryptPayload, encryptPayload } from './record.ts';

const SLOW = 30_000;
const salt = new Uint8Array(SALT_BYTES).fill(7);
const address: RecordAddress = { accountId: 'acct_1', collection: 'tabs', recordId: 'dev-a' };

describe('base64url', () => {
  it('round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (bytes) => {
        const encoded = toBase64Url(bytes);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(fromBase64Url(encoded)).toEqual(bytes);
      }),
    );
  });

  it.each(['a', 'ab=', 'a+b/', 'ab c', 'AB'])('rejects %j', (value) => {
    // 'AB' is non-canonical: its last character carries stray bits.
    expect(() => fromBase64Url(value)).toThrow(RangeError);
  });
});

describe('KDF parameters', () => {
  it('accepts the defaults and raised values', () => {
    expect(() => {
      assertKdfParams(DEFAULT_KDF_PARAMS);
    }).not.toThrow();
    expect(() => {
      assertKdfParams({ ...DEFAULT_KDF_PARAMS, memoryKiB: 128 * 1024, iterations: 4 });
    }).not.toThrow();
  });

  it.each<[string, Partial<KdfParams>]>([
    ['less memory (downgrade)', { memoryKiB: 32 * 1024 }],
    ['fewer iterations (downgrade)', { iterations: 1 }],
    ['absurd memory', { memoryKiB: 64 * 1024 * 1024 }],
    ['absurd iterations', { iterations: 1000 }],
    ['fractional values', { iterations: 3.5 }],
    ['another algorithm', { algorithm: 'scrypt' as 'argon2id' }],
  ])('rejects %s', async (_, change) => {
    const params = { ...DEFAULT_KDF_PARAMS, ...change };
    expect(() => {
      assertKdfParams(params);
    }).toThrow(KdfParamsError);
    await expect(deriveMasterKeys('passphrase', salt, params)).rejects.toThrow(KdfParamsError);
  });

  it('rejects salts of the wrong length', async () => {
    await expect(
      deriveMasterKeys('passphrase', new Uint8Array(8), DEFAULT_KDF_PARAMS),
    ).rejects.toThrow(RangeError);
  });
});

describe('master keys and the account key', () => {
  it(
    'derives the same keys from the same passphrase, in any Unicode normalization',
    async () => {
      const composed = 'Grüße aus Köln 2026'; // NFC
      const decomposed = composed.normalize('NFD');
      expect(decomposed).not.toBe(composed);

      const a = await deriveMasterKeys(composed, salt, DEFAULT_KDF_PARAMS);
      const b = await deriveMasterKeys(decomposed, salt, DEFAULT_KDF_PARAMS);
      expect(a.authKey).toEqual(b.authKey);
      expect(a.authKey).toHaveLength(32);

      // Same KEK: a key wrapped with one unwraps with the other.
      const accountKey = generateAccountKey();
      const wrapped = await wrapAccountKey(a.kek, accountKey, address.accountId);
      expect(await unwrapAccountKey(b.kek, wrapped, address.accountId)).toEqual(accountKey);
    },
    SLOW,
  );

  it(
    'fails to unwrap with a wrong passphrase, another account ID, or a tampered bundle',
    async () => {
      const right = await deriveMasterKeys(
        'correct horse battery staple',
        salt,
        DEFAULT_KDF_PARAMS,
      );
      const wrong = await deriveMasterKeys('correct horse battery stapl', salt, DEFAULT_KDF_PARAMS);
      const wrapped = await wrapAccountKey(right.kek, generateAccountKey(), address.accountId);

      await expect(unwrapAccountKey(wrong.kek, wrapped, address.accountId)).rejects.toThrow(
        DecryptError,
      );
      await expect(unwrapAccountKey(right.kek, wrapped, 'other_account')).rejects.toThrow(
        DecryptError,
      );
      const bytes = fromBase64Url(wrapped);
      bytes[NONCE_BYTES] = (bytes[NONCE_BYTES] ?? 0) ^ 1;
      await expect(
        unwrapAccountKey(right.kek, toBase64Url(bytes), address.accountId),
      ).rejects.toThrow(DecryptError);
    },
    SLOW,
  );

  it(
    'keeps the KEK non-extractable and splits authKey from it',
    async () => {
      const { authKey, kek } = await deriveMasterKeys('passphrase', salt, DEFAULT_KDF_PARAMS);
      expect(kek.extractable).toBe(false);
      expect(await hashAuthKey(authKey)).toHaveLength(32);
      expect(await hashAuthKey(authKey)).not.toEqual(authKey);
    },
    SLOW,
  );
});

describe('record payloads', () => {
  it('round-trip JSON payloads', async () => {
    const keys = await deriveAccountKeys(generateAccountKey());
    const key = await keys.collectionKey('tabs');
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        const payload = await encryptPayload(key, address, value);
        expect(await decryptPayload(key, address, payload)).toEqual(
          JSON.parse(JSON.stringify(value)),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('use a fresh nonce every time, so identical payloads never produce identical ciphertext', async () => {
    const key = await (await deriveAccountKeys(generateAccountKey())).collectionKey('tabs');
    const payloads = await Promise.all(
      Array.from({ length: 20 }, () => encryptPayload(key, address, { same: true })),
    );
    expect(new Set(payloads).size).toBe(payloads.length);
    const nonces = payloads.map((p) => toBase64Url(fromBase64Url(p).slice(0, NONCE_BYTES)));
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it.each<[string, Partial<RecordAddress>]>([
    ['another record', { recordId: 'dev-b' }],
    ['another collection', { collection: 'history' }],
    ['another account', { accountId: 'acct_2' }],
  ])('reject a payload moved to %s (AAD)', async (_, change) => {
    const key = await (await deriveAccountKeys(generateAccountKey())).collectionKey('tabs');
    const payload = await encryptPayload(key, address, { windows: [] });
    await expect(decryptPayload(key, { ...address, ...change }, payload)).rejects.toThrow(
      DecryptError,
    );
  });

  it('reject any single flipped bit', async () => {
    const key = await (await deriveAccountKeys(generateAccountKey())).collectionKey('tabs');
    const sealed = fromBase64Url(await encryptPayload(key, address, { windows: [] }));
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: sealed.length * 8 - 1 }), async (bit) => {
        const copy = sealed.slice();
        copy[bit >> 3] = (copy[bit >> 3] ?? 0) ^ (1 << (bit & 7));
        await expect(decryptPayload(key, address, toBase64Url(copy))).rejects.toThrow(DecryptError);
      }),
      { numRuns: 50 },
    );
  });

  it('reject garbage without throwing anything but DecryptError', async () => {
    const key = await (await deriveAccountKeys(generateAccountKey())).collectionKey('tabs');
    for (const garbage of [
      '',
      'not base64!',
      toBase64Url(new Uint8Array(NONCE_BYTES + TAG_BYTES - 1)),
    ]) {
      await expect(decryptPayload(key, address, garbage)).rejects.toThrow(DecryptError);
    }
  });

  it('use a different key per collection and per account', async () => {
    const accountKey = generateAccountKey();
    const keys = await deriveAccountKeys(accountKey);
    const payload = await encryptPayload(await keys.collectionKey('tabs'), address, 1);
    // Same account, other collection key (AAD kept identical so only the key differs).
    await expect(
      decryptPayload(await keys.collectionKey('history'), address, payload),
    ).rejects.toThrow(DecryptError);
    // Other account key, same collection.
    const other = await deriveAccountKeys(generateAccountKey());
    await expect(
      decryptPayload(await other.collectionKey('tabs'), address, payload),
    ).rejects.toThrow(DecryptError);
    // Same account key derives the same collection key on another device.
    const again = await deriveAccountKeys(accountKey);
    expect(await decryptPayload(await again.collectionKey('tabs'), address, payload)).toBe(1);
  });

  it('reject invalid IDs in the address', async () => {
    const key = await (await deriveAccountKeys(generateAccountKey())).collectionKey('tabs');
    await expect(encryptPayload(key, { ...address, recordId: 'a|b' }, 1)).rejects.toThrow(
      RangeError,
    );
  });
});

describe('keyed IDs and random IDs', () => {
  it('are stable per account key, differ between accounts, and are 22 characters', async () => {
    const accountKey = generateAccountKey();
    const idKey = await (await deriveAccountKeys(accountKey)).historyIdKey();
    const sameAccount = await (await deriveAccountKeys(accountKey)).historyIdKey();
    const otherAccount = await (await deriveAccountKeys(generateAccountKey())).historyIdKey();
    const url = 'https://example.org/page';

    const id = await keyedId(idKey, url);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await keyedId(sameAccount, url)).toBe(id);
    expect(await keyedId(otherAccount, url)).not.toBe(id);
    expect(await keyedId(idKey, `${url}2`)).not.toBe(id);
  });

  it('random IDs are 128-bit base64url and unique', () => {
    const ids = Array.from({ length: 100 }, () => randomId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });
});
