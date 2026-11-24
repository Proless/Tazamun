/**
 * Entry point of the `tazamun` command: `node src/main.ts [command]`. Without a command it runs
 * the server. See `src/cli.ts` for the commands.
 *
 * Run node directly (not through npm or pnpm), so SIGTERM reaches the server (DEP-7).
 */
import { readFileSync } from 'node:fs';
import { runCli } from './cli.ts';
import { runServer } from './serve.ts';

const result = await runCli(process.argv.slice(2), {
  env: process.env,
  readFile: (path) => readFileSync(path, 'utf8'),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  now: Date.now,
  fetch: (url, init) => fetch(url, init),
  serve: runServer,
});
if (result !== 'serving') process.exitCode = result;
