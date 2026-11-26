/**
 * Usernames (ACC-13, ADR-0010): what people type to sign in, unique per server. The account ID
 * stays the internal, random identifier that keys and records are bound to, so a username can
 * change without touching any encrypted data.
 */
import { username as usernameSchema } from '../schema/api.ts';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

export class UsernameError extends RangeError {
  constructor() {
    super(
      `A username has ${String(USERNAME_MIN_LENGTH)}–${String(USERNAME_MAX_LENGTH)} letters, digits, dots, dashes or underscores`,
    );
    this.name = 'UsernameError';
  }
}

/**
 * The form the server stores and compares: NFKC (full-width letters become ASCII), trimmed,
 * lowercase. Doesn't validate; see `parseUsername`.
 */
export function normalizeUsername(input: string): string {
  return input.normalize('NFKC').trim().toLowerCase();
}

/** Normalize and validate. Throws UsernameError. */
export function parseUsername(input: string): string {
  const value = normalizeUsername(input);
  if (!usernameSchema.safeParse(value).success) throw new UsernameError();
  return value;
}

export function isValidUsername(input: string): boolean {
  return usernameSchema.safeParse(normalizeUsername(input)).success;
}
