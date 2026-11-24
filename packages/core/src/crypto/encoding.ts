/** Byte encodings used on the wire (SRS 4.4.1: binary values are base64url without padding). */

const B64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Throws RangeError for anything that isn't unpadded base64url. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!B64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new RangeError('Not base64url');
  }
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (toBase64Url(bytes) !== value) {
    // Non-canonical encoding (stray bits in the last character). Reject, so every byte string
    // has exactly one representation.
    throw new RangeError('Not canonical base64url');
  }
  return bytes;
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Cryptographically secure random bytes (Web Crypto). */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}
