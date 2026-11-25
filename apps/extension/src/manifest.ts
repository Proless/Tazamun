/**
 * The extension manifest, per browser (SRS 2.7, 6.2). A pure function, so the permissions, CSP
 * and Firefox ID are unit-tested instead of found out in store review. `wxt.config.ts` passes it
 * to WXT, which adds the entrypoints, the version and the background script.
 */

export type TargetBrowser = 'chrome' | 'edge' | 'firefox';

/**
 * The fixed Firefox add-on ID (SRS 6.2). AMO ties every version, review and user to it, so it
 * can never change after the first upload.
 */
export const FIREFOX_ADDON_ID = 'tazamun@proless.github.io';

/**
 * Firefox 140 (ESR): the first release with built-in data-collection consent. New add-ons must
 * use it, and older releases would need a consent screen of our own.
 */
export const FIREFOX_MIN_VERSION = '140.0';

/**
 * Firefox's data-collection disclosure (AMO policy). Sending data to a server outside the browser
 * counts as collection even though the user runs the server and it only sees ciphertext, so it is
 * declared honestly:
 * - required `browsingActivity`: open tabs (P1) and history (P2), the core function;
 * - optional `bookmarksInfo` (P4) and `technicalAndInteraction` (the extension list, P5), asked
 *   for when the user turns those modules on, like their browser permissions.
 * Re-check the categories against Mozilla's current policy before each AMO submission.
 */
export const FIREFOX_DATA_COLLECTION = {
  required: ['browsingActivity'],
  optional: ['bookmarksInfo', 'technicalAndInteraction'],
} as const;

/**
 * SRS 2.7: `'wasm-unsafe-eval'` for Argon2id (hash-wasm) is the only relaxation allowed. Nothing
 * else: no `'unsafe-eval'`, no remote script sources.
 */
export const EXTENSION_PAGES_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

/**
 * Always granted. Each one is used in P1:
 * - `tabs`: read URLs and titles of open tabs (TAB-1); open sent tabs (TAB-7)
 * - `storage`, `unlimitedStorage`: settings, keys (SEC-5), outbox and mirror in IndexedDB
 * - `alarms`: the sync poll, since timers die with the background context (ENG-5)
 * - `notifications`: "a tab was sent to you" (TAB-8)
 * - `contextMenus`: "Send page/link to device" (UI-4). Firefox accepts this name for `menus`.
 */
export const REQUIRED_PERMISSIONS = [
  'tabs',
  'storage',
  'unlimitedStorage',
  'alarms',
  'notifications',
  'contextMenus',
] as const;

/**
 * Requested when the user turns the module on, not at install (PRIV-2). Store reviewers look
 * hardest at these, and adding a required permission later makes Chrome disable the extension
 * until the user accepts it.
 */
export const OPTIONAL_PERMISSIONS = [
  'history', // P2
  'bookmarks', // P4
  'management', // P5
] as const;

/**
 * The server URL is chosen by the user, so host access is optional and requested for that one
 * origin at sign-in (`permissions.request({ origins: [serverOrigin] })`). Plain http only for
 * local servers, matching the server's own rule (DEP-14).
 */
export const OPTIONAL_HOST_PERMISSIONS = [
  'https://*/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
] as const;

/**
 * Toolbar, extensions page, stores and notifications (Chrome requires an icon for those). The
 * files are in `public/icons/`. A placeholder until there is a real design.
 */
export const ICONS = {
  '16': 'icons/16.png',
  '32': 'icons/32.png',
  '48': 'icons/48.png',
  '128': 'icons/128.png',
} as const;

export interface ManifestFields {
  name: string;
  description: string;
  default_locale: string;
  permissions: string[];
  optional_permissions: string[];
  optional_host_permissions: string[];
  content_security_policy: { extension_pages: string };
  icons: Record<string, string>;
  action: { default_title: string; default_icon: Record<string, string> };
  browser_specific_settings?: {
    gecko: {
      id: string;
      strict_min_version: string;
      data_collection_permissions: { required: string[]; optional: string[] };
    };
  };
}

export function manifestFor(browser: TargetBrowser): ManifestFields {
  const manifest: ManifestFields = {
    // Names and descriptions come from _locales (SRS 6.3), so stores show translated listings.
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: [...REQUIRED_PERMISSIONS],
    optional_permissions: [...OPTIONAL_PERMISSIONS],
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    content_security_policy: { extension_pages: EXTENSION_PAGES_CSP },
    icons: { ...ICONS },
    action: { default_title: '__MSG_extName__', default_icon: { ...ICONS } },
  };
  if (browser === 'firefox') {
    manifest.browser_specific_settings = {
      gecko: {
        id: FIREFOX_ADDON_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: {
          required: [...FIREFOX_DATA_COLLECTION.required],
          optional: [...FIREFOX_DATA_COLLECTION.optional],
        },
      },
    };
  }
  return manifest;
}
