/**
 * The real Tazamun server as a child process, on a free port with a temporary data directory,
 * and a tiny local website to open as tabs (the tests make no requests to the internet).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAIN = resolve(import.meta.dirname, '../../server/src/main.ts');

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('No port'));
        else resolvePort(address.port);
      });
    });
  });
}

export class TestServer {
  readonly port: number;
  readonly dataDir: string;
  #process: ChildProcess | undefined;
  #log = '';

  private constructor(port: number, dataDir: string) {
    this.port = port;
    this.dataDir = dataDir;
  }

  static async start(): Promise<TestServer> {
    const server = new TestServer(await freePort(), mkdtempSync(join(tmpdir(), 'tz-e2e-data-')));
    await server.restart();
    return server;
  }

  /** As the user types it in onboarding: a bare loopback address becomes http (SRS 3.1). */
  get address(): string {
    return `localhost:${String(this.port)}`;
  }

  get url(): string {
    return `http://localhost:${String(this.port)}`;
  }

  get log(): string {
    return this.#log;
  }

  /** Start (again) on the same port and data directory. */
  async restart(): Promise<void> {
    if (this.#process !== undefined) throw new Error('Already running');
    const child = spawn(process.execPath, [MAIN, 'serve'], {
      env: {
        ...process.env,
        TAZAMUN_PUBLIC_URL: this.url,
        TAZAMUN_PORT: String(this.port),
        TAZAMUN_DATA_DIR: this.dataDir,
        TAZAMUN_REGISTRATION: 'open',
        TAZAMUN_LOG_FORMAT: 'json',
        // The suite signs in several devices from one IP in quick succession.
        TAZAMUN_AUTH_RATE_LIMIT_PER_MINUTE: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => (this.#log += d.toString()));
    child.stderr.on('data', (d: Buffer) => (this.#log += d.toString()));
    this.#process = child;
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${this.url}/v1/health`)).ok) return;
      } catch {
        // Not listening yet.
      }
      if (child.exitCode !== null) throw new Error(`Server exited:\n${this.#log}`);
      if (Date.now() > deadline) throw new Error(`Server did not start:\n${this.#log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Kill it hard, as a crash or a power cut would (REL-3). */
  async kill(): Promise<void> {
    const child = this.#process;
    if (child === undefined) return;
    this.#process = undefined;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }

  async stop(): Promise<void> {
    await this.kill();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

/** Pages at http://localhost:<port>/<anything> with the path as their title. */
export async function startSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const port = await freePort();
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Page ${req.url ?? ''}</title><h1>${req.url ?? ''}</h1>`);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://localhost:${String(port)}`,
    close: () =>
      new Promise((r) => {
        server.close(() => {
          r();
        });
      }),
  };
}
