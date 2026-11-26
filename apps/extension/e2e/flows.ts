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

/** SRS 3.1 step 1. Returns the recovery key, shown once (ACC-5). */
export async function createAccount(
  device: Device,
  server: string,
  username: string,
  name: string,
): Promise<string> {
  const page = await device.open('onboarding.html');
  await page.click('Create an account');
  await page.fill('#server', server);
  await page.click('Continue');
  await page.waitForText('Device name');
  await page.fill('#device-name', name);
  await page.click('Continue');
  await page.waitForText('Your passphrase');
  await page.fill('#username', username);
  await page.fill('#passphrase', PASSPHRASE);
  await page.fill('#confirmation', PASSPHRASE);
  await page.eval(
    `(() => { const c = document.querySelector('.warning input'); c.click(); return true; })()`,
  );
  await page.click('Create account');
  await page.waitForText('Your recovery key', 60_000);
  const key = await page.eval<string>(
    `document.querySelector('.recovery .key code').textContent.trim()`,
  );
  await page.eval(
    `(() => { const c = document.querySelector('.check input'); c.click(); return true; })()`,
  );
  await page.click('Continue');
  await page.waitForText('This browser is connected');
  await page.close();
  return key;
}

/** SRS 3.1 step 2: server, username and passphrase. */
export async function connectAccount(
  device: Device,
  server: string,
  username: string,
  name: string,
): Promise<void> {
  const page = await device.open('onboarding.html');
  await page.click('Sign in to an existing account');
  await page.fill('#server', server);
  await page.click('Continue');
  await page.waitForText('Device name');
  await page.fill('#device-name', name);
  await page.click('Continue');
  await page.waitForText('Sign in');
  await page.fill('#username', username);
  await page.fill('#passphrase', PASSPHRASE);
  await page.click('Connect');
  await page.waitForText('This browser is connected', 60_000);
  await page.close();
}

/** ACC-5: the passphrase is forgotten; set a new one with the recovery key. */
export async function recoverAccount(
  device: Device,
  server: string,
  username: string,
  recoveryKey: string,
  newPassphrase: string,
): Promise<void> {
  const page = await device.open('onboarding.html');
  await page.click('Sign in to an existing account');
  await page.fill('#server', server);
  await page.click('Continue');
  await page.waitForText('Device name');
  await page.click('Continue');
  await page.waitForText('Sign in');
  await page.click('Forgot your passphrase?');
  await page.waitForText('Set a new passphrase');
  await page.fill('#username', username);
  await page.fill('#recovery-key', recoveryKey);
  await page.fill('#passphrase', newPassphrase);
  await page.fill('#confirmation', newPassphrase);
  await page.click('Set new passphrase');
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
