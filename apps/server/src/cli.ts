/**
 * The `tazamun` command (DEP-16): `serve` (the default) plus the admin commands. Admin commands
 * read the same configuration as the server, so `docker compose exec tazamun tazamun …` works
 * without extra flags.
 *
 * Output is for people. It shows metadata only: account IDs, dates, sizes. Never record content,
 * and invite tokens only once, when created.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { ConfigError, loadConfig, type Config, type LoadedConfig } from './config.ts';
import {
  BackupInvalidError,
  Database,
  DatabaseNotMigratedError,
  DatabaseTooNewError,
  pruneBackups,
} from './db/database.ts';
import { MIGRATIONS } from './db/migrations.ts';
import { newToken, tokenHash } from './secrets.ts';
import { OperatorError, backupDir, databasePath } from './serve.ts';
import { VERSION } from './version.ts';

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly now: () => number;
  readonly fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;
  readonly serve: (config: Config, warnings: readonly string[]) => void;
}

/** Exit code, or `serving` when the server now runs until a signal. */
export type CliResult = number | 'serving';

const USAGE = `Usage: tazamun <command>

Commands:
  serve                          Run the server (the default)
  invite create [--expires 7d]   Create a one-time invite token (--expires: 12h, 7d, never)
  invite list                    List invites and whether they were used
  invite revoke <id>             Revoke an unused invite
  backup <file>                  Write a consistent copy of the database, also while running
  restore <file>                 Replace the database with a backup (stop the server first)
  migrate --status               Show the database schema version and pending migrations
  accounts list                  List accounts: ID, created, last seen, devices, storage
  accounts delete <id> --yes     Delete an account and all its data (backs up first)
  version                        Print the version
  healthcheck                    Exit 0 if the local server answers /v1/health

Configuration comes from the same TAZAMUN_* variables and config file as the server.
`;

/** DEP-6: the container HEALTHCHECK runs `tazamun healthcheck`. */
const HEALTHCHECK_TIMEOUT_MS = 3000;
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_PRE_DELETE_BACKUPS = 3;

class UsageError extends Error {}

export async function runCli(argv: readonly string[], io: CliIo): Promise<CliResult> {
  const [command = 'serve', ...rest] = argv;
  try {
    switch (command) {
      case 'serve': {
        noArgs(rest);
        const { config, warnings } = config_(io);
        io.serve(config, warnings);
        return 'serving';
      }
      case 'version':
        noArgs(rest);
        io.out(`tazamun ${VERSION} (database schema ${String(MIGRATIONS.length)})\n`);
        return 0;
      case 'healthcheck':
        noArgs(rest);
        return await healthcheck(config_(io).config, io);
      case 'invite':
        return invite(rest, io);
      case 'backup':
        return backup(rest, io);
      case 'restore':
        return await restore(rest, io);
      case 'migrate':
        return migrate(rest, io);
      case 'accounts':
        return accounts(rest, io);
      case 'help':
      case '--help':
      case '-h':
        io.out(USAGE);
        return 0;
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`tazamun: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (
      err instanceof ConfigError ||
      err instanceof OperatorError ||
      err instanceof BackupInvalidError ||
      err instanceof DatabaseTooNewError ||
      err instanceof DatabaseNotMigratedError
    ) {
      io.err(`tazamun: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// ---- Helpers ---------------------------------------------------------------------------------

function config_(io: CliIo): LoadedConfig {
  return loadConfig(io.env, io.readFile);
}

function noArgs(args: readonly string[]): void {
  if (args.length > 0) throw new UsageError(`Unexpected argument "${args[0] ?? ''}".`);
}

function parse(args: readonly string[], options: ParseArgsOptionsConfig = {}) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : 'Invalid arguments.');
  }
}

function onePositional(positionals: readonly string[], name: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new UsageError(`Expected exactly one ${name}.`);
  }
  return positionals[0];
}

