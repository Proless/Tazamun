/**
 * What this device registers as (ACC-7): browser family and version, and a default name the user
 * can edit, such as "Firefox on Windows". Extensions can't read the browser profile's name, so the
 * user adds it when they have several profiles.
 */

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'chromium';

export interface BrowserIdentity {
  readonly family: BrowserFamily;
  /** Major version: Chromium reduces the user agent to `MAJOR.0.0.0` anyway. */
  readonly version: string;
  /** Product name for the default device name. Not translated: it's a brand. */
  readonly displayName: string;
}

const DISPLAY: Record<BrowserFamily, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  chromium: 'Chromium',
};

/**
 * From the user agent, which every target exposes the same way. Order matters: Edge's user agent
 * also contains `Chrome/`.
 */
export function detectBrowser(userAgent: string): BrowserIdentity {
  const match = (pattern: RegExp) => pattern.exec(userAgent)?.[1];
  const candidates: [BrowserFamily, string | undefined][] = [
    ['firefox', match(/Firefox\/(\d+)/)],
    ['edge', match(/Edg(?:e|A|iOS)?\/(\d+)/)],
    ['chrome', match(/Chrome\/(\d+)/)],
  ];
  for (const [family, version] of candidates) {
    if (version !== undefined) return { family, version, displayName: DISPLAY[family] };
  }
  return { family: 'chromium', version: '0', displayName: DISPLAY.chromium };
}

const OS_NAMES: Record<string, string> = {
  win: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  cros: 'ChromeOS',
  openbsd: 'OpenBSD',
  fuchsia: 'Fuchsia',
  android: 'Android',
};

/** `browser.runtime.getPlatformInfo().os` → a product name, or undefined if unknown. */
export function osDisplayName(os: string): string | undefined {
  return OS_NAMES[os];
}
