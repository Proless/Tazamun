/**
 * Passphrase rules and the strength estimate (ACC-4).
 *
 * The estimate is a deliberately simple guess-entropy model, not a cracking simulator: it counts
 * the character pool, then discounts repeats, keyboard and alphabet runs, and a short list of the
 * most common passwords and words. It catches the obvious mistakes ("aaaaaaaaaaaa",
 * "password1234", "123456789012") and rewards length, which is what matters against Argon2id at
 * these costs. It never blocks a passphrase of 12+ characters; it only informs.
 */
import { normalizePassphrase } from '../crypto/kdf.ts';

/** ACC-4. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** 0 = too short, 1 = weak, 2 = fair, 3 = good, 4 = strong. */
export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PassphraseStrength {
  readonly score: StrengthScore;
  /** Estimated entropy in bits, rounded down. */
  readonly bits: number;
  /** Below MIN_PASSPHRASE_LENGTH characters: can't be used. */
  readonly tooShort: boolean;
}

/** Bits at which each score starts (score 1 is anything usable below FAIR). */
const FAIR_BITS = 45;
const GOOD_BITS = 60;
const STRONG_BITS = 80;

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'qwertzuiop',
  'azertyuiop',
];

/** Lowercase, compared after stripping digits and symbols around them. Kept short on purpose. */
const COMMON = [
  'password',
  'passwort',
  'passphrase',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'qwerty',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'master',
  'shadow',
  'secret',
  'tazamun',
];

/** Length in Unicode code points, as a user counts characters. */
export function passphraseLength(passphrase: string): number {
  return Array.from(normalizePassphrase(passphrase)).length;
}

export function estimateStrength(passphrase: string): PassphraseStrength {
  const chars = Array.from(normalizePassphrase(passphrase));
  const tooShort = chars.length < MIN_PASSPHRASE_LENGTH;

  let pool = 0;
  if (chars.some((c) => /[a-z]/.test(c))) pool += 26;
  if (chars.some((c) => /[A-Z]/.test(c))) pool += 26;
  if (chars.some((c) => /[0-9]/.test(c))) pool += 10;
  if (chars.some((c) => /[\s]/.test(c))) pool += 1;
  if (chars.some((c) => /[^a-zA-Z0-9\s]/.test(c) && c.charCodeAt(0) < 128)) pool += 33;
  if (chars.some((c) => (c.codePointAt(0) ?? 0) >= 128)) pool += 100;
  const perChar = pool > 0 ? Math.log2(pool) : 0;

  // Characters that add little: a repeat of the previous one, or the next step of a sequence.
  const lower = chars.map((c) => c.toLowerCase());
  let effective = 0;
  for (const [i, c] of lower.entries()) {
    const prev = lower[i - 1];
    if (prev !== undefined && (c === prev || isSequenceStep(prev, c))) {
      effective += 0.25;
    } else {
      effective += 1;
    }
  }

  // A common password or word counts as one guess from a small list instead of its characters.
  const joined = lower.join('');
  for (const word of COMMON) {
    let from = joined.indexOf(word);
    while (from >= 0) {
      effective -= word.length - 1;
      from = joined.indexOf(word, from + word.length);
    }
  }

  // Few distinct characters ("abababababab") cap the pool.
  const distinct = new Set(lower).size;
  const cappedPerChar = Math.min(perChar, Math.log2(Math.max(2, distinct * 2)));
  const bits = Math.max(0, Math.floor(Math.max(0, effective) * cappedPerChar));

  let score: StrengthScore;
  if (tooShort) score = 0;
  else if (bits >= STRONG_BITS) score = 4;
  else if (bits >= GOOD_BITS) score = 3;
  else if (bits >= FAIR_BITS) score = 2;
  else score = 1;
  return { score, bits, tooShort };
}

function isSequenceStep(prev: string, c: string): boolean {
  for (const sequence of SEQUENCES) {
    const i = sequence.indexOf(prev);
    if (i < 0) continue;
    if (sequence[i + 1] === c || (i > 0 && sequence[i - 1] === c)) return true;
  }
  return false;
}
