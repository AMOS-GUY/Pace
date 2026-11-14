import type { RestoreReport } from '@pace/core';

/**
 * What the athlete reads after a restore: what came back, what an older backup could not
 * contain, what was replaced, and what failed. It never claims a complete restore when anything
 * is missing.
 */
export function restoreSummary(report: RestoreReport): {
  tone: 'success' | 'warning' | 'error';
  text: string;
} {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  parts.push(
    `Restored ${plural(report.restored, 'activity', 'activities')}` +
      (report.formatVersion >= 2 && report.sensorSamplesRestored > 0
        ? ` with ${plural(report.sensorSamplesRestored, 'heart-rate, cadence or power sample', 'heart-rate, cadence and power samples')}.`
        : '.'),
  );
  if (report.skippedExisting > 0)
    parts.push(
      `${plural(report.skippedExisting, 'activity was', 'activities were')} already on this phone and kept as they are (not duplicated).`,
    );
  if (report.formatVersion < 2)
    parts.push(
      'This backup was made by an older version of PACE: it contains no heart rate, cadence or power, so none was restored.',
    );
  if (report.settingsRestored.length > 0)
    parts.push(
      `Your ${report.settingsRestored.length === 2 ? 'preferences and profile were' : `${report.settingsRestored[0]} was`} replaced with the backup's.`,
    );
  if (report.failed.length > 0)
    parts.push(
      `${plural(report.failed.length, 'activity', 'activities')} could not be restored: ${report.failed[0]!.reason}`,
    );
  for (const f of report.otherFailures)
    parts.push(
      `Your ${f.part} could not be restored (${f.reason}). Restore the same backup again to complete it; nothing is duplicated.`,
    );
  const problems = report.failed.length > 0 || report.otherFailures.length > 0;
  return {
    tone: problems ? 'error' : report.formatVersion < 2 ? 'warning' : 'success',
    text: parts.join(' '),
  };
}
