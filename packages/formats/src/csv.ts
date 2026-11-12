import type { Activity, Lap, PersonalRecord, Split } from '@pace/domain';

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
  // Appended in the portable export (existing columns keep their position).
  'elevation_loss_meters',
  'ended_at_utc',
  'swim_mode',
  'pool_length_meters',
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
        a.elevationLossMeters?.toFixed(1) ?? null,
        a.endedAt != null ? new Date(a.endedAt).toISOString() : null,
        a.swimMode ?? null,
        a.poolLengthMeters ?? null,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
}

function table(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
): string {
  return [header.join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\r\n') + '\r\n';
}

const isoOrNull = (ms: number | null | undefined): string | null =>
  ms != null ? new Date(ms).toISOString() : null;

/** Laps of many activities; lap_number is 1-based. */
export function lapsToCsv(laps: ReadonlyArray<Lap>): string {
  return table(
    [
      'activity_id',
      'lap_number',
      'started_at_utc',
      'duration_ms',
      'distance_meters',
      'average_pace_ms_per_km',
      'average_speed_mps',
      'pool_length_count',
    ],
    laps.map((l) => [
      l.activityId,
      l.sequenceNumber + 1,
      isoOrNull(l.startedAt),
      Math.round(l.durationMs),
      l.distanceMeters.toFixed(1),
      l.averagePaceMsPerKm != null ? Math.round(l.averagePaceMsPerKm) : null,
      l.averageSpeedMps?.toFixed(3) ?? null,
      l.lengthCount,
    ]),
  );
}

/** Distance splits; split_number is 1-based. */
export function splitsToCsv(splits: ReadonlyArray<Split & { activityId: string }>): string {
  return table(
    [
      'activity_id',
      'split_number',
      'distance_meters',
      'moving_duration_ms',
      'pace_ms_per_km',
      'speed_mps',
      'elevation_gain_meters',
      'is_partial',
    ],
    splits.map((s) => [
      s.activityId,
      s.index + 1,
      s.distanceMeters.toFixed(1),
      Math.round(s.movingDurationMs),
      s.paceMsPerKm != null ? Math.round(s.paceMsPerKm) : null,
      s.speedMps?.toFixed(3) ?? null,
      s.elevationGainMeters.toFixed(1),
      s.isPartial ? 1 : 0,
    ]),
  );
}

export function personalRecordsToCsv(records: ReadonlyArray<PersonalRecord>): string {
  return table(
    ['sport_type', 'metric', 'value', 'unit', 'basis', 'activity_id', 'achieved_at_utc'],
    records.map((r) => [
      r.sportType,
      r.metricType,
      r.value,
      r.unit,
      r.basis,
      r.activityId,
      isoOrNull(r.achievedAt),
    ]),
  );
}
