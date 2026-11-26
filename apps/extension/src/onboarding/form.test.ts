import { describe, expect, it } from 'vitest';
import { account, api, crypto as tzCrypto } from '@tazamun/core';
import { OnboardingError } from '../account/session.ts';
import {
  errorKey,
  parseServerInput,
  validateDeviceName,
  validateNewPassphrase,
  validateRecoveryKey,
  validateUsername,
} from './form.ts';

describe('server step', () => {
  it('takes a server URL', () => {
    expect(parseServerInput('sync.example.org')).toEqual({
      ok: true,
      value: 'https://sync.example.org',
    });
    expect(parseServerInput('http://sync.example.org')).toEqual({
      ok: false,
      error: 'errorServerUrlInsecure',
    });
  });
});

describe('field validation', () => {
  it('normalizes usernames and checks device names (ACC-7, ACC-13)', () => {
    expect(validateUsername(' Hasan ')).toEqual({ ok: true, value: 'hasan' });
    expect(validateUsername('ab')).toEqual({ ok: false, error: 'errorUsernameInvalid' });
    expect(validateDeviceName('  Firefox on Linux ')).toEqual({
      ok: true,
      value: 'Firefox on Linux',
    });
    expect(validateDeviceName('   ')).toEqual({ ok: false, error: 'errorDeviceNameEmpty' });
  });

  it('checks the shape of a typed recovery key (ACC-5)', () => {
    const key = tzCrypto.formatRecoveryKey(tzCrypto.generateRecoveryKey());
    expect(validateRecoveryKey(key.toLowerCase()).ok).toBe(true);
    expect(validateRecoveryKey('ABCD-EFGH')).toEqual({
      ok: false,
      error: 'errorRecoveryKeyFormat',
    });
  });

  it('enforces ACC-4 before an account is created', () => {
    const good = 'correct horse battery staple';
    expect(validateNewPassphrase('short', 'short', true)).toBe('errorPassphraseTooShort');
    expect(validateNewPassphrase(good, `${good}!`, true)).toBe('errorPassphraseMismatch');
    expect(validateNewPassphrase(good, good, false)).toBe('errorAcknowledge');
    expect(validateNewPassphrase(good, good, true)).toBeUndefined();
    // The same passphrase composed differently (macOS vs Windows) matches.
    expect(validateNewPassphrase('café café café', 'café café café', true)).toBeUndefined();
  });
});

describe('errorKey', () => {
  const cases: [unknown, string][] = [
    [new api.ApiError(401, 'INVALID_CREDENTIALS', 'x'), 'errorInvalidCredentials'],
    [new api.ApiError(409, 'USERNAME_TAKEN', 'x'), 'errorUsernameTaken'],
    [new account.UsernameError(), 'errorUsernameInvalid'],
    [new tzCrypto.RecoveryKeyFormatError(), 'errorRecoveryKeyFormat'],
    [new api.ApiError(403, 'INVITE_REQUIRED', 'x'), 'errorInviteRequired'],
    [new api.ApiError(403, 'INVITE_INVALID', 'x'), 'errorInviteInvalid'],
    [new api.ApiError(403, 'REGISTRATION_CLOSED', 'x'), 'errorRegistrationClosed'],
    [new api.ApiError(429, 'RATE_LIMITED', 'x'), 'errorRateLimited'],
    [new api.ApiError(404, 'HTTP_ERROR', 'x'), 'errorNotTazamun'],
    [new api.ApiError(503, 'UNAVAILABLE', 'x'), 'errorUnreachable'],
    [new api.ApiError(500, 'SOMETHING_NEW', 'x'), 'errorGeneric'],
    [new api.NetworkError('unreachable', 'x'), 'errorUnreachable'],
    [new api.NetworkError('invalid-response', 'x'), 'errorNotTazamun'],
    [new account.KeyBundleError(), 'errorUnsafeServer'],
    [new tzCrypto.KdfParamsError('x'), 'errorUnsafeServer'],
    [new account.WrongPassphraseError(), 'unlockWrongPassphrase'],
    [new OnboardingError('client-too-old'), 'errorClientTooOld'],
    [new OnboardingError('permission-denied'), 'errorPermissionDenied'],
    [new Error('boom'), 'errorGeneric'],
  ];
  it.each(cases)('%s → %s', (err, key) => {
    expect(errorKey(err)).toBe(key);
  });

  it('reads wrong credentials during recovery as a wrong recovery key', () => {
    const err = new api.ApiError(401, 'INVALID_CREDENTIALS', 'x');
    expect(errorKey(err, 'recover')).toBe('errorRecoveryInvalid');
    expect(errorKey(err, 'connect')).toBe('errorInvalidCredentials');
  });
});
