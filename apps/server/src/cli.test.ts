import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crypto as tzCrypto } from '@tazamun/core';
import { runCli, type CliIo } from './cli.ts';
import type { Config } from './config.ts';
import { DATABASE_FILE, Database } from './db/database.ts';
import { tokenHash } from './secrets.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-24T10:00:00Z');

function setup(options: { serverRunning?: boolean; createDb?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tazamun-cli-'));
  dirs.push(dataDir);
  const dbPath = join(dataDir, DATABASE_FILE);
  if (options.createDb ?? true) Database.open(dbPath).close();
  const out: string[] = [];
  const err: string[] = [];
  const fetched: string[] = [];
  const served: Config[] = [];
  let now = NOW;
  const io: CliIo = {
    env: {
      TAZAMUN_PUBLIC_URL: 'https://sync.example.org',
      TAZAMUN_DATA_DIR: dataDir,
      TAZAMUN_PORT: '8123',
    },
    readFile: () => {
      throw new Error('no files');
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => now,
    fetch: (url) => {
      fetched.push(url);
      return options.serverRunning
        ? Promise.resolve({ status: 200 })
        : Promise.reject(new Error('ECONNREFUSED'));
    },
    serve: (config) => served.push(config),
  };
  const run = (...argv: string[]) => runCli(argv, io);
  const withDb = <T>(fn: (db: Database) => T): T => {
    const db = Database.open(dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const addAccount = (id = tzCrypto.randomId()) =>
    withDb((db) => {
      db.createAccount(
        {
          id,
          salt: 'salt',
          kdfParams: { ...tzCrypto.DEFAULT_KDF_PARAMS },
          authHash: new Uint8Array(32),
          wrappedAccountKey: 'wrapped',
        },
        NOW,
      );
      db.push(id, 'tabs', [{ id: 'r', payload: 'x'.repeat(100), expiresAt: undefined }], NOW, 1e9);
      return id;
    });
  return {
    dataDir,
    dbPath,
    io,
    run,
    out: () => out.join(''),
    err: () => err.join(''),
    fetched,
    served,
    withDb,
    addAccount,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('tazamun (DEP-16)', () => {
  it('runs the server by default and with "serve"', async () => {
    const t = setup();
    expect(await t.run()).toBe('serving');
    expect(await t.run('serve')).toBe('serving');
    expect(t.served).toHaveLength(2);
    expect(t.served[0]?.port).toBe(8123);
  });

  it('prints the version without needing configuration', async () => {
    const t = setup();
    const code = await runCli(['version'], { ...t.io, env: {} });
    expect(code).toBe(0);
    expect(t.out()).toMatch(/^tazamun \d+\.\d+\.\d+ \(database schema \d+\)\n$/);
  });

  it('explains unknown commands and bad arguments with exit code 2', async () => {
    const t = setup();
    expect(await t.run('frobnicate')).toBe(2);
    expect(t.err()).toContain('Unknown command "frobnicate"');
    expect(t.err()).toContain('Usage: tazamun');
    expect(await t.run('invite', 'create', '--expires', 'soon')).toBe(2);
    expect(await t.run('invite', 'create', '--bogus')).toBe(2);
    expect(await t.run('version', 'extra')).toBe(2);
  });

  it('reports configuration errors with exit code 1', async () => {
    const t = setup();
    expect(await runCli(['accounts', 'list'], { ...t.io, env: {} })).toBe(1);
    expect(t.err()).toContain('TAZAMUN_PUBLIC_URL');
  });

  it('refuses admin commands before the database exists, without creating it', async () => {
    const t = setup({ createDb: false });
    expect(await t.run('accounts', 'list')).toBe(1);
    expect(t.err()).toContain('Start the server once');
    expect(existsSync(t.dbPath)).toBe(false);
  });

  it('refuses admin commands on a database the server has not migrated yet', async () => {
    const t = setup({ createDb: false });
    Database.open(t.dbPath, { migrations: [] }).close();
    expect(await t.run('invite', 'list')).toBe(1);
    expect(t.err()).toContain('Start the server once to migrate it');
  });
});

describe('healthcheck (DEP-6)', () => {
  it('exits 0 when the local server answers, 1 otherwise', async () => {
    expect(await setup({ serverRunning: true }).run('healthcheck')).toBe(0);
    const down = setup({ serverRunning: false });
    expect(await down.run('healthcheck')).toBe(1);
    expect(down.fetched).toEqual(['http://127.0.0.1:8123/v1/health']);
  });
});

describe('invite (ADM-2)', () => {
  it('creates a single-use token that expires after 7 days by default', async () => {
    const t = setup();
    expect(await t.run('invite', 'create')).toBe(0);
    const token = /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(t.out())?.[1];
    expect(token).toBeDefined();
    expect(t.out()).toContain('expires: 2026-12-01T10:00:00Z');
    const account = {
      id: tzCrypto.randomId(),
      salt: 's',
      kdfParams: { ...tzCrypto.DEFAULT_KDF_PARAMS },
      authHash: new Uint8Array(32),
      wrappedAccountKey: 'w',
    };
    const hash = tokenHash(token ?? '');
    expect(t.withDb((db) => db.createAccount(account, NOW, hash))).toBe('created');
    expect(
      t.withDb((db) => db.createAccount({ ...account, id: tzCrypto.randomId() }, NOW, hash)),
    ).toBe('invite-invalid');
  });

  it('lists invites with their status and revokes unused ones', async () => {
    const t = setup();
    await t.run('invite', 'create', '--expires', '1h');
    await t.run('invite', 'create', '--expires', 'never');
    const created = t.out();
    const ids = [...created.matchAll(/Invite (\S+) created/g)].map((m) => m[1] ?? '');
    const tokens = [...created.matchAll(/\n\n([A-Za-z0-9_-]{43})\n\n/g)].map((m) => m[1] ?? '');
    expect(tokens).toHaveLength(2);
    t.advance(2 * 3_600_000);
    expect(await t.run('invite', 'list')).toBe(0);
    const listing = t.out().slice(created.length);
    expect(listing).toMatch(new RegExp(`${ids[0] ?? ''}.*expired`));
    expect(listing).toMatch(new RegExp(`${ids[1] ?? ''}.*-\\s+unused`));
    // Tokens are shown once, at creation, never in a listing.
    for (const token of tokens) expect(listing).not.toContain(token);

    expect(await t.run('invite', 'revoke', ids[1] ?? '')).toBe(0);
    expect(await t.run('invite', 'revoke', ids[1] ?? '')).toBe(1);
    expect(t.withDb((db) => db.listInvites()).map((i) => i.id)).toEqual([ids[0]]);
  });
});

describe('backup and restore (DEP-25)', () => {
  it('backs up while the database is in use, and the copy passes integrity_check', async () => {
    const t = setup();
    const id = t.addAccount();
    const live = Database.open(t.dbPath); // stands in for the running server
    const file = join(t.dataDir, 'backups', 'manual.db');
    expect(await t.run('backup', file)).toBe(0);
    live.close();
    expect(t.out()).toContain(`Backup written to ${file}`);
    const copy = Database.open(file, { mode: 'inspect', readOnly: true });
    expect(copy.getAccount(id)).toBeDefined();
    copy.close();
  });

  it('refuses to back up onto the database itself', async () => {
    const t = setup();
    expect(await t.run('backup', t.dbPath)).toBe(1);
  });

  it('refuses to restore while the server is running', async () => {
    const t = setup({ serverRunning: true });
    const file = join(t.dataDir, 'b.db');
    await t.run('backup', file);
    expect(await t.run('restore', file)).toBe(1);
    expect(t.err()).toContain('Stop it before restoring');
  });

  it('restores a backup and keeps the replaced database (rule 6)', async () => {
    const t = setup();
    const before = t.addAccount();
    const file = join(t.dataDir, 'b.db');
    await t.run('backup', file);
    const after = t.addAccount();

    expect(await t.run('restore', file)).toBe(0);
    expect(
      t.withDb((db) => [db.getAccount(before) !== undefined, db.getAccount(after) !== undefined]),
    ).toEqual([true, false]);
    const safety = readdirSync(join(t.dataDir, 'backups')).find((f) =>
      f.startsWith('pre-restore-'),
    );
    expect(safety).toBeDefined();
    const saved = Database.open(join(t.dataDir, 'backups', safety ?? ''), {
      mode: 'inspect',
      readOnly: true,
    });
    expect(saved.getAccount(after)).toBeDefined();
    saved.close();
  });

  it('keeps seq moving forward across a restore, so devices miss no new records', async () => {
    const t = setup();
    const id = t.addAccount(); // seq 1
    const file = join(t.dataDir, 'b.db');
    await t.run('backup', file);
    t.withDb((db) => {
      for (let i = 0; i < 5; i++) {
        db.push(
          id,
          'tabs',
          [{ id: `n${String(i)}`, payload: 'p', expiresAt: undefined }],
          NOW,
          1e9,
        );
      }
    }); // seq 2…6, seen by devices
    expect(await t.run('restore', file)).toBe(0);
    const next = t.withDb((db) =>
      db.push(id, 'tabs', [{ id: 'new', payload: 'p', expiresAt: undefined }], NOW, 1e9),
    );
    expect(next.ok && next.seqs[0]?.seq).toBe(7);
  });

  it('refuses a file that is not an intact database and changes nothing', async () => {
    const t = setup();
    const id = t.addAccount();
    const file = join(t.dataDir, 'garbage.db');
    writeFileSync(file, 'this is not sqlite '.repeat(100));
    expect(await t.run('restore', file)).toBe(1);
    expect(t.err()).toContain('failed PRAGMA integrity_check');
    expect(t.withDb((db) => db.getAccount(id))).toBeDefined();
    expect(await t.run('restore', join(t.dataDir, 'missing.db'))).toBe(1);
  });
});

describe('migrate --status (ADM-4)', () => {
  it('reports missing, current and outdated databases', async () => {
    const none = setup({ createDb: false });
    expect(await none.run('migrate', '--status')).toBe(0);
    expect(none.out()).toContain('yet');

    const current = setup();
    await current.run('migrate', '--status');
    expect(current.out()).toContain('up to date');

    const old = setup({ createDb: false });
    Database.open(old.dbPath, { migrations: [] }).close();
    await old.run('migrate', '--status');
    expect(old.out()).toMatch(/schema version 0 of \d+, \d+ migration\(s\) pending/);
  });

  it('explains that migrations run on start when called without --status', async () => {
    expect(await setup().run('migrate')).toBe(2);
  });
});

describe('accounts', () => {
  it('lists metadata only', async () => {
    const t = setup();
    const id = t.addAccount();
    expect(await t.run('accounts', 'list')).toBe(0);
    expect(t.out()).toMatch(
      new RegExp(`${id}\\s+2026-11-24T10:00:00Z\\s+2026-11-24T10:00:00Z\\s+0\\s+101 B`),
    );
    expect(t.out()).not.toContain('x'.repeat(100));
  });

  it('deletes only with --yes, after a backup', async () => {
    const t = setup();
    const id = t.addAccount();
    expect(await t.run('accounts', 'delete', id)).toBe(2);
    expect(t.withDb((db) => db.getAccount(id))).toBeDefined();

    expect(await t.run('accounts', 'delete', id, '--yes')).toBe(0);
    expect(t.withDb((db) => db.getAccount(id))).toBeUndefined();
    const backup = readdirSync(join(t.dataDir, 'backups')).find((f) => f.startsWith('pre-delete-'));
    const copy = Database.open(join(t.dataDir, 'backups', backup ?? ''), {
      mode: 'inspect',
      readOnly: true,
    });
    expect(copy.getAccount(id)).toBeDefined();
    copy.close();

    expect(await t.run('accounts', 'delete', id, '--yes')).toBe(1);
  });
});
