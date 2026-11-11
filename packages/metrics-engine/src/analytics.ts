import {
  type Activity,
  SPORT_TYPES,
  type SportType,
  addDaysToDateKey,
  addMonthsToMonthKey,
  localMonthKey,
  localWeekKey,
  localYearKey,
} from '@pace/domain';
import { averagePaceMsPerKm, averageSpeedMps } from './pace';

/**
 * Analytics engine. Every number is derived from persisted activities passed in by the caller;
 * nothing here is hardcoded. Metric definitions:
 *
 * - distance:       sum of activity distance_meters
 * - movingTime:     sum of moving_duration_ms (paused / auto-paused time excluded)
 * - elapsedTime:    sum of elapsed_duration_ms
 * - elevationGain:  sum of hysteresis-filtered elevation gain
 * - averagePace:    total moving time / total distance — ONLY within one pace sport
 * - averageSpeed:   total distance / total moving time — ONLY within one sport
 *
 * Averages are never blended across sports (running pace and cycling speed are incompatible).
 */
export type AnalyticsActivity = Pick<
  Activity,
  | 'id'
  | 'sportType'
  | 'startedAt'
  | 'timezone'
  | 'status'
  | 'deletedAt'
  | 'distanceMeters'
  | 'movingDurationMs'
  | 'elapsedDurationMs'
  | 'elevationGainMeters'
  | 'averagePaceMsPerKm'
>;

export interface Totals {
  activityCount: number;
  distanceMeters: number;
  movingDurationMs: number;
  elapsedDurationMs: number;
  elevationGainMeters: number;
}

export interface SportTotals extends Totals {
  sportType: SportType;
  averagePaceMsPerKm: number | null;
  averageSpeedMps: number | null;
}

export type Period = 'week' | 'month' | 'year';

export interface PeriodBucket extends Totals {
  /** Week: Monday date YYYY-MM-DD. Month: YYYY-MM. Year: YYYY. */
  key: string;
}

const emptyTotals = (): Totals => ({
  activityCount: 0,
  distanceMeters: 0,
  movingDurationMs: 0,
  elapsedDurationMs: 0,
  elevationGainMeters: 0,
});

function addTo(t: Totals, a: AnalyticsActivity): void {
  t.activityCount++;
  t.distanceMeters += a.distanceMeters;
  t.movingDurationMs += a.movingDurationMs;
  t.elapsedDurationMs += a.elapsedDurationMs;
  t.elevationGainMeters += a.elevationGainMeters;
}

/** Only completed, non-deleted activities count toward analytics. */
export function countable<T extends Pick<Activity, 'status' | 'deletedAt'>>(
  activities: readonly T[],
): T[] {
  return activities.filter((a) => a.status === 'completed' && a.deletedAt == null);
}

export function totals(activities: readonly AnalyticsActivity[]): Totals {
  const t = emptyTotals();
  for (const a of countable(activities)) addTo(t, a);
  return t;
}

export function totalsBySport(activities: readonly AnalyticsActivity[]): SportTotals[] {
  const map = new Map<SportType, Totals>();
  for (const a of countable(activities)) {
    let t = map.get(a.sportType);
    if (!t) map.set(a.sportType, (t = emptyTotals()));
    addTo(t, a);
  }
  return SPORT_TYPES.filter((s) => map.has(s)).map((sportType) => {
    const t = map.get(sportType)!;
    const paceSport = sportType === 'running' || sportType === 'walking' || sportType === 'hiking';
    return {
      sportType,
      ...t,
      averagePaceMsPerKm: paceSport
        ? averagePaceMsPerKm(t.distanceMeters, t.movingDurationMs)
        : null,
      averageSpeedMps: averageSpeedMps(t.distanceMeters, t.movingDurationMs),
    };
  });
}

export function periodKey(epochMs: number, period: Period, timeZone: string): string {
  switch (period) {
    case 'week':
      return localWeekKey(epochMs, timeZone);
    case 'month':
      return localMonthKey(epochMs, timeZone);
    case 'year':
      return localYearKey(epochMs, timeZone);
  }
}

function stepKey(key: string, period: Period, n: number): string {
  switch (period) {
    case 'week':
      return addDaysToDateKey(key, n * 7);
    case 'month':
      return addMonthsToMonthKey(key, n);
    case 'year':
      return String(Number(key) + n);
  }
}

/**
 * Buckets activities into the last `count` periods ending with the period containing `now`,
 * in chronological order, including empty periods. Bucketing uses the *viewer's* time zone so
 * "this week" matches the user's calendar.
 */
export function periodBuckets(
  activities: readonly AnalyticsActivity[],
  options: { period: Period; count: number; now: number; timeZone: string; sportType?: SportType },
): PeriodBucket[] {
  const { period, count, now, timeZone, sportType } = options;
  const current = periodKey(now, period, timeZone);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) keys.push(stepKey(current, period, -i));
  const buckets = new Map<string, PeriodBucket>(
    keys.map((key) => [key, { key, ...emptyTotals() }]),
  );
  for (const a of countable(activities)) {
    if (sportType && a.sportType !== sportType) continue;
    const b = buckets.get(periodKey(a.startedAt, period, timeZone));
    if (b) addTo(b, a);
  }
  return keys.map((k) => buckets.get(k)!);
}

export interface Highlights {
  longestByDistance: AnalyticsActivity | null;
  longestByDuration: AnalyticsActivity | null;
  highestElevationGain: AnalyticsActivity | null;
  /** Fastest average pace among running activities of at least 1 km. */
  fastestRunPace: AnalyticsActivity | null;
}

export function highlights(activities: readonly AnalyticsActivity[]): Highlights {
  const list = countable(activities);
  const maxBy = (f: (a: AnalyticsActivity) => number): AnalyticsActivity | null =>
    list.reduce<AnalyticsActivity | null>(
      (best, a) => (f(a) > 0 && (!best || f(a) > f(best)) ? a : best),
      null,
    );
  const runs = list.filter(
    (a) => a.sportType === 'running' && a.distanceMeters >= 1000 && a.averagePaceMsPerKm != null,
  );
  return {
    longestByDistance: maxBy((a) => a.distanceMeters),
    longestByDuration: maxBy((a) => a.movingDurationMs),
    highestElevationGain: maxBy((a) => a.elevationGainMeters),
    fastestRunPace: runs.reduce<AnalyticsActivity | null>(
      (best, a) => (!best || a.averagePaceMsPerKm! < best.averagePaceMsPerKm! ? a : best),
      null,
    ),
  };
}

/** Share of activities (count) and distance per sport, 0..1. */
export function sportDistribution(
  activities: readonly AnalyticsActivity[],
): Array<{ sportType: SportType; countShare: number; movingTimeShare: number }> {
  const bySport = totalsBySport(activities);
  const count = bySport.reduce((s, t) => s + t.activityCount, 0);
  const time = bySport.reduce((s, t) => s + t.movingDurationMs, 0);
  return bySport.map((t) => ({
    sportType: t.sportType,
    countShare: count ? t.activityCount / count : 0,
    // Moving time (not distance) is comparable across sports.
    movingTimeShare: time ? t.movingDurationMs / time : 0,
  }));
}
