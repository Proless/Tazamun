import { describe, expect, it } from 'vitest';
import { createLogger, errorFields } from './log.ts';

describe('createLogger (DEP-8)', () => {
  const now = () => new Date('2026-11-24T10:00:00Z');

  it('writes one JSON object per line and filters by level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', format: 'json', now, write: (l) => lines.push(l) });
    log.debug('hidden');
    log.info('request', { method: 'GET', route: '/v1/info', status: 200 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-11-24T10:00:00.000Z',
      level: 'info',
      msg: 'request',
      method: 'GET',
      route: '/v1/info',
      status: 200,
    });
  });

  it('writes readable lines in pretty format', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'debug',
      format: 'pretty',
      now,
      write: (l) => lines.push(l),
    });
    log.warn('slow', { durationMs: 900 });
    expect(lines).toEqual(['2026-11-24T10:00:00.000Z WARN  slow durationMs=900']);
  });

  it('describes errors by name and message', () => {
    expect(errorFields(new TypeError('boom')).error).toBe('TypeError: boom');
    expect(errorFields('x')).toEqual({ error: 'Non-error thrown' });
  });
});
