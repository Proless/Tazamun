/**
 * Summarizes a Grype JSON report for the image workflow (DEP-34): a table of findings by
 * severity in the job summary, and a warning annotation for each fixable Critical finding.
 *
 * Usage: node scripts/scan-summary.ts <grype-report.json>
 *
 * It never fails the build. Release builds (P6) will fail on fixable Critical findings; for pull
 * requests and main they are warnings, so a new base-image CVE doesn't block unrelated work
 * until Dependabot updates the base image.
 */
import { appendFileSync, readFileSync } from 'node:fs';

interface GrypeReport {
  matches: {
    vulnerability: { id: string; severity: string; fix?: { state?: string } };
    artifact: { name: string; version: string };
  }[];
}

const reportPath = process.argv[2];
if (reportPath === undefined) {
  process.stderr.write('Usage: node scripts/scan-summary.ts <grype-report.json>\n');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8')) as GrypeReport;
const counts = new Map<string, number>();
const fixableCritical: string[] = [];
for (const { vulnerability: v, artifact } of report.matches) {
  counts.set(v.severity, (counts.get(v.severity) ?? 0) + 1);
  if (v.severity === 'Critical' && v.fix?.state === 'fixed') {
    fixableCritical.push(`${v.id} in ${artifact.name} ${artifact.version}`);
  }
}

const order = ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'];
const rows = [...counts.entries()]
  .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
  .map(([severity, n]) => `| ${severity} | ${String(n)} |`);
const lines = ['### Vulnerability scan (Grype)', ''];
lines.push(
  ...(rows.length === 0
    ? ['No known vulnerabilities.']
    : ['| Severity | Count |', '| --- | --- |', ...rows]),
);
if (fixableCritical.length > 0) {
  lines.push('', `**Fixable Critical:** ${fixableCritical.join(', ')}`);
  for (const finding of fixableCritical) {
    process.stdout.write(`::warning title=Fixable critical vulnerability::${finding}\n`);
  }
}

const text = `${lines.join('\n')}\n`;
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary === undefined) process.stdout.write(text);
else appendFileSync(summary, text);
