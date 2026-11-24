/**
 * Known-answer tests against published vectors (SEC-7). The vector files under test/vectors/ were
 * copied from their sources and checked byte for byte; each file names its source.
 */
import { describe, expect, it } from 'vitest';
import gcm from '../../test/vectors/aes-256-gcm-wycheproof.json' with { type: 'json' };
import argon2 from '../../test/vectors/argon2id-reference.json' with { type: 'json' };
import hkdf from '../../test/vectors/hkdf-sha256-rfc5869.json' with { type: 'json' };
import hmac from '../../test/vectors/hmac-sha256-rfc4231.json' with { type: 'json' };
import { DecryptError, importAesKey, open, sealWithNonce } from './aead.ts';
import { concatBytes, utf8 } from './encoding.ts';
import { argon2idRaw } from './kdf.ts';

const hex = (value: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array((value.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('Argon2id: reference implementation vectors', () => {
  it.each(argon2.tests)(
    't=$iterations m=$memoryKiB KiB p=$parallelism "$password"/"$salt"',
    async ({ iterations, memoryKiB, parallelism, password, salt, hash }) => {
      const out = await argon2idRaw(
        utf8(password),
        utf8(salt),
        { iterations, memoryKiB, parallelism },
        argon2.hashLength,
      );
      expect(toHex(out)).toBe(hash);
    },
    30_000,
  );
});

describe('HKDF-SHA256: RFC 5869', () => {
  it.each(hkdf.tests)('test case $case', async ({ ikm, salt, info, length, okm }) => {
    const key = await crypto.subtle.importKey('raw', hex(ikm), 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: hex(salt), info: hex(info) },
      key,
      length * 8,
    );
    expect(toHex(new Uint8Array(bits))).toBe(okm);
  });
});

describe('HMAC-SHA256: RFC 4231', () => {
  it.each(hmac.tests)('test case $case', async ({ key, data, mac }) => {
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      hex(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expect(toHex(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, hex(data))))).toBe(mac);
  });
});

describe('AES-256-GCM: Wycheproof', () => {
  const valid = gcm.tests.filter((t) => t.result === 'valid');
  const invalid = gcm.tests.filter((t) => t.result === 'invalid');

  it('covers both valid and must-reject cases', () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it.each(valid)('valid #$tcId $comment', async ({ key, iv, aad, msg, ct, tag }) => {
    const aesKey = await importAesKey(hex(key));
    const sealed = await sealWithNonce(aesKey, hex(iv), hex(msg), hex(aad));
    expect(toHex(sealed)).toBe(iv + ct + tag);
    expect(toHex(await open(aesKey, sealed, hex(aad)))).toBe(msg);
  });

  it.each(invalid)('rejects #$tcId $comment', async ({ key, iv, aad, ct, tag }) => {
    const aesKey = await importAesKey(hex(key));
    const sealed = concatBytes(hex(iv), hex(ct), hex(tag));
    await expect(open(aesKey, sealed, hex(aad))).rejects.toThrow(DecryptError);
  });
});
