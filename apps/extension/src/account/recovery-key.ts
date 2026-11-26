/**
 * The recovery key document (ACC-5): the key, shown once, with where and how to use it. Unlike
 * the old recovery kit, this one *is* a secret: with the username it opens the account, so the
 * text says to keep it like a passphrase.
 */
import { t } from '../lib/i18n.ts';

export interface RecoveryKeyInfo {
  readonly serverUrl: string;
  readonly username: string;
  /** Formatted, `ABCD-EFGH-…`. */
  readonly recoveryKey: string;
}

/** Plain text, for the download. Lines end in CRLF so Notepad on old Windows shows them too. */
export function recoveryKeyText(info: RecoveryKeyInfo, createdAt: Date): string {
  return [
    t('recoveryDocHeading'),
    '',
    `${t('recoveryDocServer')}: ${info.serverUrl}`,
    `${t('usernameLabel')}: ${info.username}`,
    `${t('recoveryKeyLabel')}: ${info.recoveryKey}`,
    `${t('recoveryDocCreated')}: ${createdAt.toISOString().slice(0, 10)}`,
    '',
    t('recoveryDocKeepSafe'),
    t('recoveryDocHowTo'),
    '',
  ].join('\r\n');
}

export function recoveryKeyFileName(): string {
  return 'tazamun-recovery-key.txt';
}
