/**
 * License check for every dependency in the workspace (P0 CI requirement).
 *
 * Policy:
 * - Production dependencies end up in the extension, the dashboard or the container image, which
 *   are distributed under MIT. They must use a permissive license.
 * - Development dependencies (build, lint, test) are never distributed. They may also use
 *   MPL-2.0, whose copyleft applies only to the MPL files themselves, and Python-2.0.
 * - Anything else, including unknown licenses, fails. Add an exception below only with a reason.
 *   Exceptions apply to development dependencies only.
 *
 * Run with `pnpm licenses:check`. Node runs this TypeScript file directly (type stripping).
 */
import { execFileSync } from 'node:child_process';

const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Unlicense',
  'Zlib',
]);
const DEV_ONLY = new Set(['MPL-2.0', 'Python-2.0']);

/** Packages allowed despite their license: name → reason. Keep this empty if you can. */
const EXCEPTIONS: Record<string, string> = {
  // A Windows registry helper pulled in by web-ext (Firefox build checks). Never distributed.
  winreg: 'package.json says only "BSD" (no version) and the package ships no license file',
};

interface LicensedPackage {
  name: string;
  versions: string[];
  license: string;
}
type LicenseReport = Record<string, LicensedPackage[]>;

function listLicenses(prodOnly: boolean): LicenseReport {
  // `npm_execpath` is the pnpm that runs this script: either a JS entry point or a native binary.
  // Using it avoids spawning `pnpm` by name, which is `pnpm.cmd` on Windows and needs a shell.
  const pnpm = process.env['npm_execpath'];
  if (!pnpm) {
    throw new Error('Run this through pnpm: pnpm licenses:check');
  }
  const args = ['-r', 'licenses', 'list', '--json', ...(prodOnly ? ['--prod'] : [])];
  const [command, commandArgs] = /\.[cm]?js$/.test(pnpm)
    ? [process.execPath, [pnpm, ...args]]
    : [pnpm, args];
  const output = execFileSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output) as LicenseReport;
}

/** Evaluate an SPDX expression such as `MIT`, `(MIT OR Apache-2.0)` or `MIT AND ISC`. */
export function isAllowed(expression: string, allowed: ReadonlySet<string>): boolean {
  const expr = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (expr.includes(' OR ')) {
    return expr.split(' OR ').some((part) => isAllowed(part, allowed));
  }
  if (expr.includes(' AND ')) {
    return expr.split(' AND ').every((part) => isAllowed(part, allowed));
  }
  return allowed.has(expr);
}

function check(report: LicenseReport, allowed: ReadonlySet<string>, scope: string): string[] {
  const problems: string[] = [];
  for (const [license, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      const excepted = scope === 'development' && pkg.name in EXCEPTIONS;
      if (!isAllowed(license, allowed) && !excepted) {
        problems.push(`${scope}: ${pkg.name}@${pkg.versions.join(',')} has license "${license}"`);
      }
    }
  }
  return problems;
}

const prod = listLicenses(true);
const all = listLicenses(false);
const problems = [
  ...check(prod, PERMISSIVE, 'production'),
  ...check(all, new Set([...PERMISSIVE, ...DEV_ONLY]), 'development'),
];
const count = (report: LicenseReport) =>
  Object.values(report).reduce((sum, list) => sum + list.length, 0);

if (problems.length > 0) {
  process.stderr.write(`License check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.stderr.write(
    'Replace the dependency, or add an exception with a reason in scripts/check-licenses.ts.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `License check passed: ${String(count(prod))} production, ${String(count(all))} total packages.\n`,
  );
}
