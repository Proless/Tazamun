/**
 * From the browser's windows to the `tabs` record data (TAB-1…4, TAB-10), as pure functions so
 * every filtering rule is unit-tested.
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

/**
 * TAB-10: carry the recently closed list forward. Tabs open in `previous` (this device's last
 * record) but not in `live` were closed since: they go to the front with `closedAt = now`. A URL
 * that is open again leaves the list, each URL appears once (the newest), entries older than
 * seven days drop out, and at most RECENT_TABS_MAX are kept. `keep` applies the same rules as for
 * open tabs (exclusions, schemes, private windows), so a site excluded later disappears here too.
 *
 * Closing the last window, or every tab, therefore moves them all here instead of erasing them.
 */
export function withRecent(
  live: schema.TabsData,
  previous: schema.TabsData | undefined,
  now: number,
  keep: (entry: schema.RecentTab) => boolean,
): schema.TabsData {
  const open = new Set(live.windows.flatMap((w) => w.tabs.map((t) => t.url)));
  const closed: schema.RecentTab[] = [];
  for (const window of previous?.windows ?? []) {
    for (const tab of window.tabs) {
      if (open.has(tab.url)) continue;
      closed.push({
        url: tab.url,
        title: tab.title,
        closedAt: now,
        ...(window.private === true ? { private: true } : {}),
      });
    }
  }
  const oldest = now - schema.RECENT_TABS_MAX_AGE_MS;
  const seen = new Set<string>();
  const recent: schema.RecentTab[] = [];
  for (const entry of [...closed, ...(previous?.recent ?? [])]) {
    if (open.has(entry.url) || seen.has(entry.url)) continue;
    if (entry.closedAt < oldest || !keep(entry)) continue;
    seen.add(entry.url);
    recent.push(entry);
    if (recent.length === schema.RECENT_TABS_MAX) break;
  }
  return recent.length === 0 ? live : { ...live, recent };
}
