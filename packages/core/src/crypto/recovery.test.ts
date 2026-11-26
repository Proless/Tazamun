import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import kat from '../../test/vectors/tazamun-recovery-v1.json' with { type: 'json' };
import { DecryptError, sealWithNonce } from './aead.ts';
import { toBase64Url, utf8 } from './encoding.ts';
import { generateAccountKey, unwrapAccountKey, wrapAccountKey } from './keys.ts';
import {
  RECOVERY_KEY_BYTES,
  RecoveryKeyFormatError,
  deriveRecoveryKeys,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  unwrapAccountKeyWithRecovery,
  wrapAccountKeyForRecovery,
} from './recovery.ts';

const hex = (value: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array((value.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('recovery key text (ACC-5)', () => {
  it('round-trips any key through 8 groups of 4 characters', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: RECOVERY_KEY_BYTES, maxLength: RECOVERY_KEY_BYTES }),
        (bytes) => {
          const text = formatRecoveryKey(bytes);
          expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
          expect(parseRecoveryKey(text)).toEqual(new Uint8Array(bytes));
        },
      ),
    );
  });

  it('ignores case, spaces and dashes, and reads I, L and O as 1, 1 and 0', () => {
    const key = generateRecoveryKey();
    const text = formatRecoveryKey(key);
    expect(parseRecoveryKey(` ${text.toLowerCase().replaceAll('-', ' ')} `)).toEqual(key);
    const zeros = formatRecoveryKey(new Uint8Array(RECOVERY_KEY_BYTES));
    expect(parseRecoveryKey(zeros.replaceAll('0', 'o'))).toEqual(
      new Uint8Array(RECOVERY_KEY_BYTES),
    );
    expect(parseRecoveryKey('1'.repeat(32))).toEqual(parseRecoveryKey('il'.repeat(16)));
  });

  it.each(['', 'ABCD-EFGH', '0'.repeat(31), '0'.repeat(33), `${'0'.repeat(31)}U`])(
    'rejects %j',
    (text) => {
      expect(() => parseRecoveryKey(text)).toThrow(RecoveryKeyFormatError);
    },
  );
});

describe('recovery key wrap (ACC-5, ADR-0010)', () => {
  it('opens the account key only with the same recovery key and account', async () => {
    const accountKey = generateAccountKey();
    const { kek } = await deriveRecoveryKeys(generateRecoveryKey());
    const wrapped = await wrapAccountKeyForRecovery(kek, accountKey, 'acct_1');
    expect(await unwrapAccountKeyWithRecovery(kek, wrapped, 'acct_1')).toEqual(accountKey);
    await expect(unwrapAccountKeyWithRecovery(kek, wrapped, 'acct_2')).rejects.toThrow(
      DecryptError,
    );
    const other = await deriveRecoveryKeys(generateRecoveryKey());
    await expect(unwrapAccountKeyWithRecovery(other.kek, wrapped, 'acct_1')).rejects.toThrow(
      DecryptError,
    );
  });

  it('is not interchangeable with the passphrase wrap', async () => {
    const accountKey = generateAccountKey();
    const { kek } = await deriveRecoveryKeys(generateRecoveryKey());
    const forRecovery = await wrapAccountKeyForRecovery(kek, accountKey, 'acct_1');
    const forPassphrase = await wrapAccountKey(kek, accountKey, 'acct_1');
    await expect(unwrapAccountKey(kek, forRecovery, 'acct_1')).rejects.toThrow(DecryptError);
    await expect(unwrapAccountKeyWithRecovery(kek, forPassphrase, 'acct_1')).rejects.toThrow(
      DecryptError,
    );
  });

  it('derives an auth key that differs between recovery keys', async () => {
    const a = await deriveRecoveryKeys(generateRecoveryKey());
    const b = await deriveRecoveryKeys(generateRecoveryKey());
    expect(a.authKey).toHaveLength(32);
    expect(a.authKey).not.toEqual(b.authKey);
  });
});

/** Format v1 of the recovery key. A failure here means existing recovery keys would stop working. */
describe('Tazamun recovery format v1', () => {
  const { inputs, expected } = kat;

  it('formats the key and derives the auth key', async () => {
    const key = hex(inputs.recoveryKeyHex);
    expect(formatRecoveryKey(key)).toBe(expected.recoveryKeyText);
    expect(toHex((await deriveRecoveryKeys(key)).authKey)).toBe(expected.authKeyHex);
  });

  it('wraps the account key with the recovery KEK and AAD', async () => {
    const { kek } = await deriveRecoveryKeys(hex(inputs.recoveryKeyHex));
    const sealed = await sealWithNonce(
      kek,
      hex(inputs.nonceHex),
      hex(inputs.accountKeyHex),
      utf8(`tazamun/v1/recovery-account-key|${inputs.accountId}`),
    );
    expect(toBase64Url(sealed)).toBe(expected.wrappedAccountKey);
    expect(
      toHex(await unwrapAccountKeyWithRecovery(kek, expected.wrappedAccountKey, inputs.accountId)),
    ).toBe(inputs.accountKeyHex);
  });
});
