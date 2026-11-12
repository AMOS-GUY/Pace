import { addDaysToDateKey, localDateKey, localWeekKey } from '@pace/domain';
import { type AnalyticsActivity, type PeriodBucket, type Totals, countable } from './analytics';

/**
 * Training-consistency figures for the dashboard. Like the rest of the analytics engine, every
 * value is derived from the activities passed in; where there is not enough history to make a
 * statement (e.g. a comparison with last week when last week is empty) the result is `null`
 * rather than a misleading number.
 */

export interface DayActivity {
  /** Local date YYYY-MM-DD in the viewer's time zone. */
  dateKey: string;
  activityCount: number;
  movingDurationMs: number;
}

/** The seven days (Monday first) of the local week containing `now`. */
export function weekDays(
  activities: readonly AnalyticsActivity[],
  now: number,
  timeZone: string,
): DayActivity[] {
  const monday = localWeekKey(now, timeZone);
  const days = Array.from({ length: 7 }, (_, i) => ({
    dateKey: addDaysToDateKey(monday, i),
    activityCount: 0,
    movingDurationMs: 0,
  }));
  const byKey = new Map(days.map((d) => [d.dateKey, d]));
  for (const a of countable(activities)) {
    if (a.startedAt > now) continue;
    const d = byKey.get(localDateKey(a.startedAt, timeZone));
    if (!d) continue;
    d.activityCount++;
    d.movingDurationMs += a.movingDurationMs;
  }
  return days;
}

export interface Consistency {
  /** Number of weeks considered, ending with the current week. */
  windowWeeks: number;
  /** Weeks in the window with at least one activity. */
  activeWeeks: number;
  /**
   * Consecutive weeks with at least one activity, counted back from the current week. An empty
   * current week does not break the streak until it is over, so counting starts from last week.
   */
  currentStreakWeeks: number;
  /** Days of the current week with at least one activity. */
  activeDaysThisWeek: number;
}

export function trainingConsistency(
  activities: readonly AnalyticsActivity[],
  options: { now: number; timeZone: string; windowWeeks?: number },
): Consistency {
  const { now, timeZone, windowWeeks = 8 } = options;
  const current = localWeekKey(now, timeZone);
  const activeWeekKeys = new Set(
    countable(activities)
      .filter((a) => a.startedAt <= now)
      .map((a) => localWeekKey(a.startedAt, timeZone)),
  );
  let activeWeeks = 0;
  for (let i = 0; i < windowWeeks; i++)
    if (activeWeekKeys.has(addDaysToDateKey(current, -7 * i))) activeWeeks++;
  let streak = 0;
  let key = activeWeekKeys.has(current) ? current : addDaysToDateKey(current, -7);
  while (activeWeekKeys.has(key)) {
    streak++;
    key = addDaysToDateKey(key, -7);
  }
  return {
    windowWeeks,
    activeWeeks,
    currentStreakWeeks: streak,
    activeDaysThisWeek: weekDays(activities, now, timeZone).filter((d) => d.activityCount > 0)
      .length,
  };
}

/**
 * Relative change from `previous` to `current` (0.25 = +25 %). `null` when there is no baseline,
 * because a change against zero is not a meaningful comparison.
 */
export function relativeChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous;
}

export interface WeekComparison {
  /** Change in distance versus last week; null when last week had no distance. */
  distanceChange: number | null;
  /** Change in moving time versus last week; null when last week had no moving time. */
  movingTimeChange: number | null;
}

export function compareWeeks(thisWeek: Totals, lastWeek: Totals): WeekComparison {
  return {
    distanceChange: relativeChange(thisWeek.distanceMeters, lastWeek.distanceMeters),
    movingTimeChange: relativeChange(thisWeek.movingDurationMs, lastWeek.movingDurationMs),
  };
}

/**
 * Average weekly distance over the `weeks` complete weeks before the current one — only when
 * the athlete's history covers all of them (first activity on or before the first of those
 * weeks). Otherwise `null`, so a new user is never compared against weeks before they started.
 * `buckets` are chronological weekly buckets ending with the current week.
 */
export function trailingWeeklyAverage(
  buckets: readonly PeriodBucket[],
  firstActivityAt: number | null,
  timeZone: string,
  weeks = 4,
): { distanceMeters: number; movingDurationMs: number; weeks: number } | null {
  if (firstActivityAt == null || buckets.length < weeks + 1) return null;
  const previous = buckets.slice(-(weeks + 1), -1);
  if (localWeekKey(firstActivityAt, timeZone) > previous[0]!.key) return null;
  const sum = (f: (b: PeriodBucket) => number): number => previous.reduce((s, b) => s + f(b), 0);
  return {
    distanceMeters: sum((b) => b.distanceMeters) / weeks,
    movingDurationMs: sum((b) => b.movingDurationMs) / weeks,
    weeks,
  };
}
