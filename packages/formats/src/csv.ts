import type { Activity } from '@pace/domain';

/** RFC 4180 field escaping; also neutralises spreadsheet formula injection (=, +, -, @). */
export function csvField(value: string | number | null | undefined): string {
  if (value == null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = [
  'id',
  'sport_type',
  'title',
  'started_at_utc',
  'timezone',
  'elapsed_duration_ms',
  'moving_duration_ms',
  'distance_meters',
  'elevation_gain_meters',
  'average_speed_mps',
  'maximum_speed_mps',
  'average_pace_ms_per_km',
  'source',
  'description',
] as const;

/** Activity summary CSV with explicit units in every column name. */
export function activitiesToCsv(activities: readonly Activity[]): string {
  const rows = [COLUMNS.join(',')];
  for (const a of activities) {
    rows.push(
      [
        a.id,
        a.sportType,
        a.title,
        new Date(a.startedAt).toISOString(),
        a.timezone,
        Math.round(a.elapsedDurationMs),
        Math.round(a.movingDurationMs),
        a.distanceMeters.toFixed(1),
        a.elevationGainMeters.toFixed(1),
        a.averageSpeedMps?.toFixed(3) ?? null,
        a.maximumSpeedMps?.toFixed(3) ?? null,
        a.averagePaceMsPerKm != null ? Math.round(a.averagePaceMsPerKm) : null,
        a.source,
        a.description,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
}
