/**
 * The only module that touches `node:sqlite` (ADR-0004: the API is a release candidate in Node 26,
 * so a change, or a switch to better-sqlite3, must touch one place).
 *
 * One connection serves both reads and writes: node:sqlite is synchronous, so statements never
 * interleave. WAL mode, foreign keys on, every multi-statement write in a `BEGIN IMMEDIATE`
 * transaction (REL-4). `seq` is assigned inside the write transaction, so it has no gaps or
 * duplicates.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { schema } from '@tazamun/core';
import { MIGRATIONS } from './migrations.ts';

export const DATABASE_FILE = 'tazamun.db';
/** DEP-24: keep the last 3 pre-migration backups. */
const KEEP_PRE_MIGRATE_BACKUPS = 3;

export class DatabaseTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `The database has schema version ${String(found)}, but this server supports up to ${String(supported)}. ` +
        'Run a newer server, or restore the pre-migration backup from the backups directory.',
    );
    this.name = 'DatabaseTooNewError';
    this.found = found;
    this.supported = supported;
  }
}

export interface OpenOptions {
  /** Directory for pre-migration backups (DEP-24). Omit for in-memory test databases. */
  readonly backupDir?: string;
  /** Override for tests; defaults to the real migrations. */
  readonly migrations?: readonly string[];
  /** Called after each step of opening, for logging. */
  readonly onMigrate?: (from: number, to: number, backupPath: string | undefined) => void;
}

// ---- Row types -------------------------------------------------------------------------------

export interface AccountRow {
  readonly id: string;
  readonly salt: string;
  readonly kdfParams: schema.KdfParamsBody;
  readonly authHash: Uint8Array;
  readonly wrappedAccountKey: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly storageBytes: number;
}

export interface NewAccount {
  readonly id: string;
  readonly salt: string;
  readonly kdfParams: schema.KdfParamsBody;
  readonly authHash: Uint8Array;
  readonly wrappedAccountKey: string;
}

export interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly browserFamily: string;
  readonly browserVersion: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface NewDevice {
  readonly id: string;
  readonly name: string;
  readonly browserFamily: string;
  readonly browserVersion: string;
}

export interface SessionRow {
  readonly accountId: string;
  readonly deviceId: string;
  readonly lastUsedAt: number;
}

export interface InviteRow {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number | undefined;
  readonly usedAt: number | undefined;
}

export interface StoredRecord {
  readonly id: string;
  readonly seq: number;
  readonly modifiedAt: number;
  readonly expiresAt: number | undefined;
  readonly payload: string;
}

export interface IncomingRecord {
  readonly id: string;
  readonly payload: string;
  readonly expiresAt: number | undefined;
}

export type CreateAccountResult = 'created' | 'exists' | 'invite-invalid';
export type PushResult =
  | { readonly ok: true; readonly seqs: readonly { id: string; seq: number }[] }
  | { readonly ok: false; readonly reason: 'quota'; readonly usedBytes: number };

// ---- Helpers ---------------------------------------------------------------------------------

type Row = Record<string, unknown>;

function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== 'number') throw new TypeError(`Column ${key} is not a number`);
  return v;
}

function optNum(row: Row, key: string): number | undefined {
  const v = row[key];
  return v === null ? undefined : num(row, key);
}

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new TypeError(`Column ${key} is not a string`);
  return v;
}

function bytes(row: Row, key: string): Uint8Array {
  const v = row[key];
  if (!(v instanceof Uint8Array)) throw new TypeError(`Column ${key} is not a blob`);
  return v;
}

/** Bytes a record counts against the quota: its ID plus its ciphertext (both ASCII). */
export function recordSize(record: { id: string; payload: string }): number {
  return record.id.length + record.payload.length;
}

class Rollback extends Error {}

// ---- Database --------------------------------------------------------------------------------

