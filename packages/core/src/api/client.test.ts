import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, NetworkError, type Fetch } from './client.ts';
import { compareVersions, isClientSupported } from './version.ts';

const INFO = {
  version: '0.1.0',
  minClientVersion: '0.1.0',
  registration: 'open',
  limits: {
    maxRequestBytes: 2_097_152,
    maxBatchRecords: 500,
    maxPullRecords: 1000,
    storageQuotaBytes: 209_715_200,
  },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function recording(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetch };
}

describe('ApiClient', () => {
  it('sends the token, omits cookies, and validates the response', async () => {
    const { calls, fetch } = recording(() => json(200, INFO));
    const client = new ApiClient({ baseUrl: 'https://a.example', fetch }).withToken('tok');
    expect((await client.info()).registration).toBe('open');
    expect(calls[0]?.url).toBe('https://a.example/v1/info');
    expect(calls[0]?.init.credentials).toBe('omit');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('encodes path segments', async () => {
    const { calls, fetch } = recording(() => new Response(null, { status: 204 }));
    await new ApiClient({ baseUrl: 'https://a.example', fetch }).revokeDevice('a/b');
    expect(calls[0]?.url).toBe('https://a.example/v1/devices/a%2Fb');
  });

  it('turns error bodies into ApiError with the stable code', async () => {
    const { fetch } = recording(() =>
      json(429, { error: { code: 'RATE_LIMITED', message: 'Slow down', retryAfter: 7 } }),
    );
    const err = await new ApiClient({ baseUrl: 'https://a.example', fetch })
      .info()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 7 });
  });

  it('copes with a proxy error page', async () => {
    const { fetch } = recording(
      () =>
        new Response('<html>Bad gateway</html>', { status: 502, headers: { 'retry-after': '5' } }),
    );
    await expect(
      new ApiClient({ baseUrl: 'https://a.example', fetch }).info(),
    ).rejects.toMatchObject({
      status: 502,
      code: 'UNAVAILABLE',
      retryAfter: 5,
    });
  });

  it('rejects a response that is not a Tazamun server, naming paths only', async () => {
    const { fetch } = recording(() => json(200, { version: 'secret-value' }));
    const err = await new ApiClient({ baseUrl: 'https://a.example', fetch })
      .info()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain('limits');
    expect((err as Error).message).not.toContain('secret-value');
  });

  it('rejects a non-JSON success', async () => {
    const { fetch } = recording(() => new Response('<html>login</html>', { status: 200 }));
    await expect(
      new ApiClient({ baseUrl: 'https://a.example', fetch }).info(),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('reports unreachable servers and timeouts as NetworkError', async () => {
    const down: Fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(
      new ApiClient({ baseUrl: 'https://a.example', fetch: down }).health(),
    ).rejects.toThrow('could not be reached');
    const slow: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    await expect(
      new ApiClient({ baseUrl: 'https://a.example', fetch: slow, timeoutMs: 20 }).health(),
    ).rejects.toThrow('did not answer in time');
  });
});

describe('client versions (SRS 4.4.1)', () => {
  it.each([
    ['0.1.0', '0.1.0', 0],
    ['0.2.0', '0.10.0', -1],
    ['1.0.0', '0.9.9', 1],
    ['1.2', '1.2.0', 0],
    ['v1.2.3-beta.1', '1.2.3', 0],
  ])('compareVersions(%s, %s) = %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('accepts a client at or above the minimum', () => {
    expect(isClientSupported('0.1.0', '0.1.0')).toBe(true);
    expect(isClientSupported('0.0.9', '0.1.0')).toBe(false);
    expect(() => compareVersions('one', '1.0.0')).toThrow(RangeError);
  });
});
