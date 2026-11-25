/**
 * The server URL a user types during onboarding (SRS 3.1, SRS 4.4.1: HTTPS only, plain HTTP only
 * for localhost).
 */

export class ServerUrlError extends RangeError {
  readonly reason: 'invalid' | 'insecure' | 'credentials' | 'query';

  constructor(reason: ServerUrlError['reason']) {
    super(`Invalid server URL (${reason})`);
    this.name = 'ServerUrlError';
    this.reason = reason;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalize user input to `scheme://host[:port][/path]` without a trailing slash, so the same
 * server always gives the same string (it's stored, shown in the recovery kit and put into pairing
 * codes). `sync.example.org` becomes `https://sync.example.org`, `localhost:8080`
 * becomes `http://localhost:8080`.
 *
 * Throws ServerUrlError for anything that isn't HTTPS (or HTTP on a loopback host), and for URLs
 * with credentials, a query or a fragment.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new ServerUrlError('invalid');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  // Without a scheme, loopback means a development server (plain HTTP); anything else is HTTPS.
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `${loopback ? 'http' : 'https'}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ServerUrlError('invalid');
  }
  if (url.hostname === '') throw new ServerUrlError('invalid');
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new ServerUrlError('insecure');
  } else if (url.protocol !== 'https:') {
    throw new ServerUrlError('invalid');
  }
  if (url.username !== '' || url.password !== '') throw new ServerUrlError('credentials');
  if (url.search !== '' || url.hash !== '') throw new ServerUrlError('query');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * The match pattern for a host permission on the server (SRS 2.7: granted for the server URL
 * only). Match patterns have no port, and Firefox rejects one, so the pattern covers every port of
 * the host.
 */
export function hostPermissionPattern(serverUrl: string): string {
  const url = new URL(serverUrl);
  return `${url.protocol}//${url.hostname}/*`;
}
