import type { WxtBrowser } from 'wxt/browser';
import { ONBOARDING_PATH } from '../background/install.ts';

/** Open onboarding in a new tab (UI-2). */
export async function openOnboarding(browser: WxtBrowser): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(ONBOARDING_PATH) });
}
