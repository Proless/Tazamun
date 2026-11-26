/**
 * From the browser's windows to the `tabs` record data (TAB-1…4), as a pure function so every
 * filtering rule is unit-tested.
 */
import { schema } from '@tazamun/core';
import { isSyncableUrl, type Exclusion } from '../../lib/exclusions.ts';

/** The parts of `browser.windows.Window` and `browser.tabs.Tab` this module reads. */
export interface BrowserTab {
  readonly url?: string;
  readonly title?: string;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly incognito: boolean;
  readonly lastAccessed?: number;
  readonly favIconUrl?: string;
  readonly index: number;
}

export interface BrowserWindow {
  readonly incognito: boolean;
  readonly focused: boolean;
  readonly type?: string;
  readonly tabs?: readonly BrowserTab[];
}

/**
 * TAB-4: keep a favicon only if it is an https URL of at most 512 characters. `data:` icons are
 * stripped (they bloat every record); local and privileged ones mean nothing elsewhere.
 */
export function syncableFavicon(url: string | undefined): string | undefined {
  if (url === undefined || url.length > schema.MAX_FAVICON_URL_LENGTH) return undefined;
  return url.startsWith('https://') ? url : undefined;
}

export interface BuildOptions {
  readonly exclusions: readonly Exclusion[];
  /** TAB-2, PRIV-1: the user's choice for this browser; off by default. */
  readonly includePrivate: boolean;
}

export function buildTabsData(
  windows: readonly BrowserWindow[],
  options: BuildOptions,
): schema.TabsData {
  const { exclusions, includePrivate } = options;
  const result: schema.TabWindow[] = [];
  for (const window of windows) {
    // TAB-2 (PRIV-1): unless the user chose otherwise, private windows never leave the device,
    // not even as an empty window.
    if (window.incognito && !includePrivate) continue;
    if (window.type !== undefined && window.type !== 'normal') continue;
    const tabs: schema.Tab[] = [];
    for (const tab of [...(window.tabs ?? [])].sort((a, b) => a.index - b.index)) {
      if (tab.incognito && !includePrivate) continue;
      const url = tab.url;
      // TAB-3: privileged, local and excluded URLs are dropped.
      if (url === undefined || !isSyncableUrl(url, exclusions)) continue;
      const favIconUrl = syncableFavicon(tab.favIconUrl);
      tabs.push({
        url,
        title: tab.title ?? '',
        pinned: tab.pinned,
        active: tab.active,
        ...(tab.lastAccessed === undefined ? {} : { lastAccessed: Math.floor(tab.lastAccessed) }),
        ...(favIconUrl === undefined ? {} : { favIconUrl }),
      });
    }
    if (tabs.length > 0) {
      result.push({
        focused: window.focused,
        ...(window.incognito ? { private: true } : {}),
        tabs,
      });
    }
  }
  return { windows: result };
}
