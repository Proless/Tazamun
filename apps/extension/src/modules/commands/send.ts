/**
 * Which pages can be sent (TAB-7). Only web pages: a privileged or local page (`chrome://`,
 * `about:`, `file:`) can't be opened on another device anyway (TAB-8), and nothing from a private
 * window ever leaves the device (rule 7).
 */
export function isSendableUrl(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export type SendRefusal = 'private' | 'not-a-web-page';

export function sendRefusal(tab: {
  url?: string | undefined;
  incognito?: boolean;
}): SendRefusal | undefined {
  if (tab.incognito === true) return 'private';
  if (!isSendableUrl(tab.url)) return 'not-a-web-page';
  return undefined;
}
