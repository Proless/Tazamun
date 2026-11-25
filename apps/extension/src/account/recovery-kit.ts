/**
 * The recovery kit (ACC-5): what someone needs to reach their data again from a new browser.
 * Server URL, account ID and pairing code, plus the passphrase rules. **Never the passphrase or a
 * key** (ACC-6): a kit found by someone else doesn't open the account.
 */
import { account } from '@tazamun/core';
import { t } from '../lib/i18n.ts';

export interface RecoveryKit {
  readonly serverUrl: string;
  readonly accountId: string;
  readonly pairingCode: string;
}

export function recoveryKit(serverUrl: string, accountId: string): RecoveryKit {
  return {
    serverUrl,
    accountId,
    pairingCode: account.formatPairingCode({ serverUrl, accountId }),
  };
}

/** Plain text, for the download. Lines end in CRLF so Notepad on old Windows shows them too. */
export function recoveryKitText(kit: RecoveryKit, createdAt: Date): string {
  return [
    t('kitHeading'),
    '',
    `${t('kitServer')}: ${kit.serverUrl}`,
    `${t('kitAccountId')}: ${kit.accountId}`,
    `${t('kitPairingCode')}: ${kit.pairingCode}`,
    `${t('kitCreated')}: ${createdAt.toISOString().slice(0, 10)}`,
    '',
    t('kitPassphraseNotIncluded'),
    t('kitLostPassphrase'),
    '',
    t('kitHowToConnect'),
    '',
  ].join('\r\n');
}

export function recoveryKitFileName(): string {
  return 'tazamun-recovery-kit.txt';
}
