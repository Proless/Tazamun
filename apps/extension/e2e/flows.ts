/** What a user does, step by step, on any driven browser. */
import type { Device, ExtPage } from './drivers.ts';

export const PASSPHRASE = 'mango tiger lamp ocean violet';

async function waitFor<T>(
  get: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export { waitFor };

/** SRS 3.1 step 1. Returns the pairing code from the recovery kit. */
export async function createAccount(device: Device, server: string, name: string): Promise<string> {
  const page = await device.open('onboarding.html');
  await page.click('Create an account');
  await page.fill('#server', server);
  await page.click('Continue');
  await page.waitForText('Device name');
  await page.fill('#device-name', name);
  await page.click('Continue');
  await page.waitForText('Your passphrase');
  await page.fill('#passphrase', PASSPHRASE);
  await page.fill('#confirmation', PASSPHRASE);
  await page.eval(
    `(() => { const c = document.querySelector('.warning input'); c.click(); return true; })()`,
  );
  await page.click('Create account');
  await page.waitForText('Pairing code', 60_000);
  const code = await page.eval<string>(
    `document.querySelector('.kit code.wrap').textContent.trim()`,
  );
  await page.close();
  return code;
}

/** SRS 3.1 step 2, with the pairing code. */
export async function connectAccount(
  device: Device,
  pairingCode: string,
  name: string,
): Promise<void> {
  const page = await device.open('onboarding.html');
  await page.click('Connect to an existing account');
  await page.fill('#server', pairingCode);
  await page.click('Continue');
  await page.waitForText('Device name');
  await page.fill('#device-name', name);
  await page.click('Continue');
  await page.waitForText('Sign in');
  await page.fill('#passphrase', PASSPHRASE);
  await page.click('Connect');
  await page.waitForText('This browser is connected', 60_000);
  await page.close();
}

/** URLs of the tabs `device` currently has open (for assertions). */
export function openUrls(device: Device): Promise<string[]> {
  return device.ext<string[]>(
    `api.tabs.query({}).then((ts) => ts.map((t) => t.url || t.pendingUrl || ''))`,
  );
}

/** The popup, opened as a tab. Opening it syncs right away (ENG-5). */
export function popup(device: Device): Promise<ExtPage> {
  return device.open('popup.html');
}

/** The engine status the background published. */
export function status(device: Device): Promise<{ state: string; pending: number } | undefined> {
  return device.ext(`api.storage.local.get('engineStatus').then((s) => s.engineStatus)`);
}

/**
 * TAB-7 through the popup's "Send this tab": make the web page the active tab, then open the popup
 * (it acts on the active tab of its window) and click the target.
 */
export async function sendFromPopup(
  device: Device,
  urlPrefix: string,
  target: string,
): Promise<void> {
  await device.ext(`api.tabs.query({}).then(async (ts) => {
    const t = ts.find((x) => (x.url || '').startsWith(${JSON.stringify(urlPrefix)}));
    await api.tabs.update(t.id, { active: true });
    return true;
  })`);
  const page = await popup(device);
  // Opening the popup as a tab made it the active one; point it back at the web page.
  await device.ext(`api.tabs.query({}).then(async (ts) => {
    const t = ts.find((x) => (x.url || '').startsWith(${JSON.stringify(urlPrefix)}));
    await api.tabs.update(t.id, { active: true });
    return true;
  })`);
  await page.reload();
  await page.click(`Send to ${target}`);
  await page.waitForText('Sent.');
  await page.close();
}
