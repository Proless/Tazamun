import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crypto as tzCrypto } from '@tazamun/core';
import { Database, DatabaseTooNewError } from './database.ts';
import { MIGRATIONS } from './migrations.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tazamun-db-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withAccount(db: Database, id = 'acct'): string {
  db.createAccount(
    {
      id,
      username: id
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '0')
        .padEnd(3, '0'),
      salt: 'salt',
      kdfParams: { ...tzCrypto.DEFAULT_KDF_PARAMS },
      authHash: new Uint8Array(32),
      wrappedAccountKey: 'wrapped',
      recovery: { authHash: new Uint8Array(32), wrappedAccountKey: 'r' },
    },
    0,
  );
  return id;
}

describe('migrations (ADM-4)', () => {
  it('creates a new database at the latest schema version', () => {
    const db = Database.open(':memory:');
    expect(db.schemaVersion).toBe(MIGRATIONS.length);
    db.close();
  });

  it('refuses a database newer than the server', () => {
    const path = join(tempDir(), 'db.sqlite');
    Database.open(path, { migrations: ['CREATE TABLE a (x)', 'CREATE TABLE b (x)'] }).close();
    expect(() => Database.open(path, { migrations: ['CREATE TABLE a (x)'] })).toThrow(
      DatabaseTooNewError,
    );
  });

  it('backs up an existing database before migrating and keeps the last 3 backups (DEP-24)', () => {
    const dir = tempDir();
    const path = join(dir, 'db.sqlite');
    const backupDir = join(dir, 'backups');
    const steps = [
      'CREATE TABLE t1 (x)',
      'CREATE TABLE t2 (x)',
      'CREATE TABLE t3 (x)',
      'CREATE TABLE t4 (x)',
      'CREATE TABLE t5 (x)',
    ];

    // A brand-new database has nothing to back up.
    Database.open(path, { migrations: steps.slice(0, 1), backupDir }).close();
    expect(existsSync(backupDir)).toBe(false);

    for (let n = 2; n <= 5; n++)
      Database.open(path, { migrations: steps.slice(0, n), backupDir }).close();
    expect(readdirSync(backupDir).sort()).toEqual([
      'pre-migrate-2-3.db',
      'pre-migrate-3-4.db',
      'pre-migrate-4-5.db',
    ]);
    // The backup holds the old version, so downgrading means restoring it.
    const old = Database.open(join(backupDir, 'pre-migrate-4-5.db'), {
      migrations: steps.slice(0, 4),
    });
    expect(old.schemaVersion).toBe(4);
    old.close();
  });

  it('rolls back a failing migration and leaves the version unchanged', () => {
    const path = join(tempDir(), 'db.sqlite');
    Database.open(path, { migrations: ['CREATE TABLE a (x)'] }).close();
    expect(() =>
      Database.open(path, {
        migrations: ['CREATE TABLE a (x)', 'CREATE TABLE b (x); SYNTAX ERROR'],
      }),
    ).toThrow();
    const db = Database.open(path, { migrations: ['CREATE TABLE a (x)'] });
    expect(db.schemaVersion).toBe(1);
    db.close();
  });

  it('keeps accounts from before usernames, which then set one (migration 2, ACC-13)', () => {
    const path = join(tempDir(), 'db.sqlite');
    Database.open(path, { migrations: MIGRATIONS.slice(0, 1) }).close();
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        `INSERT INTO accounts (id, salt, kdf_params, auth_hash, wrapped_account_key, created_at, last_seen_at)
         VALUES ('old', 's', ?, ?, 'w', 0, 0)`,
      )
      .run(JSON.stringify(tzCrypto.DEFAULT_KDF_PARAMS), new Uint8Array(32));
    raw.close();

    const db = Database.open(path);
    expect(db.schemaVersion).toBe(MIGRATIONS.length);
    const old = db.getAccount('old');
    expect(old).toMatchObject({ id: 'old', username: undefined, recovery: undefined });
    expect(db.setUsername('old', 'hasan')).toBe(true);
    withAccount(db, 'new');
    expect(db.setUsername('new', 'hasan')).toBe(false);
    expect(db.getAccountByUsername('hasan')?.id).toBe('old');
    db.close();
  });
});

