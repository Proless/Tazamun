import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTANCE_SECRET_FILE, fakeSalt, hashesEqual, loadInstanceSecret } from './secrets.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadInstanceSecret (DEP-11)', () => {
  it('generates a secret once and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tazamun-secret-'));
    dirs.push(dir);
    const first = loadInstanceSecret(dir, undefined);
    const second = loadInstanceSecret(dir, undefined);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(second).toEqual(first);
    expect(readFileSync(join(dir, INSTANCE_SECRET_FILE), 'utf8').trim()).toBe(
      new TextDecoder().decode(first),
    );
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, INSTANCE_SECRET_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it('prefers the configured secret', () => {
    expect(new TextDecoder().decode(loadInstanceSecret('/nonexistent', 'configured'))).toBe(
      'configured',
    );
  });
});

describe('fakeSalt (SEC-9)', () => {
  it('is stable per account and instance, and looks like a real salt', () => {
    const a = new TextEncoder().encode('secret-a');
    const b = new TextEncoder().encode('secret-b');
    expect(fakeSalt(a, 'id1')).toBe(fakeSalt(a, 'id1'));
    expect(fakeSalt(a, 'id1')).not.toBe(fakeSalt(a, 'id2'));
    expect(fakeSalt(a, 'id1')).not.toBe(fakeSalt(b, 'id1'));
    expect(fakeSalt(a, 'id1')).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('hashesEqual', () => {
  it('compares contents and treats different lengths as unequal', () => {
    expect(hashesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(hashesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(hashesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
