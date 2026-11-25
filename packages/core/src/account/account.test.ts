import { describe, expect, it } from 'vitest';
import {
  PairingCodeError,
  ServerUrlError,
  estimateStrength,
  formatPairingCode,
  hostPermissionPattern,
  isPairingCode,
  normalizeServerUrl,
  parsePairingCode,
  passphraseLength,
} from './index.ts';

describe('normalizeServerUrl', () => {
  it.each([
    ['sync.example.org', 'https://sync.example.org'],
    ['  https://Sync.Example.org/  ', 'https://sync.example.org'],
    ['https://example.org:8443/tazamun/', 'https://example.org:8443/tazamun'],
    ['https://example.org:443', 'https://example.org'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    ['localhost:8080', 'http://localhost:8080'],
    ['127.0.0.1', 'http://127.0.0.1'],
    ['https://localhost:8443', 'https://localhost:8443'],
    ['localhost.example.org', 'https://localhost.example.org'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each([
    ['', 'invalid'],
    ['https://', 'invalid'],
    ['ftp://example.org', 'invalid'],
    ['http://example.org', 'insecure'],
    ['http://192.168.1.10:8080', 'insecure'],
    ['https://user:pw@example.org', 'credentials'],
    ['https://example.org/?a=1', 'query'],
    ['https://example.org/#x', 'query'],
  ])('rejects %j (%s)', (input, reason) => {
    expect(() => normalizeServerUrl(input)).toThrow(ServerUrlError);
    try {
      normalizeServerUrl(input);
    } catch (err) {
      expect((err as ServerUrlError).reason).toBe(reason);
    }
  });

  it('builds a host permission pattern without the port', () => {
    expect(hostPermissionPattern('https://example.org:8443/tz')).toBe('https://example.org/*');
    expect(hostPermissionPattern('http://localhost:8080')).toBe('http://localhost/*');
  });
});

describe('pairing codes (ACC-6)', () => {
  const accountId = 'q4FIt0kT1zxqI0Z9Jq2cXw';

  it('round-trips the server URL and account ID', () => {
    const code = formatPairingCode({ serverUrl: 'sync.example.org/', accountId });
    expect(code).toBe(`tazamun:${accountId}@https://sync.example.org`);
    expect(isPairingCode(code)).toBe(true);
    expect(parsePairingCode(`  ${code.slice(0, 20)}\n${code.slice(20)} `)).toEqual({
      serverUrl: 'https://sync.example.org',
      accountId,
    });
  });

  it('holds nothing but the server URL and account ID', () => {
    const code = formatPairingCode({ serverUrl: 'https://a.example', accountId });
    expect(code.length).toBe('tazamun:'.length + accountId.length + 1 + 'https://a.example'.length);
  });

  it.each([
    accountId,
    `tazamun:${accountId}`,
    `tazamun:short@https://a.example`,
    `tazamun:${accountId}@http://insecure.example`,
    `tazamun:${accountId}@`,
  ])('rejects %j', (input) => {
    expect(() => parsePairingCode(input)).toThrow(PairingCodeError);
  });
});

describe('passphrase strength (ACC-4)', () => {
  it('counts code points after NFC', () => {
    expect(passphraseLength('é')).toBe(1);
    expect(passphraseLength('😀😀')).toBe(2);
  });

  it('marks fewer than 12 characters as too short', () => {
    expect(estimateStrength('Tr0ub4dor&3')).toMatchObject({ tooShort: true, score: 0 });
    expect(estimateStrength('Tr0ub4dor&3x').tooShort).toBe(false);
  });

  it.each(['aaaaaaaaaaaa', '123456789012', 'password1234', 'qwertyuiopas', 'abababababab'])(
    'rates %j weak',
    (passphrase) => {
      expect(estimateStrength(passphrase).score).toBe(1);
    },
  );

  it.each(['correct horse battery staple', 'Kx7#mQ2!vR9$wL4@', 'mango tiger lamp ocean violet'])(
    'rates %j good or strong',
    (passphrase) => {
      expect(estimateStrength(passphrase).score).toBeGreaterThanOrEqual(3);
    },
  );

  it('rewards length', () => {
    const short = estimateStrength('mango tiger lamp');
    const long = estimateStrength('mango tiger lamp ocean violet');
    expect(long.bits).toBeGreaterThan(short.bits);
  });
});
