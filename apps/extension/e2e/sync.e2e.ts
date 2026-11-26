/**
 * End to end (P1): the real server, the built extension, two real browsers. Browser A is Chromium;
 * browser B is Firefox when it is installed, otherwise a second Chromium profile. The scenarios
 * run in order and share the account, like a user would.
 *
 * Run: pnpm --filter @tazamun/extension build && pnpm --filter @tazamun/extension test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFirefox, launchChromium, launchFirefox, type Device } from './drivers.ts';
import {
  connectAccount,
  createAccount,
  openUrls,
  popup,
  recoverAccount,
  sendFromPopup,
  status,
  waitFor,
} from './flows.ts';
import { TestServer, startSite } from './server.ts';

let server: TestServer;
let site: Awaited<ReturnType<typeof startSite>>;
let a: Device;
let b: Device;
let recoveryKey: string;
const USERNAME = 'e2e-user';

// E2E_BROWSER_B=chromium forces the fallback (two Chromium profiles).
const firefox = process.env['E2E_BROWSER_B'] === 'chromium' ? undefined : findFirefox();
const bLabel = firefox === undefined ? 'Chromium B' : 'Firefox B';

beforeAll(async () => {
  if (firefox === undefined) {
    process.stdout.write(
      'Browser B is a second Chromium profile (Firefox not found, or E2E_BROWSER_B=chromium).\n',
    );
  }
  server = await TestServer.start();
  site = await startSite();
  a = await launchChromium('A');
  b = firefox === undefined ? await launchChromium('B') : await launchFirefox('B', firefox);
}, 120_000);

afterAll(async () => {
  // Async wrappers, so a beforeAll that failed halfway (unset variables) still cleans up the rest.
  for (const close of [
    async () => a.close(),
    async () => b.close(),
    async () => site.close(),
    async () => server.stop(),
  ]) {
    await close().catch(() => undefined);
  }
}, 60_000);

/** Tab titles of other devices as B's or A's popup lists them. */
async function otherTabsText(device: Device): Promise<string> {
  const page = await popup(device);
  try {
    await page.waitForText('Tabs on other browsers');
    // Opening the popup syncs; give the pull a moment to land, then read again.
    await new Promise((r) => setTimeout(r, 1_500));
    await page.reload();
    await page.waitForText('Tabs on other browsers');
    return await page.text();
  } finally {
    await page.close();
  }
}

