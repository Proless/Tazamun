import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_REFERENCE_PATH } from './config-docs-path.ts';
import { ConfigError, loadConfig, renderConfigReference } from './config.ts';

const noFiles = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

function problems(env: Record<string, string>, readFile = noFiles): readonly string[] {
  try {
    loadConfig(env, readFile);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

const BASE = { TAZAMUN_PUBLIC_URL: 'https://sync.example.org' };

describe('loadConfig', () => {
  it('applies documented defaults (ADM-1)', () => {
    const { config, warnings } = loadConfig(BASE, noFiles);
    expect(config).toMatchObject({
      port: 8080,
      dataDir: '/data',
      registration: 'invite',
      storageQuotaMb: 200,
      trustProxy: false,
      allowInsecure: false,
      logLevel: 'info',
      logFormat: 'json',
    });
    expect(config.publicUrl.href).toBe('https://sync.example.org/');
    expect(config.instanceSecret).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('requires TAZAMUN_PUBLIC_URL (DEP-14)', () => {
    expect(problems({})).toEqual([
      expect.stringContaining('TAZAMUN_PUBLIC_URL (or "publicUrl" in the config file) is required'),
    ]);
  });

  it('names each invalid variable and the expected format (DEP-13)', () => {
    const found = problems({ ...BASE, TAZAMUN_PORT: 'eighty', TAZAMUN_REGISTRATION: 'public' });
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/TAZAMUN_PORT is invalid \(got "eighty"\): expected integer/);
    expect(found[1]).toMatch(/TAZAMUN_REGISTRATION.*`open`, `invite` or `closed`/);
  });

  it('allows http only for localhost, or with TAZAMUN_ALLOW_INSECURE and a warning (DEP-14)', () => {
    expect(problems({ TAZAMUN_PUBLIC_URL: 'http://sync.example.org' })).toEqual([
      expect.stringContaining('must use https://'),
    ]);
    for (const host of ['localhost:8080', '127.0.0.1', '[::1]:3000']) {
      expect(loadConfig({ TAZAMUN_PUBLIC_URL: `http://${host}` }, noFiles).warnings).toEqual([]);
    }
    const insecure = loadConfig(
      { TAZAMUN_PUBLIC_URL: 'http://192.168.1.10:8080', TAZAMUN_ALLOW_INSECURE: 'true' },
      noFiles,
    );
    expect(insecure.warnings).toEqual([expect.stringContaining('not https')]);
  });

  it('rejects public URLs with a path or another scheme', () => {
    expect(problems({ TAZAMUN_PUBLIC_URL: 'https://example.org/tazamun' })).toHaveLength(1);
    expect(problems({ TAZAMUN_PUBLIC_URL: 'ftp://example.org' })).toHaveLength(1);
  });

  it('reads secrets from *_FILE, and refuses both forms at once (DEP-12)', () => {
    const secret = 'x'.repeat(40);
    const { config } = loadConfig(
      { ...BASE, TAZAMUN_INSTANCE_SECRET_FILE: '/run/secrets/s' },
      (path) => {
        expect(path).toBe('/run/secrets/s');
        return `${secret}\n`;
      },
    );
    expect(config.instanceSecret).toBe(secret);
    expect(
      problems({ ...BASE, TAZAMUN_INSTANCE_SECRET: secret, TAZAMUN_INSTANCE_SECRET_FILE: '/x' }),
    ).toEqual([expect.stringContaining('both set')]);
  });

  it('never echoes a secret value in errors', () => {
    const found = problems({ ...BASE, TAZAMUN_INSTANCE_SECRET: 'tooShortSecret' });
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('tooShortSecret');
  });

  it('treats empty variables as unset, and warns about unknown TAZAMUN_ variables', () => {
    const { config, warnings } = loadConfig(
      { ...BASE, TAZAMUN_PORT: '', TAZAMUN_PROT: '1' },
      noFiles,
    );
    expect(config.port).toBe(8080);
    expect(warnings).toEqual(['Unknown setting TAZAMUN_PROT is ignored']);
  });
});

describe('JSON config file', () => {
  const PATH = '/etc/tazamun/config.json';
  const withFile =
    (content: unknown) =>
    (path: string): string => {
      expect(path).toBe(PATH);
      return typeof content === 'string' ? content : JSON.stringify(content);
    };

  it('reads typed JSON values under the settings keys', () => {
    const { config } = loadConfig(
      { TAZAMUN_CONFIG_FILE: PATH },
      withFile({
        publicUrl: 'https://sync.example.org',
        port: 9000,
        trustProxy: true,
        registration: 'open',
      }),
    );
    expect(config).toMatchObject({ port: 9000, trustProxy: true, registration: 'open' });
    expect(config.publicUrl.host).toBe('sync.example.org');
  });

  it('lets environment variables override the file, and the file override defaults', () => {
    const { config } = loadConfig(
      { TAZAMUN_CONFIG_FILE: PATH, TAZAMUN_PORT: '7000', TAZAMUN_LOG_LEVEL: '' },
      withFile({ publicUrl: 'https://a.example.org', port: 9000, logLevel: 'warn' }),
    );
    expect(config.port).toBe(7000);
    // An empty variable counts as unset, so the file's value applies.
    expect(config.logLevel).toBe('warn');
    expect(config.storageQuotaMb).toBe(200);
  });

  it('lets a *_FILE secret override the config file', () => {
    const secret = 's'.repeat(40);
    const { config } = loadConfig(
      { TAZAMUN_CONFIG_FILE: PATH, TAZAMUN_INSTANCE_SECRET_FILE: '/run/secrets/s' },
      (path) =>
        path === PATH
          ? JSON.stringify({ publicUrl: 'https://a.example.org', instanceSecret: 'f'.repeat(40) })
          : secret,
    );
    expect(config.instanceSecret).toBe(secret);
  });

  it('refuses unknown keys, wrong types and names the file key in errors', () => {
    const found = problems(
      { TAZAMUN_CONFIG_FILE: PATH },
      withFile({ publicUrl: 'https://a.example.org', prot: 1, port: 'eighty', trustProxy: [true] }),
    );
    expect(found).toEqual([
      `${PATH}: unknown setting "prot"`,
      expect.stringMatching(/^"port" in \/etc\/tazamun\/config.json is invalid \(got "eighty"\)/),
      expect.stringContaining(
        '"trustProxy" in /etc/tazamun/config.json must be a string, number or boolean',
      ),
    ]);
  });

  it('reports unreadable files, invalid JSON and non-objects', () => {
    expect(
      problems({ TAZAMUN_CONFIG_FILE: PATH }, () => {
        throw new Error('ENOENT');
      }),
    ).toContain(`TAZAMUN_CONFIG_FILE: can't read the file ${PATH}`);
    expect(problems({ TAZAMUN_CONFIG_FILE: PATH }, withFile('{ "port": 1, }'))).toContain(
      `${PATH} is not valid JSON`,
    );
    expect(problems({ TAZAMUN_CONFIG_FILE: PATH }, withFile([1, 2]))).toContain(
      `${PATH} must contain one JSON object`,
    );
  });

  it('never echoes a secret from the file', () => {
    const found = problems(
      { TAZAMUN_CONFIG_FILE: PATH },
      withFile({ publicUrl: 'https://a.example.org', instanceSecret: 'shortFileSecret' }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain('shortFileSecret');
  });

  it("doesn't warn about TAZAMUN_CONFIG_FILE itself", () => {
    const { warnings } = loadConfig(
      { TAZAMUN_CONFIG_FILE: PATH },
      withFile({ publicUrl: 'https://a.example.org' }),
    );
    expect(warnings).toEqual([]);
  });
});

describe('configuration reference (DEP-15)', () => {
  it('is up to date; run `pnpm --filter @tazamun/server config:docs` if this fails', () => {
    const committed = readFileSync(CONFIG_REFERENCE_PATH, 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderConfigReference());
  });
});