export class Database {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Open (or create) the database at `path` and migrate it (ADM-4). Before migrating an existing
   * database, writes a consistent backup into `backupDir` (DEP-24). Refuses databases newer than
   * this server.
   */
  static open(path: string, options: OpenOptions = {}): Database {
    const migrations = options.migrations ?? MIGRATIONS;
    const raw = new DatabaseSync(path);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA synchronous = NORMAL');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('PRAGMA busy_timeout = 5000');
      const db = new Database(raw);
      db.#migrate(migrations, options);
      return db;
    } catch (err) {
      raw.close();
      throw err;
    }
  }

  /** Schema version of the open database. */
  get schemaVersion(): number {
    return num(this.#get('PRAGMA user_version') ?? {}, 'user_version');
  }

  #migrate(migrations: readonly string[], options: OpenOptions): void {
    const from = this.schemaVersion;
    const to = migrations.length;
    if (from > to) throw new DatabaseTooNewError(from, to);
    if (from === to) return;

    let backupPath: string | undefined;
    if (from > 0 && options.backupDir !== undefined) {
      backupPath = join(options.backupDir, `pre-migrate-${String(from)}-${String(to)}.db`);
      this.backupTo(backupPath);
      pruneBackups(options.backupDir, 'pre-migrate-', KEEP_PRE_MIGRATE_BACKUPS);
    }
    for (let version = from; version < to; version++) {
      this.transaction(() => {
        this.#db.exec(migrations[version] ?? '');
        this.#db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      });
    }
    options.onMigrate?.(from, to, backupPath);
  }

  /**
   * Consistent online copy with `VACUUM INTO` (DEP-25). Safe while the server is running: it
   * reads one snapshot of the database. Overwrites `path`.
   */
  backupTo(path: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    if (existsSync(path)) rmSync(path);
    this.#db.prepare('VACUUM INTO ?').run(path);
  }

  /** Checkpoint the WAL into the main file and close (DEP-7). */
  close(): void {
    if (!this.#db.isOpen) return;
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.#db.close();
  }

  /** Throws if the database can't answer a query (used by /v1/health). */
  ping(): void {
    this.#get('SELECT 1 AS ok');
  }

  /** Run `fn` in a `BEGIN IMMEDIATE` transaction. Rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (stmt === undefined) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#stmt(sql).get(...params);
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#stmt(sql).all(...params);
  }

  #run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#stmt(sql).run(...params).changes);
  }

  // ---- Accounts ------------------------------------------------------------------------------

  /**
   * Create an account. With `inviteHash`, the invite must exist, be unused and unexpired; it is
   * marked used in the same transaction, so one invite creates exactly one account.
   */
  createAccount(account: NewAccount, now: number, inviteHash?: Uint8Array): CreateAccountResult {
    try {
      return this.transaction(() => {
        if (this.#get('SELECT 1 AS x FROM accounts WHERE id = ?', account.id)) return 'exists';
        if (inviteHash !== undefined) {
          const used = this.#run(
            `UPDATE invites SET used_at = ?
             WHERE token_hash = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
            now,
            inviteHash,
            now,
          );
          if (used === 0) throw new Rollback();
        }
        this.#run(
          `INSERT INTO accounts (id, salt, kdf_params, auth_hash, wrapped_account_key, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          account.id,
          account.salt,
          JSON.stringify(account.kdfParams),
          account.authHash,
          account.wrappedAccountKey,
          now,
          now,
        );
        return 'created';
      });
    } catch (err) {
      if (err instanceof Rollback) return 'invite-invalid';
      throw err;
    }
  }

  getAccount(id: string): AccountRow | undefined {
    const row = this.#get('SELECT * FROM accounts WHERE id = ?', id);
    if (row === undefined) return undefined;
    return {
      id: str(row, 'id'),
      salt: str(row, 'salt'),
      kdfParams: JSON.parse(str(row, 'kdf_params')) as schema.KdfParamsBody,
      authHash: bytes(row, 'auth_hash'),
      wrappedAccountKey: str(row, 'wrapped_account_key'),
      createdAt: num(row, 'created_at'),
      lastSeenAt: num(row, 'last_seen_at'),
      storageBytes: num(row, 'storage_bytes'),
    };
  }

  /** ACC-10: deletes the account with every record, device and session (cascade). */
  deleteAccount(id: string): boolean {
    return this.transaction(() => {
      // Sessions reference devices, devices reference accounts; the cascade covers both.
      return this.#run('DELETE FROM accounts WHERE id = ?', id) > 0;
    });
  }

  /**
   * ACC-9: replace the key bundle after a passphrase change, and end every session except
   * `keepSessionHash` (the device that changed it).
   */
  updateKeys(accountId: string, keys: Omit<NewAccount, 'id'>, keepSessionHash: Uint8Array): void {
    this.transaction(() => {
      this.#run(
        `UPDATE accounts SET salt = ?, kdf_params = ?, auth_hash = ?, wrapped_account_key = ?
         WHERE id = ?`,
        keys.salt,
        JSON.stringify(keys.kdfParams),
        keys.authHash,
        keys.wrappedAccountKey,
        accountId,
      );
      this.#run(
        'DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?',
        accountId,
        keepSessionHash,
      );
    });
  }

  // ---- Invites -------------------------------------------------------------------------------

  createInvite(id: string, tokenHash: Uint8Array, now: number, expiresAt?: number): void {
    this.#run(
      'INSERT INTO invites (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
      id,
      tokenHash,
      now,
      expiresAt ?? null,
    );
  }

  listInvites(): InviteRow[] {
    return this.#all(
      'SELECT id, created_at, expires_at, used_at FROM invites ORDER BY created_at',
    ).map((row) => ({
      id: str(row, 'id'),
      createdAt: num(row, 'created_at'),
      expiresAt: optNum(row, 'expires_at'),
      usedAt: optNum(row, 'used_at'),
    }));
  }

  revokeInvite(id: string): boolean {
    return this.#run('DELETE FROM invites WHERE id = ?', id) > 0;
  }

  // ---- Devices and sessions ------------------------------------------------------------------

  /**
   * Sign a device in (ACC-7, ACC-8): register or update the device and replace any session it
   * had, so each device holds exactly one token.
   */
  createSession(
    accountId: string,
    device: NewDevice,
    tokenHash: Uint8Array,
    now: number,
  ): DeviceRow {
    return this.transaction(() => {
      this.#run(
        `INSERT INTO devices (account_id, id, name, browser_family, browser_version, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, id) DO UPDATE SET
           browser_family = excluded.browser_family,
           browser_version = excluded.browser_version,
           last_seen_at = excluded.last_seen_at`,
        accountId,
        device.id,
        device.name,
        device.browserFamily,
        device.browserVersion,
        now,
        now,
      );
      this.#run(
        'DELETE FROM sessions WHERE account_id = ? AND device_id = ?',
        accountId,
        device.id,
      );
      this.#run(
        `INSERT INTO sessions (token_hash, account_id, device_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
        tokenHash,
        accountId,
        device.id,
        now,
        now,
      );
      this.#run('UPDATE accounts SET last_seen_at = ? WHERE id = ?', now, accountId);
      const row = this.getDevice(accountId, device.id);
      if (row === undefined) throw new Error('Device vanished inside its own transaction');
      return row;
    });
  }

  findSession(tokenHash: Uint8Array): SessionRow | undefined {
    const row = this.#get(
      'SELECT account_id, device_id, last_used_at FROM sessions WHERE token_hash = ?',
      tokenHash,
    );
    if (row === undefined) return undefined;
    return {
      accountId: str(row, 'account_id'),
      deviceId: str(row, 'device_id'),
      lastUsedAt: num(row, 'last_used_at'),
    };
  }

  /** Record activity for a session, its device and its account. */
  touchSession(tokenHash: Uint8Array, session: SessionRow, now: number): void {
    this.transaction(() => {
      this.#run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', now, tokenHash);
      this.#run(
        'UPDATE devices SET last_seen_at = ? WHERE account_id = ? AND id = ?',
        now,
        session.accountId,
        session.deviceId,
      );
      this.#run('UPDATE accounts SET last_seen_at = ? WHERE id = ?', now, session.accountId);
    });
  }

  deleteSession(tokenHash: Uint8Array): void {
    this.#run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  getDevice(accountId: string, id: string): DeviceRow | undefined {
    const row = this.#get('SELECT * FROM devices WHERE account_id = ? AND id = ?', accountId, id);
    return row === undefined ? undefined : deviceRow(row);
  }

  listDevices(accountId: string): DeviceRow[] {
    return this.#all(
      'SELECT * FROM devices WHERE account_id = ? ORDER BY created_at, id',
      accountId,
    ).map(deviceRow);
  }

  renameDevice(accountId: string, id: string, name: string): boolean {
    return (
      this.#run(
        'UPDATE devices SET name = ? WHERE account_id = ? AND id = ?',
        name,
        accountId,
        id,
      ) > 0
    );
  }

  /** Revoke a device (ACC-8): its session ends immediately (cascade). */
  deleteDevice(accountId: string, id: string): boolean {
    return this.#run('DELETE FROM devices WHERE account_id = ? AND id = ?', accountId, id) > 0;
  }

  // ---- Records -------------------------------------------------------------------------------

  /**
   * Batch upsert (ADR-0003, REL-4). Every record gets the next `seq` of the account, in order.
   * The whole batch is stored, or none of it: if it would take the account over `quotaBytes`,
   * nothing is written. Batches that shrink storage are always accepted, so an account over its
   * quota can still replace records with tombstones.
   */
  push(
    accountId: string,
    collection: string,
    records: readonly IncomingRecord[],
    now: number,
    quotaBytes: number,
  ): PushResult {
    let result: PushResult | undefined;
    try {
      this.transaction(() => {
        const account = this.#get(
          'SELECT last_seq, storage_bytes FROM accounts WHERE id = ?',
          accountId,
        );
        if (account === undefined) throw new Error('Account vanished during push');
        let seq = num(account, 'last_seq');
        const before = num(account, 'storage_bytes');
        let delta = 0;
        const seqs: { id: string; seq: number }[] = [];

        for (const record of records) {
          const old = this.#get(
            'SELECT size FROM records WHERE account_id = ? AND collection = ? AND id = ?',
            accountId,
            collection,
            record.id,
          );
          const size = recordSize(record);
          delta += size - (old === undefined ? 0 : num(old, 'size'));
          seq += 1;
          this.#run(
            `INSERT INTO records (account_id, collection, id, seq, modified_at, expires_at, payload, size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (account_id, collection, id) DO UPDATE SET
               seq = excluded.seq,
               modified_at = excluded.modified_at,
               expires_at = excluded.expires_at,
               payload = excluded.payload,
               size = excluded.size`,
            accountId,
            collection,
            record.id,
            seq,
            now,
            record.expiresAt ?? null,
            record.payload,
            size,
          );
          seqs.push({ id: record.id, seq });
        }

        if (delta > 0 && before + delta > quotaBytes) {
          result = { ok: false, reason: 'quota', usedBytes: before };
          throw new Rollback();
        }
        this.#run(
          'UPDATE accounts SET last_seq = ?, storage_bytes = storage_bytes + ? WHERE id = ?',
          seq,
          delta,
          accountId,
        );
        result = { ok: true, seqs };
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    if (result === undefined) throw new Error('Push finished without a result');
    return result;
  }

  /**
   * Incremental pull (ENG-6): records with `seq > since`, in `seq` order, skipping expired ones.
   * Returns at most `limit` records and stops early once `maxBytes` of payload is reached (but
   * always returns at least one record if there is one), so responses stay bounded.
   */
  pull(
    accountId: string,
    collection: string,
    since: number,
    limit: number,
    maxBytes: number,
    now: number,
  ): { records: StoredRecord[]; more: boolean } {
    const rows = this.#all(
      `SELECT id, seq, modified_at, expires_at, payload FROM records
       WHERE account_id = ? AND collection = ? AND seq > ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY seq LIMIT ?`,
      accountId,
      collection,
      since,
      now,
      limit + 1,
    );
    const records: StoredRecord[] = [];
    let total = 0;
    for (const row of rows.slice(0, limit)) {
      const payload = str(row, 'payload');
      if (records.length > 0 && total + payload.length > maxBytes) break;
      total += payload.length;
      records.push({
        id: str(row, 'id'),
        seq: num(row, 'seq'),
        modifiedAt: num(row, 'modified_at'),
        expiresAt: optNum(row, 'expires_at'),
        payload,
      });
    }
    return { records, more: records.length < rows.length };
  }

  /** High-water `seq` per collection that has records (for /v1/info). */
  highWater(accountId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.#all(
      'SELECT collection, MAX(seq) AS seq FROM records WHERE account_id = ? GROUP BY collection',
      accountId,
    )) {
      out[str(row, 'collection')] = num(row, 'seq');
    }
    return out;
  }

  /** Delete records whose `expiresAt` has passed and release their storage. Returns the count. */
  purgeExpired(now: number): number {
    return this.transaction(() => {
      const freed = this.#all(
        `SELECT account_id, SUM(size) AS bytes FROM records
         WHERE expires_at IS NOT NULL AND expires_at <= ? GROUP BY account_id`,
        now,
      );
      for (const row of freed) {
        this.#run(
          'UPDATE accounts SET storage_bytes = storage_bytes - ? WHERE id = ?',
          num(row, 'bytes'),
          str(row, 'account_id'),
        );
      }
      return this.#run('DELETE FROM records WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
    });
  }
}

function deviceRow(row: Row): DeviceRow {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    browserFamily: str(row, 'browser_family'),
    browserVersion: str(row, 'browser_version'),
    createdAt: num(row, 'created_at'),
    lastSeenAt: num(row, 'last_seen_at'),
  };
}

/** Keep the newest `keep` files in `dir` whose names start with `prefix`. */
function pruneBackups(dir: string, prefix: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    // Newest first; names (which hold the versions) break ties between files from the same instant.
    .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path, 'en', { numeric: true }));
  for (const file of files.slice(keep)) rmSync(file.path);
}
