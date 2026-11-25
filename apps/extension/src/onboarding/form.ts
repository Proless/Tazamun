/**
 * Onboarding form logic (UI-2), kept out of the `.vue` file so it is linted and unit-tested:
 * validation of each step, and turning any error into a message key. Messages never include the
 * values the user typed (rule 5).
 */
import { account, api, crypto as tzCrypto, schema } from '@tazamun/core';
import type { t } from '../lib/i18n.ts';
import { OnboardingError } from '../account/session.ts';

export type MessageKey = Parameters<typeof t>[0];

export type Result<T> = { ok: true; value: T } | { ok: false; error: MessageKey };

/** Create path, server step: a server URL. */
export function parseServerInput(input: string): Result<string> {
  try {
    return { ok: true, value: account.normalizeServerUrl(input) };
  } catch (err) {
    return { ok: false, error: errorKey(err) };
  }
}

/** Connect path, server step: a pairing code (server URL and account ID) or a server URL. */
export function parseConnectInput(
  input: string,
): Result<{ serverUrl: string; accountId?: string }> {
  if (account.isPairingCode(input)) {
    try {
      return { ok: true, value: account.parsePairingCode(input) };
    } catch {
      return { ok: false, error: 'errorPairingInvalid' };
    }
  }
  const url = parseServerInput(input);
  return url.ok ? { ok: true, value: { serverUrl: url.value } } : url;
}

/** The server step on either path. */
export function parseServerStep(
  mode: 'create' | 'connect',
  input: string,
): Result<{ serverUrl: string; accountId?: string }> {
  if (mode === 'connect') return parseConnectInput(input);
  const url = parseServerInput(input);
  return url.ok ? { ok: true, value: { serverUrl: url.value } } : url;
}

export function validateAccountId(input: string): Result<string> {
  const id = input.trim();
  return schema.accountId.safeParse(id).success
    ? { ok: true, value: id }
    : { ok: false, error: 'errorAccountIdInvalid' };
}

export function validateDeviceName(input: string): Result<string> {
  const parsed = schema.deviceName.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: 'errorDeviceNameEmpty' };
}

/** ACC-4: length, confirmation, and the acknowledgement that a lost passphrase is lost data. */
export function validateNewPassphrase(
  passphrase: string,
  confirmation: string,
  acknowledged: boolean,
): MessageKey | undefined {
  if (account.passphraseLength(passphrase) < account.MIN_PASSPHRASE_LENGTH) {
    return 'errorPassphraseTooShort';
  }
  // Compare after NFC, as the KDF does: the same passphrase typed on two systems must match.
  if (passphrase.normalize('NFC') !== confirmation.normalize('NFC')) {
    return 'errorPassphraseMismatch';
  }
  if (!acknowledged) return 'errorAcknowledge';
  return undefined;
}

export const STRENGTH_KEYS = [
  'passphraseStrength0',
  'passphraseStrength1',
  'passphraseStrength2',
  'passphraseStrength3',
  'passphraseStrength4',
] as const satisfies readonly MessageKey[];

/** Any error from the server step or the account flows → the message to show. */
export function errorKey(err: unknown): MessageKey {
  if (err instanceof account.ServerUrlError) {
    if (err.reason === 'insecure') return 'errorServerUrlInsecure';
    if (err.reason === 'invalid') return 'errorServerUrlInvalid';
    return 'errorServerUrlExtra';
  }
  if (err instanceof account.PairingCodeError) return 'errorPairingInvalid';
  if (err instanceof account.PassphraseTooShortError) return 'errorPassphraseTooShort';
  if (err instanceof account.WrongPassphraseError) return 'unlockWrongPassphrase';
  if (err instanceof account.KeyBundleError || err instanceof tzCrypto.KdfParamsError) {
    return 'errorUnsafeServer';
  }
  if (err instanceof OnboardingError) {
    if (err.reason === 'client-too-old') return 'errorClientTooOld';
    if (err.reason === 'registration-closed') return 'errorRegistrationClosed';
    return 'errorPermissionDenied';
  }
  if (err instanceof api.ApiError) {
    switch (err.code) {
      case 'INVALID_CREDENTIALS':
        return 'errorInvalidCredentials';
      case 'INVITE_REQUIRED':
        return 'errorInviteRequired';
      case 'INVITE_INVALID':
        return 'errorInviteInvalid';
      case 'REGISTRATION_CLOSED':
        return 'errorRegistrationClosed';
      case 'RATE_LIMITED':
        return 'errorRateLimited';
      case 'HTTP_ERROR':
      case 'NOT_FOUND':
        return 'errorNotTazamun';
      case 'UNAVAILABLE':
        return 'errorUnreachable';
      default:
        return 'errorGeneric';
    }
  }
  if (err instanceof api.NetworkError) {
    return err.kind === 'invalid-response' ? 'errorNotTazamun' : 'errorUnreachable';
  }
  return 'errorGeneric';
}
