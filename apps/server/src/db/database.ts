/**
 * The only module that touches `node:sqlite` (ADR-0004: the API is a release candidate in Node 26,
 * so a change, or a switch to better-sqlite3, must touch one place).
 *
 * One connection serves both reads and writes: node:sqlite is synchronous, so statements never
 * interleave. WAL mode, foreign keys on, every multi-statement write in a `BEGIN IMMEDIATE`
 * transaction (REL-4). `seq` is assigned inside the write transaction, so it has no gaps or
 * duplicates.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { schema } from '@tazamun/core';
import { GENERATION_SINCE_VERSION, MIGRATIONS } from './migrations.ts';

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

/** A backup to restore failed `PRAGMA integrity_check`. */
export class BackupInvalidError extends Error {
  constructor(path: string) {
    super(`The backup at ${path} failed PRAGMA integrity_check; nothing was changed.`);
    this.name = 'BackupInvalidError';
  }
}

/** An admin command found a database that the server hasn't migrated yet. */
export class DatabaseNotMigratedError extends Error {
  readonly found: number;
  readonly expected: number;

  constructor(found: number, expected: number) {
    super(
      `The database has schema version ${String(found)}, but this version of Tazamun expects ${String(expected)}. ` +
        'Start the server once to migrate it, then run this command again.',
    );
    this.name = 'DatabaseNotMigratedError';
    this.found = found;
    this.expected = expected;
  }
}

/**
 * What `Database.open` does about the schema version:
 * - `migrate` (the server): migrate to the latest version, refuse newer databases.
 * - `require-current` (admin commands): refuse anything but the latest version, never migrate,
 *   so a CLI never changes the schema under a running server.
 * - `inspect` (`migrate --status`): open any version as it is.
 */
export type OpenMode = 'migrate' | 'require-current' | 'inspect';

export interface OpenOptions {
  /** Default `migrate`. */
  readonly mode?: OpenMode;
  /**
   * Open without writing anything: no WAL switch, no checkpoint on close. Use it for files that
   * must stay untouched, such as a backup being verified. Implies a mode other than `migrate`.
   */
  readonly readOnly?: boolean;
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
  readonly username: string | undefined;
  readonly salt: string;
  readonly kdfParams: schema.KdfParamsBody;
  readonly authHash: Uint8Array;
  readonly wrappedAccountKey: string;
  readonly recovery: RecoverySecrets | undefined;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly storageBytes: number;
}

/** ACC-5: what the server keeps for the recovery key. */
export interface RecoverySecrets {
  readonly authHash: Uint8Array;
  readonly wrappedAccountKey: string;
}

export interface AccountSummary {
  readonly id: string;
  readonly username: string | undefined;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly storageBytes: number;
  readonly devices: number;
}

/** The passphrase-derived part of an account (ACC-3); replaced on a passphrase change. */
export interface PassphraseSecrets {
  readonly salt: string;
  readonly kdfParams: schema.KdfParamsBody;
  readonly authHash: Uint8Array;
  readonly wrappedAccountKey: string;
}

