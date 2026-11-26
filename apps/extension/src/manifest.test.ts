import { describe, expect, it } from 'vitest';
import {
  EXTENSION_PAGES_CSP,
  FIREFOX_ADDON_ID,
  manifestFor,
  type TargetBrowser,
} from './manifest.ts';

const BROWSERS: TargetBrowser[] = ['chrome', 'edge', 'firefox'];

describe('manifestFor (SRS 2.7, 6.2)', () => {
  it.each(BROWSERS)('%s: requests exactly the P1 permissions, the rest optional', (browser) => {
    const m = manifestFor(browser);
    expect(m.permissions.sort()).toEqual(['alarms', 'storage', 'tabs', 'unlimitedStorage'].sort());
    expect(m.optional_permissions.sort()).toEqual(['bookmarks', 'history', 'management']);
    // Host access only through the optional, per-origin grant for the user's server.
    expect(m).not.toHaveProperty('host_permissions');
    expect(m.optional_host_permissions).not.toContain('<all_urls>');
    expect(m.optional_host_permissions.filter((p) => p.startsWith('http://'))).toEqual([
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
  });

  it.each(BROWSERS)("%s: relaxes the CSP only with 'wasm-unsafe-eval'", (browser) => {
    const csp = manifestFor(browser).content_security_policy.extension_pages;
    expect(csp).toBe(EXTENSION_PAGES_CSP);
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'|https?:|\*/);
  });

  it.each(BROWSERS)('%s: takes its name and description from _locales (SRS 6.3)', (browser) => {
    const m = manifestFor(browser);
    expect(m.name).toBe('__MSG_extName__');
    expect(m.description).toBe('__MSG_extDescription__');
    expect(m.default_locale).toBe('en');
  });

  it('gives Firefox its fixed add-on ID and data-collection disclosure', () => {
    const gecko = manifestFor('firefox').browser_specific_settings?.gecko;
    expect(gecko?.id).toBe(FIREFOX_ADDON_ID);
    expect(gecko?.strict_min_version).toBe('140.0');
    expect(gecko?.data_collection_permissions.required).toEqual(['browsingActivity']);
    // Mozilla doesn't allow technicalAndInteraction as required.
    expect(gecko?.data_collection_permissions.required).not.toContain('technicalAndInteraction');
  });

  it('keeps Firefox-only settings out of Chromium manifests', () => {
    expect(manifestFor('chrome')).not.toHaveProperty('browser_specific_settings');
    expect(manifestFor('edge')).not.toHaveProperty('browser_specific_settings');
  });
});
