import type { Browser, WxtBrowser } from 'wxt/browser';

/** The onboarding page (UI-2), an unlisted extension page. */
export const ONBOARDING_PATH = '/onboarding.html';

/**
 * `runtime.onInstalled`: open onboarding on a fresh install (UI-2). Updates and browser updates
 * do nothing, so a user is never sent back to onboarding by an extension update.
 */
export async function onInstalled(
  browser: WxtBrowser,
  details: Browser.runtime.InstalledDetails,
): Promise<void> {
  if (details.reason !== 'install') return;
  await browser.tabs.create({ url: browser.runtime.getURL(ONBOARDING_PATH) });
}
