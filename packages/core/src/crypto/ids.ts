/** Keyed record IDs (HIS-1): the same input gives the same ID on every device of an account. */
import { toBase64Url, utf8 } from './encoding.ts';

/** HIS-1: HMAC output is truncated to 128 bits (22 base64url characters). */
export const KEYED_ID_BYTES = 16;

/**
 * `base64url(HMAC-SHA256(idKey, input)[0..16])`. For history, `input` is the normalized URL
 * (P2). Without the key, the server can't link an ID to a URL.
 */
export async function keyedId(idKey: CryptoKey, input: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', idKey, utf8(input));
  return toBase64Url(new Uint8Array(mac, 0, KEYED_ID_BYTES));
}