/** Open the existing database for an admin command; never creates or migrates it. */
function openAdminDb(config: Config): Database {
  const path = databasePath(config);
  if (!existsSync(path)) {
    throw new OperatorError(`No database at ${path}. Start the server once to create it.`);
  }
  return Database.open(path, { mode: 'require-current' });
}

function withDb<T>(config: Config, fn: (db: Database) => T): T {
  const db = openAdminDb(config);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function date(ms: number | undefined): string {
  return ms === undefined ? '-' : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** A plain-text table with columns padded to their widest cell. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}

/** `12h`, `7d` or `never` → milliseconds, or undefined for never. */
function parseTtl(value: string): number | undefined {
  if (value === 'never') return undefined;
  const match = /^(\d+)([hd])$/.exec(value);
  const amount = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(amount) || amount < 1) {
    throw new UsageError(`--expires must look like 12h, 7d or never (got "${value}").`);
  }
  return amount * (match[2] === 'h' ? 3_600_000 : 86_400_000);
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** True if something answers /v1/health on the configured port. */
async function serverAnswers(config: Config, io: CliIo): Promise<boolean> {
  try {
    const res = await io.fetch(`http://127.0.0.1:${String(config.port)}/v1/health`, {
      signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---- Commands --------------------------------------------------------------------------------

async function healthcheck(config: Config, io: CliIo): Promise<number> {
  if (await serverAnswers(config, io)) return 0;
  io.err(`tazamun: no healthy server on port ${String(config.port)}\n`);
  return 1;
}

function invite(args: readonly string[], io: CliIo): number {
  const [sub, ...rest] = args;
  const { config } = config_(io);
  switch (sub) {
    case 'create': {
      const { values, positionals } = parse(rest, { expires: { type: 'string' } });
      noArgs(positionals);
      const expires = values['expires'];
      const ttl = typeof expires === 'string' ? parseTtl(expires) : DEFAULT_INVITE_TTL_MS;
      const now = io.now();
      const expiresAt = ttl === undefined ? undefined : now + ttl;
      const token = newToken();
      // Hex, so an ID never starts with '-' and gets mistaken for an option.
      const id = randomBytes(4).toString('hex');
      withDb(config, (db) => {
        db.createInvite(id, tokenHash(token), now, expiresAt);
      });
      io.out(
        `Invite ${id} created (expires: ${expiresAt === undefined ? 'never' : date(expiresAt)}).\n\n` +
          `${token}\n\n` +
          'Give this token to the person creating the account. It works once and is not shown again.\n',
      );
      return 0;
    }
    case 'list': {
      noArgs(rest);
      const now = io.now();
      const rows = withDb(config, (db) => db.listInvites()).map((i) => [
        i.id,
        date(i.createdAt),
        date(i.expiresAt),
        i.usedAt !== undefined
          ? `used ${date(i.usedAt)}`
          : i.expiresAt !== undefined && i.expiresAt <= now
            ? 'expired'
            : 'unused',
      ]);
      io.out(
        rows.length === 0 ? 'No invites.\n' : table(['ID', 'CREATED', 'EXPIRES', 'STATUS'], rows),
      );
      return 0;
    }
    case 'revoke': {
      const id = onePositional(parse(rest).positionals, 'invite ID');
      if (!withDb(config, (db) => db.revokeInvite(id))) {
        throw new OperatorError(`No invite with ID ${id}.`);
      }
      io.out(`Invite ${id} revoked.\n`);
      return 0;
    }
    default:
      throw new UsageError('Expected "invite create", "invite list" or "invite revoke <id>".');
  }
}

function backup(args: readonly string[], io: CliIo): number {
  const target = resolve(onePositional(parse(args).positionals, 'backup file'));
  const { config } = config_(io);
  if (target === resolve(databasePath(config))) {
    throw new OperatorError('The backup file must not be the database itself.');
  }
  withDb(config, (db) => {
    db.backupTo(target);
  });
  // Check the copy, so a backup that can't be restored is noticed now and not on the bad day.
  const copy = Database.open(target, { mode: 'inspect', readOnly: true });
  try {
    if (!copy.integrityOk())
      throw new OperatorError(`The backup at ${target} failed integrity_check.`);
  } finally {
    copy.close();
  }
  io.out(
    `Backup written to ${target} (${size(statSync(target).size)}). It holds only ciphertext and metadata.\n`,
  );
  return 0;
}

async function restore(args: readonly string[], io: CliIo): Promise<number> {
  const source = resolve(onePositional(parse(args).positionals, 'backup file'));
  const { config } = config_(io);
  if (!existsSync(source)) throw new OperatorError(`No file at ${source}.`);
  if (await serverAnswers(config, io)) {
    throw new OperatorError(
      `The server is running on port ${String(config.port)}. Stop it before restoring ` +
        '(for Compose: docker compose run --rm tazamun tazamun restore <file>).',
    );
  }
  const safety = join(backupDir(config), `pre-restore-${timestamp(io.now())}.db`);
  const version = Database.restore(databasePath(config), source, safety);
  const kept = existsSync(safety) ? ` The previous database was saved to ${safety}.` : '';
  io.out(
    `Restored ${source} (schema version ${String(version)}).${kept} ` +
      'Start the server; it migrates the database if needed. Devices sync again on their next poll.\n',
  );
  return 0;
}

function migrate(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parse(args, { status: { type: 'boolean' } });
  noArgs(positionals);
  if (values['status'] !== true) {
    throw new UsageError(
      'Migrations run automatically when the server starts. Use "migrate --status".',
    );
  }
  const { config } = config_(io);
  const path = databasePath(config);
  const latest = MIGRATIONS.length;
  if (!existsSync(path)) {
    io.out(
      `No database at ${path} yet. The server creates it at schema version ${String(latest)}.\n`,
    );
    return 0;
  }
  const db = Database.open(path, { mode: 'inspect', readOnly: true });
  const current = db.schemaVersion;
  db.close();
  const state =
    current === latest
      ? 'up to date'
      : current < latest
        ? `${String(latest - current)} migration(s) pending; they run when the server starts, after a backup`
        : 'newer than this version of Tazamun; run a newer image, or restore a pre-migration backup';
  io.out(`Database ${path}: schema version ${String(current)} of ${String(latest)}, ${state}.\n`);
  return 0;
}

function accounts(args: readonly string[], io: CliIo): number {
  const [sub, ...rest] = args;
  const { config } = config_(io);
  switch (sub) {
    case 'list': {
      noArgs(rest);
      const rows = withDb(config, (db) => db.listAccounts()).map((a) => [
        a.id,
        date(a.createdAt),
        date(a.lastSeenAt),
        String(a.devices),
        size(a.storageBytes),
      ]);
      io.out(
        rows.length === 0
          ? 'No accounts.\n'
          : table(['ID', 'CREATED', 'LAST SEEN', 'DEVICES', 'STORAGE'], rows),
      );
      return 0;
    }
    case 'delete': {
      const { values, positionals } = parse(rest, { yes: { type: 'boolean' } });
      const id = onePositional(positionals, 'account ID');
      return withDb(config, (db) => {
        if (db.getAccount(id) === undefined) throw new OperatorError(`No account with ID ${id}.`);
        if (values['yes'] !== true) {
          throw new UsageError(
            `This deletes account ${id} with all its devices and data. Run again with --yes to confirm.`,
          );
        }
        // Rule 6: never destroy user data without a recoverable copy.
        const dir = backupDir(config);
        const copy = join(dir, `pre-delete-${timestamp(io.now())}.db`);
        db.backupTo(copy);
        pruneBackups(dir, 'pre-delete-', KEEP_PRE_DELETE_BACKUPS);
        db.deleteAccount(id);
        io.out(`Account ${id} deleted. A backup from just before is at ${copy}.\n`);
        return 0;
      });
    }
    default:
      throw new UsageError('Expected "accounts list" or "accounts delete <id> --yes".');
  }
}
