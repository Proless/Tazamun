/**
 * Structured logger (DEP-8, ADM-7). One event per line on stdout (or stderr for warnings and
 * errors), as JSON or as readable text.
 *
 * Rule 5 (never log plaintext, tokens, keys or record IDs) is enforced by the type of `fields`:
 * only the keys in LogFields can be logged, and none of them can hold a body, a header, a token,
 * a record ID or a request path (paths contain account and device IDs). Add a key only if its
 * values can never contain any of those.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  /** HTTP method. */
  readonly method?: string;
  /** Route pattern such as `/v1/collections/:name`, never the concrete path. */
  readonly route?: string;
  readonly status?: number;
  readonly durationMs?: number;
  /** Stable API error code (SRS 4.4.1). */
  readonly code?: string;
  /** Error class name and message, for unexpected server errors only. */
  readonly error?: string;
  readonly stack?: string;
  readonly port?: number;
  readonly version?: string;
  readonly schemaVersion?: number;
  readonly count?: number;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly format: 'json' | 'pretty';
  /** Where lines go. Defaults to stdout for debug/info and stderr for warn/error. */
  readonly write?: (line: string, level: LogLevel) => void;
  readonly now?: () => Date;
}

function defaultWrite(line: string, level: LogLevel): void {
  (ORDER[level] >= ORDER.warn ? process.stderr : process.stdout).write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const min = ORDER[options.level];

  function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (ORDER[level] < min) return;
    const time = now().toISOString();
    if (options.format === 'json') {
      write(JSON.stringify({ time, level, msg, ...fields }), level);
    } else {
      const extra = Object.entries(fields)
        .filter(([k]) => k !== 'stack')
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      const stack = fields.stack === undefined ? '' : `\n${fields.stack}`;
      write(
        `${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? ` ${extra}` : ''}${stack}`,
        level,
      );
    }
  }

  return {
    debug: (msg, fields) => {
      log('debug', msg, fields);
    },
    info: (msg, fields) => {
      log('info', msg, fields);
    },
    warn: (msg, fields) => {
      log('warn', msg, fields);
    },
    error: (msg, fields) => {
      log('error', msg, fields);
    },
  };
}

/** Fields describing an unexpected error. Only for server bugs, never for client input. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { error: `${err.name}: ${err.message}`, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { error: 'Non-error thrown' };
}
