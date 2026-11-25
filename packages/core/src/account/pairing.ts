/**
 * Pairing codes (ACC-6): the server URL and the account ID in one string, so connecting a second
 * browser is one paste plus the passphrase. **Never contains key material.**
 *
 * Format v1: `tazamun:<accountId>@<serverUrl>`, e.g.
 * `tazamun:q4FIt0kT1zxqI0Z9Jq2cXw@https://sync.example.org`. The account ID is base64url, which has
 * no `@`, so the first `@` separates the two parts.
 */
import { accountId as accountIdSchema } from '../schema/api.ts';
import { normalizeServerUrl } from './server-url.ts';

const PREFIX = 'tazamun:';

export interface PairingInfo {
  readonly serverUrl: string;
  readonly accountId: string;
}

export class PairingCodeError extends RangeError {
  constructor() {
    super('Invalid pairing code');
    this.name = 'PairingCodeError';
  }
}

export function formatPairingCode({ serverUrl, accountId }: PairingInfo): string {
  if (!accountIdSchema.safeParse(accountId).success) throw new RangeError('Invalid account ID');
  return `${PREFIX}${accountId}@${normalizeServerUrl(serverUrl)}`;
}

/** Accepts surrounding whitespace and a line break inserted by a mail client. */
export function parsePairingCode(input: string): PairingInfo {
  const code = input.replace(/\s+/g, '');
  if (!code.startsWith(PREFIX)) throw new PairingCodeError();
  const rest = code.slice(PREFIX.length);
  const at = rest.indexOf('@');
  if (at < 0) throw new PairingCodeError();
  const accountId = rest.slice(0, at);
  if (!accountIdSchema.safeParse(accountId).success) throw new PairingCodeError();
  let serverUrl: string;
  try {
    serverUrl = normalizeServerUrl(rest.slice(at + 1));
  } catch {
    throw new PairingCodeError();
  }
  return { serverUrl, accountId };
}

/** True if the input looks like a pairing code rather than a bare account ID. */
export function isPairingCode(input: string): boolean {
  return input.trim().startsWith(PREFIX);
}