describe(`P1 end to end: Chromium A and ${bLabel}`, () => {
  it('creates an account on A and signs B in with the username (SRS 3.1, ACC-13)', async () => {
    recoveryKey = await createAccount(a, server.address, 'E2E-User', 'Chromium A');
    expect(recoveryKey).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    await connectAccount(b, server.address, USERNAME, bLabel);
    const devices = (await (
      await fetch(`${server.url}/v1/devices`, {
        headers: {
          authorization: `Bearer ${await a.ext<string>(`api.storage.local.get('account').then((s) => s.account.token)`)}`,
        },
      })
    ).json()) as { devices: { name: string }[] };
    expect(devices.devices.map((d) => d.name).sort()).toEqual(['Chromium A', bLabel].sort());
  }, 180_000);

  it("shows each browser's tabs on the other (TAB-1, TAB-6)", async () => {
    await a.openWeb(`${site.url}/from-a`);
    await b.openWeb(`${site.url}/from-b`);
    // TAB-5 debounce (5 s), then the push.
    // The device name comes from the device list, which the popup loads after the tabs.
    await waitFor(
      () => otherTabsText(b),
      (t) => t.includes('Page /from-a') && t.includes('Chromium A'),
      "A's tab on B",
      60_000,
    );
    await waitFor(
      () => otherTabsText(a),
      (t) => t.includes('Page /from-b') && t.includes(bLabel),
      "B's tab on A",
      60_000,
    );
  }, 180_000);

  it('sends a tab from A to B and from B to A (TAB-7, PERF-2)', async () => {
    await a.openWeb(`${site.url}/send-a-to-b`);
    await sendFromPopup(a, `${site.url}/send-a-to-b`, bLabel);
    // B opens it on its next sync; the popup triggers one, as the alarm would within 60 s.
    const started = Date.now();
    await waitFor(
      async () => {
        await (await popup(b)).close();
        return openUrls(b);
      },
      (urls) => urls.some((u) => u.endsWith('/send-a-to-b')),
      'the sent tab on B',
      60_000,
    );
    expect(Date.now() - started).toBeLessThan(90_000);

    await b.openWeb(`${site.url}/send-b-to-a`);
    await sendFromPopup(b, `${site.url}/send-b-to-a`, 'Chromium A');
    await waitFor(
      async () => {
        await (await popup(a)).close();
        return openUrls(a);
      },
      (urls) => urls.some((u) => u.endsWith('/send-b-to-a')),
      'the sent tab on A',
      60_000,
    );
  }, 240_000);

  it('loses nothing when the server is killed and comes back (REL-3)', async () => {
    await server.kill();
    await a.openWeb(`${site.url}/while-server-down`);
    // The change is detected and kept in the outbox; sync reports offline.
    await waitFor(
      async () => {
        await (await popup(a)).close();
        return status(a);
      },
      (s) => s?.state === 'offline' && s.pending > 0,
      'A offline with a pending change',
      60_000,
    );
    await server.restart();
    // Each failed sync above backed A off further (ENG-9); opening the popup (or "Sync now") goes
    // through the backoff, as a user would.
    await waitFor(
      async () => {
        await (await popup(a)).close();
        return status(a);
      },
      (s) => s?.state === 'idle' && s.pending === 0,
      'A to push the kept change',
      60_000,
    );
    await waitFor(
      () => otherTabsText(b),
      (t) => t.includes('Page /while-server-down'),
      'the change made while the server was down, on B',
      120_000,
    );
    const after = await status(a);
    expect(after?.pending).toBe(0);
  }, 300_000);

  it('signs B out at once when A removes it (ACC-8, ACC-11)', async () => {
    const options = await a.open('options.html');
    await options.waitForText(bLabel);
    await options.eval(`(() => { window.confirm = () => true; return true; })()`);
    await options.eval(`(() => {
      const row = [...document.querySelectorAll('.devices li')].find((li) => li.textContent.includes(${JSON.stringify(bLabel)}));
      row.querySelector('button').click();
      return true;
    })()`);
    await waitFor(
      () => options.text(),
      (t) => !t.includes(bLabel),
      'B gone from the list',
      20_000,
    );
    await options.close();

    const page = await popup(b);
    await page.waitForText('removed from your account', 20_000);
    await page.close();
    // Local data stays (ACC-11): the account is remembered for signing in again.
    const kept = await b.ext<{ serverUrl?: string; token?: string }>(
      `api.storage.local.get('account').then((s) => s.account)`,
    );
    expect(kept.serverUrl).toBe(server.url);
    expect(kept.token).toBeUndefined();
  }, 120_000);

  it('recovers B with the recovery key; every other browser signs out (ACC-5)', async () => {
    const NEW = 'a brand new passphrase for b';
    await recoverAccount(b, server.address, USERNAME, recoveryKey, NEW);
    const kept = await b.ext<{ token?: string; username?: string }>(
      `api.storage.local.get('account').then((s) => s.account)`,
    );
    expect(kept.token).toBeDefined();
    expect(kept.username).toBe(USERNAME);
    // A's session ended with the new passphrase (as after a passphrase change, ACC-9).
    const page = await popup(a);
    await page.waitForText('removed from your account', 20_000);
    await page.close();
  }, 180_000);

  it('never logs URLs, titles, usernames or keys on the server (rule 5)', () => {
    expect(server.log).not.toContain('/from-a');
    expect(server.log).not.toContain('Page ');
    expect(server.log).not.toContain('send-a-to-b');
    expect(server.log).not.toContain(USERNAME);
    expect(server.log).not.toContain(recoveryKey);
  });
});