export interface NewAccount extends PassphraseSecrets {
  readonly id: string;
  readonly username: string;
  readonly recovery: RecoverySecrets;
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

export type CreateAccountResult = 'created' | 'exists' | 'username-taken' | 'invite-invalid';
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

function optStr(row: Row, key: string): string | undefined {
  const v = row[key];
  return v === null ? undefined : str(row, key);
}

function optBytes(row: Row, key: string): Uint8Array | undefined {
  const v = row[key];
  return v === null ? undefined : bytes(row, key);
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
  readonly #readOnly: boolean;

  private constructor(db: DatabaseSync, readOnly: boolean) {
    this.#db = db;
    this.#readOnly = readOnly;
  }

  /**
   * Open (or create) the database at `path` and migrate it (ADM-4). Before migrating an existing
   * database, writes a consistent backup into `backupDir` (DEP-24). Refuses databases newer than
   * this server.
   */
  static open(path: string, options: OpenOptions = {}): Database {
    const migrations = options.migrations ?? MIGRATIONS;
    const readOnly = options.readOnly ?? false;
    const mode = options.mode ?? 'migrate';
    if (readOnly && mode === 'migrate') throw new RangeError('A read-only database cannot migrate');
    const raw = new DatabaseSync(path, { readOnly });
    try {
      if (!readOnly) {
        raw.exec('PRAGMA journal_mode = WAL');
        raw.exec('PRAGMA synchronous = NORMAL');
        raw.exec('PRAGMA foreign_keys = ON');
      }
      raw.exec('PRAGMA busy_timeout = 5000');
      const db = new Database(raw, readOnly);
      if (mode === 'migrate') {
        db.#migrate(migrations, options);
      } else if (mode === 'require-current') {
        const version = db.schemaVersion;
        if (version > migrations.length) throw new DatabaseTooNewError(version, migrations.length);
        if (version < migrations.length) {
          throw new DatabaseNotMigratedError(version, migrations.length);
        }
      }
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
    if (!this.#readOnly) this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.#db.close();
  }

  /** `PRAGMA integrity_check`: true when SQLite reports `ok` (DEP-25). */
  integrityOk(): boolean {
    const rows = this.#all('PRAGMA integrity_check');
    return rows.length === 1 && rows[0]?.['integrity_check'] === 'ok';
  }

  /**
   * Replace the database file at `dbPath` with the backup at `backupPath` (DEP-25). The server
   * must be stopped. The backup must pass `integrity_check` and have a schema version this server
   * supports. The current database is first copied to `safetyCopyPath`, so a restore never
   * destroys data without a recoverable copy (rule 6). Returns the backup's schema version.
   */
  static restore(dbPath: string, backupPath: string, safetyCopyPath: string): number {
    const version = Database.#verifyBackup(backupPath);
    let seqFloors: Row[] = [];
    if (existsSync(dbPath)) {
      const current = Database.open(dbPath, { mode: 'inspect', readOnly: true });
      try {
        current.backupTo(safetyCopyPath);
        if (current.schemaVersion > 0)
          seqFloors = current.#all('SELECT id, last_seq FROM accounts');
      } finally {
        current.close();
      }
    }
    // The WAL and shared-memory files belong to the old database; a stale WAL would be replayed
    // into the restored file.
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    copyFileSync(backupPath, dbPath);

    // `seq` must never go backwards (ADR-0003): devices have pulled up to the replaced database's
    // counters, and would skip new records numbered below them. Keep each account's counter at
    // least as high as it was. And give the data a new generation (ENG-16), so devices notice that
    // records went back to older versions and push theirs again. A backup from before
    // `server_meta` gets a fresh generation when the server migrates it.
    if (version > 0) {
      const restored = Database.open(dbPath, { mode: 'inspect' });
      try {
        restored.transaction(() => {
          for (const row of seqFloors) {
            restored.#run(
              'UPDATE accounts SET last_seq = MAX(last_seq, ?) WHERE id = ?',
              num(row, 'last_seq'),
              str(row, 'id'),
            );
          }
          if (version >= GENERATION_SINCE_VERSION) {
            restored.#run(
              "UPDATE server_meta SET value = lower(hex(randomblob(16))) WHERE key = 'generation'",
            );
          }
        });
      } finally {
        restored.close();
      }
    }
    return version;
  }

  /**
   * The schema version of a backup file, after checking it. Anything that isn't an intact SQLite
   * database (a truncated copy, the wrong file) is a BackupInvalidError.
   */
  static #verifyBackup(path: string): number {
    let backup: Database | undefined;
    try {
      backup = Database.open(path, { mode: 'inspect', readOnly: true });
      if (!backup.integrityOk()) throw new BackupInvalidError(path);
      const version = backup.schemaVersion;
      if (version > MIGRATIONS.length) throw new DatabaseTooNewError(version, MIGRATIONS.length);
      return version;
    } catch (err) {
      if (err instanceof BackupInvalidError || err instanceof DatabaseTooNewError) throw err;
      throw new BackupInvalidError(path);
    } finally {
      backup?.close();
    }
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
        if (this.#get('SELECT 1 AS x FROM accounts WHERE username = ?', account.username)) {
          return 'username-taken';
        }
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
          `INSERT INTO accounts (id, username, salt, kdf_params, auth_hash, wrapped_account_key,
                                 recovery_auth_hash, recovery_wrapped_account_key, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          account.id,
          account.username,
          account.salt,
          JSON.stringify(account.kdfParams),
          account.authHash,
          account.wrappedAccountKey,
          account.recovery.authHash,
          account.recovery.wrappedAccountKey,
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
    return row === undefined ? undefined : accountRow(row);
  }

  /** ACC-13: look an account up by its (normalized) username. */
  getAccountByUsername(username: string): AccountRow | undefined {
    const row = this.#get('SELECT * FROM accounts WHERE username = ?', username);
    return row === undefined ? undefined : accountRow(row);
  }

  /** ACC-13: set or change the username. `false` if another account has it. */
  setUsername(accountId: string, username: string): boolean {
    return this.transaction(() => {
      const owner = this.#get('SELECT id FROM accounts WHERE username = ?', username);
      if (owner !== undefined) return str(owner, 'id') === accountId;
      this.#run('UPDATE accounts SET username = ? WHERE id = ?', username, accountId);
      return true;
    });
  }

  /** ACC-5: set or replace the recovery key. */
  setRecovery(accountId: string, recovery: RecoverySecrets): void {
    this.#run(
      'UPDATE accounts SET recovery_auth_hash = ?, recovery_wrapped_account_key = ? WHERE id = ?',
      recovery.authHash,
      recovery.wrappedAccountKey,
      accountId,
    );
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
  updateKeys(
    accountId: string,
    keys: PassphraseSecrets,
    keepSessionHash: Uint8Array | undefined,
  ): void {
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
      // Without a session to keep (recovery, ACC-5), every session ends.
      this.#run(
        'DELETE FROM sessions WHERE account_id = ? AND token_hash IS NOT ?',
        accountId,
        keepSessionHash ?? null,
      );
    });
  }

  /** ENG-16: the data generation; changes on every restore. */
  generation(): string {
    const row = this.#get("SELECT value FROM server_meta WHERE key = 'generation'");
    return row === undefined ? '' : str(row, 'value');
  }

  /** Metadata of every account, for `tazamun accounts list` (DEP-16). Never content. */
  listAccounts(): AccountSummary[] {
    return this.#all(
      `SELECT a.id, a.username, a.created_at, a.last_seen_at, a.storage_bytes,
              (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS devices
       FROM accounts a ORDER BY a.created_at, a.id`,
    ).map((row) => ({
      id: str(row, 'id'),
      username: optStr(row, 'username'),
      createdAt: num(row, 'created_at'),
      lastSeenAt: num(row, 'last_seen_at'),
      storageBytes: num(row, 'storage_bytes'),
      devices: num(row, 'devices'),
    }));
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

function accountRow(row: Row): AccountRow {
  const recoveryHash = optBytes(row, 'recovery_auth_hash');
  const recoveryWrapped = optStr(row, 'recovery_wrapped_account_key');
  return {
    id: str(row, 'id'),
    username: optStr(row, 'username'),
    salt: str(row, 'salt'),
    kdfParams: JSON.parse(str(row, 'kdf_params')) as schema.KdfParamsBody,
    authHash: bytes(row, 'auth_hash'),
    wrappedAccountKey: str(row, 'wrapped_account_key'),
    recovery:
      recoveryHash === undefined || recoveryWrapped === undefined
        ? undefined
        : { authHash: recoveryHash, wrappedAccountKey: recoveryWrapped },
    createdAt: num(row, 'created_at'),
    lastSeenAt: num(row, 'last_seen_at'),
    storageBytes: num(row, 'storage_bytes'),
  };
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
export function pruneBackups(dir: string, prefix: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    // Newest first; names (which hold the versions) break ties between files from the same instant.
    .sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path, 'en', { numeric: true }));
  for (const file of files.slice(keep)) rmSync(file.path);
}
