import { describe, expect, it } from 'vitest';
import { account, api, crypto as tzCrypto } from '@tazamun/core';
import { OnboardingError } from '../account/session.ts';
import {
  errorKey,
  parseServerStep,
  validateAccountId,
  validateDeviceName,
  validateNewPassphrase,
} from './form.ts';

const ID = 'q4FIt0kT1zxqI0Z9Jq2cXw';

describe('server step', () => {
  it('takes a server URL on the create path', () => {
    expect(parseServerStep('create', 'sync.example.org')).toEqual({
      ok: true,
      value: { serverUrl: 'https://sync.example.org' },
    });
    expect(parseServerStep('create', 'http://sync.example.org')).toEqual({
      ok: false,
      error: 'errorServerUrlInsecure',
    });
  });

  it('takes a pairing code or a URL on the connect path', () => {
    expect(parseServerStep('connect', `tazamun:${ID}@https://a.example`)).toEqual({
      ok: true,
      value: { serverUrl: 'https://a.example', accountId: ID },
    });
    expect(parseServerStep('connect', 'https://a.example/')).toEqual({
      ok: true,
      value: { serverUrl: 'https://a.example' },
    });
    expect(parseServerStep('connect', 'tazamun:broken')).toEqual({
      ok: false,
      error: 'errorPairingInvalid',
    });
  });
});

describe('field validation', () => {
  it('checks account IDs and device names', () => {
    expect(validateAccountId(` ${ID} `)).toEqual({ ok: true, value: ID });
    expect(validateAccountId('short').ok).toBe(false);
    expect(validateDeviceName('  Firefox on Linux ')).toEqual({
      ok: true,
      value: 'Firefox on Linux',
    });
    expect(validateDeviceName('   ')).toEqual({ ok: false, error: 'errorDeviceNameEmpty' });
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
});
