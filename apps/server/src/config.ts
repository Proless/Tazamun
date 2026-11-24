/**
 * Server configuration (ADM-1, DEP-12…15). Every setting is one entry in SETTINGS, which drives
 * parsing, validation, `*_FILE` secrets and the generated reference in
 * docs/guides/server-configuration.md (`pnpm --filter @tazamun/server config:docs`).
 */
import { z } from 'zod';
import { schema } from '@tazamun/core';

interface Setting<T> {
  /** Environment variable name, always prefixed `TAZAMUN_`. */
  readonly env: string;
  readonly description: string;
  /** Human-readable expected format, used in docs and error messages. */
  readonly format: string;
  /** Raw default, as it would be written in the environment. Absent means required or optional. */
  readonly default?: string;
  /** Required settings stop the server when missing. */
  readonly required?: boolean;
  /** Secret settings also accept `<env>_FILE` (Docker and Kubernetes secrets). */
  readonly secret?: boolean;
  readonly schema: z.ZodType<T>;
}

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const positiveInt = (max: number) => z.coerce.number().int().min(1).max(max);

export const SETTINGS = {
  publicUrl: {
    env: 'TAZAMUN_PUBLIC_URL',
    description:
      'The URL clients use to reach this server, without a path. Must be `https://` unless the host is `localhost` or `127.0.0.1`, or `TAZAMUN_ALLOW_INSECURE` is set.',
    format: 'URL, e.g. `https://sync.example.org`',
    required: true,
    schema: z.url({ protocol: /^https?$/ }).transform((v) => new URL(v)),
  },
  port: {
    env: 'TAZAMUN_PORT',
    description: 'HTTP port to listen on, on all interfaces. TLS is handled by a reverse proxy.',
    format: 'integer 1–65535',
    default: '8080',
    schema: positiveInt(65535),
  },
  dataDir: {
    env: 'TAZAMUN_DATA_DIR',
    description:
      'Directory for all persistent state: the database, its WAL files, the instance secret and automatic backups. Must be on local storage, used by one server only.',
    format: 'directory path',
    default: '/data',
    schema: z.string().min(1),
  },
  registration: {
    env: 'TAZAMUN_REGISTRATION',
    description:
      'Who may create accounts: anyone (`open`), holders of a one-time invite token (`invite`), or nobody (`closed`).',
    format: '`open`, `invite` or `closed`',
    default: 'invite',
    schema: schema.registrationMode,
  },
  storageQuotaMb: {
    env: 'TAZAMUN_STORAGE_QUOTA_MB',
    description: 'Maximum storage per account, in MiB (record IDs plus encrypted payloads).',
    format: 'integer ≥ 1',
    default: '200',
    schema: positiveInt(1024 * 1024),
  },
  rateLimitPerMinute: {
    env: 'TAZAMUN_RATE_LIMIT_PER_MINUTE',
    description: 'Requests per minute per signed-in account, across all of its devices.',
    format: 'integer ≥ 1',
    default: '600',
    schema: positiveInt(1_000_000),
  },
  authRateLimitPerMinute: {
    env: 'TAZAMUN_AUTH_RATE_LIMIT_PER_MINUTE',
    description:
      'Attempts per minute for sign-in, account creation, prelogin and passphrase checks, counted per client IP and, where an account is named, per account.',
    format: 'integer ≥ 1',
    default: '10',
    schema: positiveInt(1_000_000),
  },
  trustProxy: {
    env: 'TAZAMUN_TRUST_PROXY',
    description:
      'Take the client IP from the last `X-Forwarded-For` entry. Set this only behind a reverse proxy that sets the header, or clients can fake their IP and escape rate limits.',
    format: '`true` or `false`',
    default: 'false',
    schema: bool,
  },
  allowInsecure: {
    env: 'TAZAMUN_ALLOW_INSECURE',
    description:
      'Allow a plain `http://` public URL on a host other than localhost. Session tokens and auth keys then cross the network unprotected. A warning is logged on every start.',
    format: '`true` or `false`',
    default: 'false',
    schema: bool,
  },
  logLevel: {
    env: 'TAZAMUN_LOG_LEVEL',
    description: 'Lowest level that is logged.',
    format: '`debug`, `info`, `warn` or `error`',
    default: 'info',
    schema: z.enum(['debug', 'info', 'warn', 'error']),
  },
  logFormat: {
    env: 'TAZAMUN_LOG_FORMAT',
    description: 'One JSON object per line, or human-readable lines for development.',
    format: '`json` or `pretty`',
    default: 'json',
    schema: z.enum(['json', 'pretty']),
  },
  instanceSecret: {
    env: 'TAZAMUN_INSTANCE_SECRET',
    description:
      'Secret used to make prelogin responses for unknown accounts look real and stay stable. If unset, one is generated into `<data dir>/instance-secret` on first start. Changing it changes those responses.',
    format: 'at least 32 characters',
    secret: true,
    schema: z.string().min(32),
  },
} as const satisfies Record<string, Setting<unknown>>;