describe('records', () => {
  it('assigns seq per account across collections, and keeps it monotonic after deletions', () => {
    const db = Database.open(':memory:');
    const a = withAccount(db, 'a');
    const b = withAccount(db, 'b');
    const push = (account: string, collection: string, id: string, expiresAt?: number) => {
      const r = db.push(account, collection, [{ id, payload: 'p', expiresAt }], 0, 1e9);
      if (!r.ok) throw new Error('push failed');
      return r.seqs[0]?.seq;
    };
    expect(push(a, 'tabs', 'x')).toBe(1);
    expect(push(a, 'history', 'y', 10)).toBe(2);
    expect(push(b, 'tabs', 'x')).toBe(1);
    db.purgeExpired(10);
    expect(push(a, 'history', 'z')).toBe(3);
    expect(db.highWater(a)).toEqual({ tabs: 1, history: 3 });
  });

  it('caps a pull page by bytes but always returns at least one record', () => {
    const db = Database.open(':memory:');
    const a = withAccount(db);
    db.push(
      a,
      'c',
      [
        { id: '1', payload: 'x'.repeat(60), expiresAt: undefined },
        { id: '2', payload: 'x'.repeat(60), expiresAt: undefined },
      ],
      0,
      1e9,
    );
    const page = db.pull(a, 'c', 0, 500, 100, 0);
    expect(page.records.map((r) => r.id)).toEqual(['1']);
    expect(page.more).toBe(true);
    const tiny = db.pull(a, 'c', 0, 500, 1, 0);
    expect(tiny.records).toHaveLength(1);
  });

  it('keeps storage accounting exact through overwrites and expiry', () => {
    const db = Database.open(':memory:');
    const a = withAccount(db);
    db.push(a, 'c', [{ id: 'r1', payload: 'x'.repeat(100), expiresAt: 5 }], 0, 1e9);
    db.push(a, 'c', [{ id: 'r2', payload: 'x'.repeat(50), expiresAt: undefined }], 0, 1e9);
    expect(db.getAccount(a)?.storageBytes).toBe(102 + 52);
    db.push(a, 'c', [{ id: 'r2', payload: 'x'.repeat(10), expiresAt: undefined }], 0, 1e9);
    expect(db.getAccount(a)?.storageBytes).toBe(102 + 12);
    expect(db.purgeExpired(5)).toBe(1);
    expect(db.getAccount(a)?.storageBytes).toBe(12);
  });

  it('deleting an account removes its records, devices and sessions', () => {
    const db = Database.open(':memory:');
    const a = withAccount(db);
    db.createSession(
      a,
      { id: 'd', name: 'n', browserFamily: 'f', browserVersion: '1' },
      new Uint8Array(32).fill(1),
      0,
    );
    db.push(a, 'c', [{ id: 'r', payload: 'p', expiresAt: undefined }], 0, 1e9);
    expect(db.deleteAccount(a)).toBe(true);
    expect(db.findSession(new Uint8Array(32).fill(1))).toBeUndefined();
    const other = withAccount(db);
    expect(db.pull(other, 'c', 0, 10, 1e6, 0).records).toEqual([]);
  });
});

describe('data generation (ENG-16)', () => {
  it('has one from the start and keeps it across restarts', () => {
    const path = join(tempDir(), 'db.sqlite');
    const db = Database.open(path);
    const first = db.generation();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    db.close();
    const again = Database.open(path);
    expect(again.generation()).toBe(first);
    again.close();
  });

  it('gets a new one when a backup is restored', () => {
    const dir = tempDir();
    const path = join(dir, 'live.db');
    const db = Database.open(path);
    withAccount(db);
    const before = db.generation();
    db.backupTo(join(dir, 'backup.db'));
    db.close();
    Database.restore(path, join(dir, 'backup.db'), join(dir, 'safety.db'));
    const restored = Database.open(path);
    expect(restored.generation()).toMatch(/^[0-9a-f]{32}$/);
    expect(restored.generation()).not.toBe(before);
    restored.close();
  });

  it('gets one when a database from before migration 3 is upgraded', () => {
    const path = join(tempDir(), 'db.sqlite');
    Database.open(path, { migrations: MIGRATIONS.slice(0, 2) }).close();
    const db = Database.open(path);
    expect(db.generation()).toMatch(/^[0-9a-f]{32}$/);
    db.close();
  });
});

describe('backupTo (DEP-25)', () => {
  it('writes a consistent copy that opens on its own', () => {
    const dir = tempDir();
    const db = Database.open(join(dir, 'live.db'));
    const a = withAccount(db);
    db.push(a, 'c', [{ id: 'r', payload: 'p', expiresAt: undefined }], 0, 1e9);
    const copy = join(dir, 'copy', 'backup.db');
    db.backupTo(copy);
    db.backupTo(copy); // overwrites
    db.close();
    const restored = Database.open(copy);
    expect(restored.pull(a, 'c', 0, 10, 1e6, 0).records.map((r) => r.id)).toEqual(['r']);
    restored.close();
  });
});
