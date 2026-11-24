/**
 * Server entry point: `node src/main.ts`. Reads the configuration, opens and migrates the
 * database, serves the API, and shuts down cleanly on SIGTERM/SIGINT (DEP-7).
 *
 * Run node directly (not through npm or pnpm), so signals reach this process.
 */
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { DATABASE_FILE, Database } from './db/database.ts';
import { RateLimiter } from './http/rate-limit.ts';
import { createLogger, errorFields, type Logger } from './log.ts';
import { loadInstanceSecret } from './secrets.ts';
import { MIN_CLIENT_VERSION, VERSION } from './version.ts';

/** DEP-7: in-flight requests get this long to finish after SIGTERM. */
const SHUTDOWN_GRACE_MS = 10_000;
/** SRS 6.4 asks for a daily purge of expired records; hourly keeps storage use closer to real. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

function fail(message: string): never {
  process.stderr.write(`tazamun: ${message}\n`);
  process.exit(1);
}

function ensureWritableDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    fail(
      `The data directory ${dir} is not writable. The container runs as UID 10001: ` +
        `use a named volume, or run "chown 10001:10001" on the host directory.`,
    );
  }
}

function clientIpResolver(trustProxy: boolean): (c: Context) => string {
  return (c) => {
    if (trustProxy) {
      // The last entry is the one our own proxy added; earlier ones can be forged by clients.
      const last = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
      if (last) return last;
    }
    return getConnInfo(c).remote.address ?? 'unknown';
  };
}

function main(): void {
  let loaded;
  try {
    loaded = loadConfig(process.env, (path) => readFileSync(path, 'utf8'));
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
  const { config, warnings } = loaded;
  const logger: Logger = createLogger({ level: config.logLevel, format: config.logFormat });
  for (const warning of warnings) logger.warn(warning);

  ensureWritableDir(config.dataDir);
  const db = Database.open(join(config.dataDir, DATABASE_FILE), {
    backupDir: join(config.dataDir, 'backups'),
    onMigrate: (from, to) => {
      logger.info('Database migrated', { schemaVersion: to, count: to - from });
    },
  });
  const instanceSecret = loadInstanceSecret(config.dataDir, config.instanceSecret);

  const app = createApp({
    db,
    logger,
    now: Date.now,
    clientIp: clientIpResolver(config.trustProxy),
    version: VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    registration: config.registration,
    storageQuotaBytes: config.storageQuotaMb * 1024 * 1024,
    instanceSecret,
    limiters: {
      account: new RateLimiter(config.rateLimitPerMinute),
      auth: new RateLimiter(config.authRateLimitPerMinute),
    },
  });

  const purge = (): void => {
    try {
      const count = db.purgeExpired(Date.now());
      if (count > 0) logger.info('Expired records deleted', { count });
    } catch (err) {
      logger.error('Purging expired records failed', errorFields(err));
    }
  };
  purge();
  const purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('Listening', {
      port: info.port,
      version: VERSION,
      schemaVersion: db.schemaVersion,
    });
  });

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down');
    clearInterval(purgeTimer);
    const force = setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      db.close();
      logger.info('Stopped');
      process.exit(0);
    });
    // Idle keep-alive connections would otherwise hold close() open until the grace period ends.
    if ('closeIdleConnections' in server) server.closeIdleConnections();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