type Settings = typeof SETTINGS;
type ValueOf<S> = S extends { schema: z.ZodType } ? z.output<S['schema']> : never;

/** Parsed configuration. Settings without a default and not required may be undefined. */
export type Config = {
  [K in keyof Settings]: Settings[K] extends { default: string } | { required: true }
    ? ValueOf<Settings[K]>
    : ValueOf<Settings[K]> | undefined;
};

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface LoadedConfig {
  readonly config: Config;
  /** Problems that don't stop the server; log them on every start. */
  readonly warnings: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Parse and validate the environment (DEP-13). Throws ConfigError naming every bad variable and
 * the expected format. `readFile` reads `*_FILE` secrets; it's injected for tests.
 */
export function loadConfig(env: Env, readFile: (path: string) => string): LoadedConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const values: Record<string, unknown> = {};
  const known = new Set<string>();

  for (const [key, s] of Object.entries(SETTINGS) as [string, Setting<unknown>][]) {
    known.add(s.env);
    let raw = nonEmpty(env[s.env]);
    if (s.secret) {
      const fileVar = `${s.env}_FILE`;
      known.add(fileVar);
      const file = nonEmpty(env[fileVar]);
      if (file !== undefined && raw !== undefined) {
        problems.push(`${s.env} and ${fileVar} are both set; set only one`);
        continue;
      }
      if (file !== undefined) {
        try {
          raw = readFile(file).replace(/\r?\n$/, '');
        } catch {
          problems.push(`${fileVar}: can't read the file ${file}`);
          continue;
        }
      }
    }
    raw ??= s.default;
    if (raw === undefined) {
      if (s.required) problems.push(`${s.env} is required (expected ${s.format})`);
      continue;
    }
    const parsed = s.schema.safeParse(raw);
    if (parsed.success) {
      values[key] = parsed.data;
    } else {
      // Secrets are never echoed back, other values are, to make typos easy to spot.
      const shown = s.secret ? '' : ` (got "${raw}")`;
      problems.push(`${s.env} is invalid${shown}: expected ${s.format}`);
    }
  }

  const url = values['publicUrl'];
  if (url instanceof URL) {
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      problems.push(`TAZAMUN_PUBLIC_URL must not have a path, query or fragment`);
    }
    if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
      if (values['allowInsecure'] === true) {
        warnings.push(
          'TAZAMUN_PUBLIC_URL is not https and TAZAMUN_ALLOW_INSECURE is set: tokens and auth keys cross the network unencrypted',
        );
      } else {
        problems.push(
          'TAZAMUN_PUBLIC_URL must use https:// (plain http is allowed only for localhost, or with TAZAMUN_ALLOW_INSECURE=true)',
        );
      }
    }
  }

  for (const name of Object.keys(env)) {
    if (name.startsWith('TAZAMUN_') && !known.has(name)) {
      warnings.push(`Unknown setting ${name} is ignored`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { config: values as Config, warnings };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** The configuration reference (DEP-15), generated from SETTINGS. */
export function renderConfigReference(): string {
  const rows = Object.values(SETTINGS).map((s: Setting<unknown>) => {
    const name = s.secret ? `\`${s.env}\`<br>\`${s.env}_FILE\`` : `\`${s.env}\``;
    const def = s.required ? '**required**' : s.default === undefined ? '—' : `\`${s.default}\``;
    return `| ${name} | ${def} | ${s.format} | ${s.description} |`;
  });
  return [
    '# Server configuration',
    '',
    '<!-- Generated from apps/server/src/config.ts by `pnpm --filter @tazamun/server config:docs`. Do not edit by hand. -->',
    '',
    'The server reads all configuration from environment variables (ADM-1, DEP-12). It checks every value at startup and refuses to start, naming the variable, if one is missing or invalid (DEP-13). Unknown `TAZAMUN_*` variables are logged as warnings, to catch typos.',
    '',
    'Variables with a `_FILE` variant read the value from that file instead (for Docker and Kubernetes secrets). Set only one of the two.',
    '',
    '| Variable | Default | Format | Description |',
    '| -------- | ------- | ------ | ----------- |',
    ...rows,
    '',
  ].join('\n');
}
