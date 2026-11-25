import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ONBOARDING_PATH, onInstalled } from './install.ts';

/** URLs of tabs opened since the test started (the fake browser starts with one blank tab). */
async function openedUrls(before: Set<number | undefined>): Promise<(string | undefined)[]> {
  const tabs = await fakeBrowser.tabs.query({});
  return tabs.filter((tab) => !before.has(tab.id)).map((tab) => tab.url);
}

describe('onInstalled (UI-2)', () => {
  let before: Set<number | undefined>;

  beforeEach(async () => {
    fakeBrowser.reset();
    before = new Set((await fakeBrowser.tabs.query({})).map((tab) => tab.id));
  });

  it('opens onboarding on a fresh install', async () => {
    await onInstalled(browser, { reason: 'install' });
    expect(await openedUrls(before)).toEqual([fakeBrowser.runtime.getURL(ONBOARDING_PATH)]);
  });

  it('does nothing on an extension or browser update', async () => {
    await onInstalled(browser, { reason: 'update', previousVersion: '0.0.1' });
    await onInstalled(browser, { reason: 'chrome_update' });
    expect(await openedUrls(before)).toEqual([]);
  });
});
