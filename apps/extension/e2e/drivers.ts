/**
 * One small interface over two browsers, so every scenario runs the same way in both:
 * - Chromium through Playwright (a persistent profile with the extension loaded);
 * - Firefox, the installed release, through WebDriver BiDi (`webExtension.install`). Playwright's
 *   own Firefox can't load extensions, and `web-ext run` can't drive pages.
 *
 * Both load a copy of the build whose manifest already grants `http://localhost/*`: headless
 * browsers can't click the permission prompt, and a granted origin is answered without one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { freePort } from './server.ts';

const OUTPUT = resolve(import.meta.dirname, '../.output');
const FIREFOX_ID = 'tazamun@proless.github.io';
/** Fixed extension UUID, so the test knows the moz-extension:// origin. */
const FIREFOX_UUID = '6f0c2b1e-7d3a-4e59-9b8c-3a1d2e4f5a60';

export interface ExtPage {
  /** Evaluate a JavaScript expression in the page; promises are awaited. */
  eval<T>(expression: string): Promise<T>;
  /** Click the first enabled button whose text contains `text`, with real input. */
  click(text: string): Promise<void>;
  /** Set an input's or textarea's value as typing would (fires `input`). */
  fill(selector: string, value: string): Promise<void>;
  /** The visible text of `main`. */
  text(): Promise<string>;
  /** Wait until `main` contains `text`. */
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

export interface Device {
  readonly name: string;
  readonly kind: 'chromium' | 'firefox';
  /** Open an extension page (`popup.html`, …) in a tab. */
  open(path: string): Promise<ExtPage>;
  /** Open a web page in a new tab. */
  openWeb(url: string): Promise<void>;
  /**
   * Evaluate an expression in an extension context, with `api` bound to the extension API
   * (`browser` in Firefox, `chrome` in Chromium).
   */
  ext<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

/** A copy of the build for `target`, with the localhost host permission granted. */
function testBuild(target: 'chrome-mv3' | 'firefox-mv3'): string {
  const source = join(OUTPUT, target);
  if (!existsSync(join(source, 'manifest.json'))) {
    throw new Error(`No build in ${source}. Run: pnpm --filter @tazamun/extension build`);
  }
  const dir = mkdtempSync(join(tmpdir(), `tz-e2e-${target}-`));
  cpSync(source, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['host_permissions'] = ['http://localhost/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return dir;
}

const wrap = (expression: string) =>
  `(async () => { const api = globalThis.browser ?? globalThis.chrome; return (${expression}); })()`;

async function poll(check: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const clickScript = (text: string) => `(() => {
  const b = [...document.querySelectorAll('button')]
    .find((e) => !e.disabled && e.textContent.includes(${JSON.stringify(text)}));
  if (!b) return null;
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

const fillScript = (selector: string, value: string) => `(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  if (!e) throw new Error('No element ' + ${JSON.stringify(selector)});
  e.value = ${JSON.stringify(value)};
  e.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

// ---- Chromium --------------------------------------------------------------------------------------

export async function launchChromium(name: string): Promise<Device> {
  const extension = testBuild('chrome-mv3');
  const profile = mkdtempSync(join(tmpdir(), `tz-e2e-profile-${name}-`));
  const context: BrowserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker: Worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const id = new URL(worker.url()).host;
  // The background may be restarted; always ask for the current worker.
  const currentWorker = () => context.serviceWorkers()[0] ?? worker;

  const wrapPage = (page: Page): ExtPage => ({
    eval: (expression) => page.evaluate(wrap(expression)),
    click: async (text) => {
      await page.locator('button:not([disabled])', { hasText: text }).first().click();
    },
    fill: async (selector, value) => {
      await page.fill(selector, value);
    },
    text: () => page.locator('main').innerText(),
    waitForText: async (text, timeoutMs = 15_000) => {
      await page.locator('main', { hasText: text }).waitFor({ timeout: timeoutMs });
    },
    reload: async () => {
      await page.reload();
      await page.waitForSelector('main h1');
    },
    close: async () => {
      if (!page.isClosed()) await page.close();
    },
  });

  return {
    name,
    kind: 'chromium',
    open: async (path) => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/${path}`);
      await page.waitForSelector('main h1');
      return wrapPage(page);
    },
    openWeb: async (url) => {
      const page = await context.newPage();
      await page.goto(url);
    },
    ext: (expression) => currentWorker().evaluate(wrap(expression)),
    close: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
      rmSync(extension, { recursive: true, force: true });
    },
  };
}

// ---- Firefox (WebDriver BiDi) ----------------------------------------------------------------------

/** Where Firefox is: FIREFOX_BINARY, or the usual install locations. */
export function findFirefox(): string | undefined {
  const candidates = [
    process.env['FIREFOX_BINARY'],
    'C:/Program Files/Mozilla Firefox/firefox.exe',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/usr/bin/firefox',
    '/usr/lib/firefox/firefox',
    '/snap/bin/firefox',
  ];
  return candidates.find((c): c is string => c !== undefined && c !== '' && existsSync(c));
}

interface BidiResult {
  type: 'success' | 'error';
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
}

class Bidi {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, (m: BidiResult) => void>();
  #id = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as BidiResult & { id?: number };
      if (message.id !== undefined) {
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      }
    };
  }

  static async connect(port: number): Promise<Bidi> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/session`);
        await new Promise<void>((resolveOpen, reject) => {
          ws.onopen = () => {
            resolveOpen();
          };
          ws.onerror = () => {
            reject(new Error('BiDi connection failed'));
          };
        });
        return new Bidi(ws);
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    const reply = await new Promise<BidiResult>((r) => {
      this.#pending.set(id, r);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
    if (reply.type !== 'success') {
      throw new Error(`${method}: ${reply.error ?? ''} ${reply.message ?? ''}`.slice(0, 500));
    }
    return reply.result ?? {};
  }

  async evaluate<T>(context: string, expression: string): Promise<T> {
    const result = await this.send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
      serializationOptions: { maxObjectDepth: 20 },
    });
    if (result['type'] === 'exception') {
      const details = result['exceptionDetails'] as { text?: string } | undefined;
      throw new Error(`Script error: ${details?.text ?? 'unknown'}`);
    }
    return deserialize(result['result']) as T;
  }

  close(): void {
    this.#ws.close();
  }
}

/** BiDi's remote values to plain JSON. */
function deserialize(value: unknown): unknown {
  const v = value as { type: string; value?: unknown };
  switch (v.type) {
    case 'undefined':
    case 'null':
      return v.type === 'null' ? null : undefined;
    case 'string':
    case 'number':
    case 'boolean':
      return v.value;
    case 'array':
      return (v.value as unknown[]).map(deserialize);
    case 'object':
      return Object.fromEntries(
        (v.value as [unknown, unknown][]).map(([k, val]) => [
          typeof k === 'string' ? k : deserialize(k),
          deserialize(val),
        ]),
      );
    default:
      return v.value;
  }
}

export async function launchFirefox(name: string, binary: string): Promise<Device> {
  const extension = testBuild('firefox-mv3');
  const profile = mkdtempSync(join(tmpdir(), `tz-e2e-profile-${name}-`));
  const prefs = {
    'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }),
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'browser.aboutwelcome.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore',
  };
  writeFileSync(
    join(profile, 'user.js'),
    Object.entries(prefs)
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
      .join('\n'),
  );
  const port = await freePort();
  const child: ChildProcess = spawn(
    binary,
    ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${String(port)}`],
    {
      stdio: 'ignore',
      // Lets WebDriver BiDi run script in moz-extension:// pages. Test only.
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    },
  );
  const bidi = await Bidi.connect(port);
  await bidi.send('session.new', { capabilities: {} });
  await bidi.send('webExtension.install', { extensionData: { type: 'path', path: extension } });
  const origin = `moz-extension://${FIREFOX_UUID}`;

  const contexts = async () =>
    (await bidi.send('browsingContext.getTree', {}))['contexts'] as {
      context: string;
      url: string;
    }[];

  // onInstalled opens onboarding (UI-2); that tab is the control context for `ext`.
  let control: string | undefined;
  await poll(
    async () => {
      control = (await contexts()).find((c) => c.url.startsWith(origin))?.context;
      return control !== undefined;
    },
    'the onboarding tab',
    20_000,
  );
  const ext = <T>(expression: string) => bidi.evaluate<T>(control ?? '', wrap(expression));

  const wrapPage = (context: string): ExtPage => {
    const page: ExtPage = {
      eval: (expression) => bidi.evaluate(context, wrap(expression)),
      click: async (text) => {
        let point: { x: number; y: number } | null = null;
        await poll(
          async () => {
            point = await bidi.evaluate<{ x: number; y: number } | null>(
              context,
              clickScript(text),
            );
            return point !== null;
          },
          `button "${text}"`,
          15_000,
        );
        const { x, y } = point as unknown as { x: number; y: number };
        await bidi.send('input.performActions', {
          context,
          actions: [
            {
              type: 'pointer',
              id: 'mouse',
              actions: [
                { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
                { type: 'pointerDown', button: 0 },
                { type: 'pointerUp', button: 0 },
              ],
            },
          ],
        });
      },
      fill: async (selector, value) => {
        await bidi.evaluate(context, fillScript(selector, value));
      },
      text: () => bidi.evaluate<string>(context, `document.querySelector('main')?.innerText ?? ''`),
      waitForText: (text, timeoutMs = 15_000) =>
        poll(
          async () => (await page.text().catch(() => '')).includes(text),
          `"${text}"`,
          timeoutMs,
        ),
      reload: async () => {
        await bidi.send('browsingContext.reload', { context, wait: 'complete' });
        await poll(async () => (await page.text().catch(() => '')) !== '', 'reload', 10_000);
      },
      close: async () => {
        await bidi.send('browsingContext.close', { context }).catch(() => undefined);
      },
    };
    return page;
  };

  return {
    name,
    kind: 'firefox',
    open: async (path) => {
      const before = new Set((await contexts()).map((c) => c.context));
      await ext(`api.tabs.create({ url: api.runtime.getURL('/${path}') }).then(() => true)`);
      let context: string | undefined;
      await poll(
        async () => {
          context = (await contexts()).find(
            (c) => !before.has(c.context) && c.url === `${origin}/${path}`,
          )?.context;
          return context !== undefined;
        },
        `${path} to open`,
        15_000,
      );
      const page = wrapPage(context ?? '');
      await poll(
        async () =>
          await bidi
            .evaluate<boolean>(context ?? '', `!!document.querySelector('main h1')`)
            .catch(() => false),
        `${path} to render`,
        15_000,
      );
      return page;
    },
    openWeb: async (url) => {
      const id = await ext<number>(
        `api.tabs.create({ url: ${JSON.stringify(url)} }).then((t) => t.id)`,
      );
      await poll(
        async () =>
          (await ext<string>(`api.tabs.get(${String(id)}).then((t) => t.status + ' ' + t.url)`)) ===
          `complete ${url}`,
        `${url} to load`,
        15_000,
      );
    },
    ext,
    close: async () => {
      bidi.close();
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      rmSync(extension, { recursive: true, force: true });
    },
  };
}
