import { describe, expect, it } from 'vitest';
import {
  ServerUrlError,
  UsernameError,
  estimateStrength,
  hostPermissionPattern,
  isValidUsername,
  normalizeServerUrl,
  parseUsername,
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

describe('usernames (ACC-13)', () => {
  it.each([
    ['hasan', 'hasan'],
    ['  Hasan.D ', 'hasan.d'],
    ['ｈａｓａｎ', 'hasan'],
    ['a_b-c.9', 'a_b-c.9'],
    ['abc', 'abc'],
    ['a'.repeat(32), 'a'.repeat(32)],
  ])('%j → %j', (input, expected) => {
    expect(parseUsername(input)).toBe(expected);
    expect(isValidUsername(input)).toBe(true);
  });

  it.each(['', 'ab', 'a'.repeat(33), '.abc', 'abc-', 'ha san', 'hasän', 'hаsan', 'a@b', 'a/b'])(
    'rejects %j',
    (input) => {
      expect(() => parseUsername(input)).toThrow(UsernameError);
      expect(isValidUsername(input)).toBe(false);
    },
  );
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
