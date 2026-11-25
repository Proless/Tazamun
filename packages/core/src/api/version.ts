/**
 * Client compatibility (SRS 4.4.1): `/v1/info` reports `minClientVersion`, and an older client
 * must stop syncing and ask for an update instead of writing data the server no longer accepts.
 */

/** Compares `MAJOR.MINOR.PATCH` versions. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function isClientSupported(clientVersion: string, minClientVersion: string): boolean {
  return compareVersions(clientVersion, minClientVersion) >= 0;
}

function parse(version: string): number[] {
  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0] ?? '';
  const parts = core.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    throw new RangeError('Invalid version');
  }
  return parts;
}
