/**
 * JSON and Markdown reports. Both are built only from scenario results (anonymous IDs,
 * aggregates, scrubbed messages) and are checked by `assertNoLeak` before they are returned.
 */
import { type Check, type Status, TOLERANCES, countStatuses } from './checks';
import { type Secrets, assertNoLeak } from './privacy';
import type { ScenarioResult } from './scenario';

export interface ValidationReport {
  tool: 'pace-import-validation';
  reportVersion: 1;
  /** Date only. */
  generated: string;
  mode: 'manifest' | 'folder';
  /** True only when real device files were validated (never set by synthetic runs). */
  realDeviceFiles: boolean;
  summary: { scenarios: Record<Status, number>; checks: Record<Status, number> };
  tolerances: typeof TOLERANCES;
  scenarios: ScenarioResult[];
  privacy: string;
}

const PRIVACY =
  'Contains no file or folder names, emails, coordinates, absolute times, device identifiers, activity titles or raw sensor series. Scenario IDs are anonymous.';

export function buildReport(
  results: ScenarioResult[],
  o: { mode: ValidationReport['mode']; realDeviceFiles: boolean; today?: Date },
): ValidationReport {
  const scenarios: Record<Status, number> = { PASS: 0, FAIL: 0, WARNING: 0, 'NOT TESTED': 0 };
  for (const r of results) scenarios[r.status]++;
  return {
    tool: 'pace-import-validation',
    reportVersion: 1,
    generated: (o.today ?? new Date()).toISOString().slice(0, 10),
    mode: o.mode,
    realDeviceFiles: o.realDeviceFiles,
    summary: { scenarios, checks: countStatuses(results.flatMap((r) => r.checks)) },
    tolerances: TOLERANCES,
    scenarios: results,
    privacy: PRIVACY,
  };
}

const cell = (v: unknown): string =>
  v == null || v === '' ? '—' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const TIER_TITLES: Record<Check['tier'], string> = {
  integrity: 'Integrity (FIT parsed → PACE stored)',
  format: 'Format comparison (FIT vs companion, both as parsed)',
  pipeline: 'PACE processing (final activity from FIT vs from companion)',
  device: 'Device-reported totals (informational, not ground truth)',
  expectation: 'Expected results (scenario manifest)',
  archive: 'Archive reading and bulk import',
};

export function toMarkdown(r: ValidationReport): string {
  const lines: string[] = [];
  lines.push('# PACE import validation report', '');
  lines.push(
    `Generated ${r.generated} · mode: ${r.mode} · real device files: ${r.realDeviceFiles ? 'yes' : 'no'}`,
    '',
  );
  lines.push(`> ${r.privacy}`, '');
  lines.push('## Summary', '');
  lines.push('| | PASS | FAIL | WARNING | NOT TESTED |', '|---|---|---|---|---|');
  for (const [label, s] of [
    ['Scenarios', r.summary.scenarios],
    ['Checks', r.summary.checks],
  ] as const)
    lines.push(`| ${label} | ${s.PASS} | ${s.FAIL} | ${s.WARNING} | ${s['NOT TESTED']} |`);
  lines.push('', '| Scenario | Result | Outcome | Companions |', '|---|---|---|---|');
  for (const s of r.scenarios)
    lines.push(`| ${s.id} | ${s.status} | ${s.outcome} | ${s.companions.join(', ') || '—'} |`);
  lines.push('');

  for (const s of r.scenarios) {
    lines.push(`## ${s.id} — ${s.status}`, '');
    if (s.summary) {
      lines.push(
        Object.entries(s.summary)
          .filter(([k]) => k !== 'limits')
          .map(([k, v]) => `**${k}**: ${typeof v === 'object' && v ? JSON.stringify(v) : cell(v)}`)
          .join(' · '),
        '',
      );
    }
    for (const tier of Object.keys(TIER_TITLES) as Array<Check['tier']>) {
      const rows = s.checks.filter((c) => c.tier === tier);
      if (rows.length === 0) continue;
      lines.push(`### ${TIER_TITLES[tier]}`, '');
      lines.push(
        '| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |',
        '|---|---|---|---|---|---|---|',
      );
      for (const c of rows)
        lines.push(
          `| ${cell(c.metric)} | ${c.status} | ${cell(c.value)} | ${cell(c.reference)} | ${cell(c.difference)} | ${cell(c.tolerance)} | ${cell(c.explanation)} |`,
        );
      lines.push('');
    }
    if (s.warnings.length) {
      lines.push('Import warnings:', '');
      for (const w of s.warnings) lines.push(`- ${w}`);
      lines.push('');
    }
  }
  lines.push('## Tolerances', '', '```json', JSON.stringify(r.tolerances, null, 2), '```', '');
  return lines.join('\n');
}

/** Both report files' contents, after the privacy check. Throws PrivacyLeakError on a leak. */
export function renderReports(
  r: ValidationReport,
  secrets: Secrets,
): { json: string; markdown: string } {
  const json = `${JSON.stringify(r, null, 2)}\n`;
  const markdown = toMarkdown(r);
  assertNoLeak(json, secrets);
  assertNoLeak(markdown, secrets);
  return { json, markdown };
}
