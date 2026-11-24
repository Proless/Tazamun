/**
 * Production build (DEP-2): bundles the server into one ESM file, `dist/main.js`, so the image
 * needs Node and nothing else: no node_modules, no TypeScript source, no package manager.
 *
 * Also writes `dist/THIRD-PARTY-LICENSES.txt` with the license of every bundled package, because
 * their licenses (MIT and similar) require the notice to travel with the code.
 *
 * Run with `pnpm --filter @tazamun/server build`.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
const result = await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(dist, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  // The image links /usr/local/bin/tazamun to this file, so the kernel runs node directly as PID 1.
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  // Readable stack traces in logs matter more than a few hundred KB.
  minify: false,
  metafile: true,
  logLevel: 'warning',
});

/** The package directory (the one holding package.json) of a bundled file inside node_modules. */
function packageDir(file: string): string | undefined {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at === -1) return undefined;
  const scoped = parts[at + 1]?.startsWith('@') ?? false;
  return parts.slice(0, at + (scoped ? 3 : 2)).join(sep);
}

const packages = new Map<string, string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const dir = packageDir(join(root, input));
  if (dir === undefined) continue;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string;
  };
  packages.set(`${pkg.name}@${pkg.version}`, dir);
}

const sections = [...packages.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, dir]) => {
    const file = readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
    if (file === undefined)
      throw new Error(`${id} has no license file (in ${relative(root, dir)})`);
    return `${id}\n${'='.repeat(id.length)}\n\n${readFileSync(join(dir, file), 'utf8').trim()}\n`;
  });

writeFileSync(
  join(dist, 'THIRD-PARTY-LICENSES.txt'),
  `Third-party software bundled in dist/main.js\n\n${sections.join('\n\n')}`,
);
if (!existsSync(join(dist, 'main.js'))) throw new Error('The bundle was not written');
process.stdout.write(`Built dist/main.js with ${String(packages.size)} bundled packages.\n`);
