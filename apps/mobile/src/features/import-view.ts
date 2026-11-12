import type { BulkImportProgress, BulkImportReport, ImportOutcome, ImportStatus } from '@pace/core';

/** Pure helpers for the import screen. */

const GROUPS: ReadonlyArray<{ status: ImportStatus; title: string }> = [
  { status: 'failed', title: 'Could not import' },
  { status: 'needs_sport', title: 'Need a sport' },
  { status: 'duplicate', title: 'Already in PACE' },
  { status: 'imported', title: 'Imported' },
];

/** Outcomes grouped for the report, problems first, empty groups omitted. */
export function groupOutcomes(
  outcomes: readonly ImportOutcome[],
): Array<{ status: ImportStatus; title: string; items: ImportOutcome[] }> {
  return GROUPS.map((g) => ({ ...g, items: outcomes.filter((o) => o.status === g.status) })).filter(
    (g) => g.items.length > 0,
  );
}

/** The last path segment, keeping a "#n" activity suffix. */
export function outcomeName(entry: string): string {
  const parts = entry.split(/[\\/]/);
  return parts[parts.length - 1] || entry;
}

/** Overall progress 0..1: whole picked files done plus the share of the current one read. */
export function importProgressRatio(p: BulkImportProgress | null): number {
  if (!p || p.fileCount === 0) return 0;
  const current = p.bytesTotal && p.bytesTotal > 0 ? Math.min(1, p.bytesRead / p.bytesTotal) : 0;
  return Math.min(1, (p.fileIndex - 1 + current) / p.fileCount);
}

/** "Skipped 1,204 files that are not activities: .jpg 1,190, .csv 14." */
export function skippedSummary(skipped: BulkImportReport['skipped'], locale?: string): string {
  const n = (v: number): string => v.toLocaleString(locale);
  const parts = Object.entries(skipped.byExtension)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext} ${n(count)}`);
  return `Skipped ${n(skipped.count)} ${skipped.count === 1 ? 'file that is not an activity' : 'files that are not activities'}${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}
