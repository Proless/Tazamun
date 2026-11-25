/**
 * What never leaves the device (TAB-3, PRIV-3, and later HIS-5): privileged and local schemes, and
 * the user's exclusion list. Shared by every module that captures URLs.
 *
 * Exclusion patterns are host based, the way users think about sites:
 *   `bank.example`          the host and all its subdomains
 *   `*.bank.example`        the same (the `*.` is optional)
 *   `health.example/notes`  that host, only paths starting with /notes
 * Matching ignores case, the scheme, the port and a leading `www.`.
 */

/** TAB-3: schemes that are privileged, local or meaningless on another device. */
const BLOCKED_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'devtools:',
  'edge:',
  'extension:',
  'about:',
  'moz-extension:',
  'resource:',
  'view-source:',
  'file:',
  'data:',
  'blob:',
  'javascript:',
  'filesystem:',
]);

/** Only these are ever synced. Anything else is unknown, so it stays on the device. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'ftp:']);

/** Examples the options page offers (PRIV-3). Not active until the user adds them. */
export const EXCLUSION_EXAMPLES = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'paypal.com',
  'mail.google.com',
  'outlook.live.com',
] as const;

export interface Exclusion {
  readonly host: string;
  readonly pathPrefix: string;
}

/** Parse one user pattern; undefined for an empty or unusable one. */
export function parseExclusion(pattern: string): Exclusion | undefined {
  let rest = pattern.trim().toLowerCase();
  if (rest === '') return undefined;
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
  const slash = rest.indexOf('/');
  const hostPart = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);
  const host = stripWww(hostPart.replace(/:\d+$/, ''));
  if (host === '' || /[\s*]/.test(host)) return undefined;
  return { host, pathPrefix: path === '/' ? '' : path };
}

export function parseExclusions(patterns: readonly string[]): Exclusion[] {
  return patterns.map(parseExclusion).filter((e): e is Exclusion => e !== undefined);
}

/**
 * Whether a URL may be synced. False for blocked or unknown schemes, unparseable URLs, and
 * anything an exclusion matches.
 */
export function isSyncableUrl(url: string, exclusions: readonly Exclusion[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (BLOCKED_SCHEMES.has(parsed.protocol) || !ALLOWED_SCHEMES.has(parsed.protocol)) return false;
  const host = stripWww(parsed.hostname.toLowerCase());
  const path = parsed.pathname.toLowerCase();
  return !exclusions.some(
    (e) =>
      (host === e.host || host.endsWith(`.${e.host}`)) &&
      (e.pathPrefix === '' || path.startsWith(e.pathPrefix)),
  );
}

function stripWww(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}
