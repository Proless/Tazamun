/**
 * Typed client for the Tazamun HTTP API (SRS 4.4). Shared by the extension and the dashboard.
 *
 * Every response is validated with the same zod schemas the server uses, so a broken or hostile
 * server can't hand the caller malformed data. `fetch` is injected: tests pass a fake, the server's
 * tests pass the Hono app, and browsers pass `globalThis.fetch`.
 *
 * Errors never include request or response bodies, tokens or keys (rule 5): only the HTTP status,
 * the stable error code and the server's message.
 */
import type { z } from 'zod';
import * as schema from '../schema/index.ts';

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Normalized server URL without a trailing slash (`normalizeServerUrl`). */
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  /** Session token of this device, once signed in. */
  readonly token?: string;
  /** Abort a request after this long. Default 30 s. */
  readonly timeoutMs?: number;
}

/** The server answered with a non-2xx status. `code` is one of `schema.ERROR_CODES`, or newer. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds to wait before retrying (rate limits, quotas, 503). */
  readonly retryAfter: number | undefined;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** The server couldn't be reached, timed out, or isn't a Tazamun server. */
export class NetworkError extends Error {
  /** `invalid-response`: something answered, but not with what a Tazamun server sends. */
  readonly kind: 'unreachable' | 'timeout' | 'invalid-response';

  constructor(kind: NetworkError['kind'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
    this.kind = kind;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The same client, signed in as a device. */
  withToken(token: string): ApiClient {
    return new ApiClient({
      baseUrl: this.baseUrl,
      fetch: this.#fetch,
      token,
      timeoutMs: this.#timeoutMs,
    });
  }

  // ---- Server ----------------------------------------------------------------------------------

  info(): Promise<schema.InfoResponse> {
    return this.#json('GET', '/v1/info', schema.infoResponse);
  }

  health(): Promise<schema.HealthResponse> {
    return this.#json('GET', '/v1/health', schema.healthResponse);
  }

  // ---- Accounts --------------------------------------------------------------------------------

  createAccount(body: schema.CreateAccountRequest): Promise<schema.CreateAccountResponse> {
    return this.#json('POST', '/v1/accounts', schema.createAccountResponse, body);
  }

  prelogin(accountId: string): Promise<schema.PreloginResponse> {
    return this.#json(
      'GET',
      `/v1/accounts/${encodeURIComponent(accountId)}/prelogin`,
      schema.preloginResponse,
    );
  }

  async deleteAccount(body: schema.DeleteAccountRequest): Promise<void> {
    await this.#send('DELETE', '/v1/accounts/me', body);
  }

  // ---- Sessions, keys, devices -----------------------------------------------------------------

  createSession(body: schema.CreateSessionRequest): Promise<schema.CreateSessionResponse> {
    return this.#json('POST', '/v1/sessions', schema.createSessionResponse, body);
  }

  /** Sign this device out. Its token stops working immediately. */
  async deleteSession(): Promise<void> {
    await this.#send('DELETE', '/v1/sessions/current');
  }

  keys(): Promise<schema.KeyBundle> {
    return this.#json('GET', '/v1/keys', schema.keyBundle);
  }

  async updateKeys(body: schema.UpdateKeysRequest): Promise<void> {
    await this.#send('PUT', '/v1/keys', body);
  }

  async listDevices(): Promise<schema.Device[]> {
    return (await this.#json('GET', '/v1/devices', schema.listDevicesResponse)).devices;
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    const body: schema.UpdateDeviceRequest = { name };
    await this.#send('PUT', `/v1/devices/${encodeURIComponent(deviceId)}`, body);
  }

  /** ACC-8: revoke a device; its token stops working immediately. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.#send('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`);
  }

  // ---- Collections -----------------------------------------------------------------------------

  pull(collection: string, since: number, limit?: number): Promise<schema.PullResponse> {
    const query = new URLSearchParams({ since: String(since) });
    if (limit !== undefined) query.set('limit', String(limit));
    return this.#json(
      'GET',
      `/v1/collections/${encodeURIComponent(collection)}?${query.toString()}`,
      schema.pullResponse,
    );
  }

  push(collection: string, records: schema.PushRequest): Promise<schema.PushResponse> {
    return this.#json(
      'POST',
      `/v1/collections/${encodeURIComponent(collection)}`,
      schema.pushResponse,
      records,
    );
  }

  // ---- Transport -------------------------------------------------------------------------------

  async #json<T extends z.ZodType>(
    method: string,
    path: string,
    responseSchema: T,
    body?: unknown,
  ): Promise<z.infer<T>> {
    const res = await this.#send(method, path, body);
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new NetworkError('invalid-response', 'The server sent a response that is not JSON', {
        cause: err,
      });
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      // Paths only, never values (rule 5).
      const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
      throw new NetworkError(
        'invalid-response',
        `Unexpected response from the server (${paths.join(', ')})`,
      );
    }
    return parsed.data;
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
    const init: RequestInit = {
      method,
      headers,
      // The extension talks only to the user's server (PRIV-4); never send cookies to it.
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      throw new NetworkError(
        timedOut ? 'timeout' : 'unreachable',
        timedOut ? 'The server did not answer in time' : 'The server could not be reached',
        { cause: err },
      );
    }
    if (res.ok) return res;
    throw await toApiError(res);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const headerRetry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const parsed = schema.errorResponse.safeParse(json);
  if (!parsed.success) {
    // A proxy error page, or not a Tazamun server at all.
    const code =
      res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'UNAVAILABLE' : 'HTTP_ERROR';
    return new ApiError(
      res.status,
      code,
      `HTTP ${String(res.status)}`,
      Number.isNaN(headerRetry) ? undefined : headerRetry,
    );
  }
  const { code, message, retryAfter } = parsed.data.error;
  return new ApiError(
    res.status,
    code,
    message,
    retryAfter ?? (Number.isNaN(headerRetry) ? undefined : headerRetry),
  );
}
