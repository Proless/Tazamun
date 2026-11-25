/**
 * Opening another device's tabs here (TAB-6), with the TAB-8 fallback: if the browser refuses a
 * URL, copy it to the clipboard instead and say so.
 */
import type { WxtBrowser } from 'wxt/browser';

export type OpenResult = 'opened' | 'copied' | 'failed';

export async function openTab(
  browser: WxtBrowser,
  url: string,
  clipboard: Pick<Clipboard, 'writeText'>,
): Promise<OpenResult> {
  try {
    await browser.tabs.create({ url, active: true });
    return 'opened';
  } catch {
    return copy(clipboard, url);
  }
}

/** All tabs of one window, in a new window, in their order. */
export async function openWindow(
  browser: WxtBrowser,
  urls: readonly string[],
  clipboard: Pick<Clipboard, 'writeText'>,
): Promise<OpenResult> {
  if (urls.length === 0) return 'failed';
  try {
    await browser.windows.create({ url: [...urls], focused: true });
    return 'opened';
  } catch {
    return copy(clipboard, urls.join('\n'));
  }
}

async function copy(clipboard: Pick<Clipboard, 'writeText'>, text: string): Promise<OpenResult> {
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
