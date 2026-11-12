import {
  type AnalyticsActivity,
  compareWeeks,
  periodBuckets,
  relativeChange,
  totals,
  trailingWeeklyAverage,
  trainingConsistency,
  weekDays,
} from './index';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const T = Date.UTC(2026, 10, 11, 12); // Wednesday 2026-11-11 12:00Z (week of Monday 2026-11-09)

function activity(
  p: Partial<AnalyticsActivity> & Pick<AnalyticsActivity, 'id' | 'startedAt'>,
): AnalyticsActivity {
  return {
    sportType: 'running',
    timezone: 'UTC',
    status: 'completed',
    deletedAt: null,
    distanceMeters: 5000,
    movingDurationMs: 1_500_000,
    elapsedDurationMs: 1_600_000,
    elevationGainMeters: 20,
    averagePaceMsPerKm: 300_000,
    ...p,
  };
}

describe('weekDays', () => {
  it('returns Monday..Sunday of the current week with per-day counts', () => {
    const days = weekDays(
      [
        activity({ id: 'mon', startedAt: T - 2 * DAY }),
        activity({ id: 'mon2', startedAt: T - 2 * DAY + 3_600_000 }),
        activity({ id: 'wed', startedAt: T }),
        activity({ id: 'lastweek', startedAt: T - WEEK }),
        activity({ id: 'deleted', startedAt: T, deletedAt: T }),
        activity({ id: 'live', startedAt: T, status: 'recording' }),
      ],
      T,
      'UTC',
    );
    expect(days.map((d) => d.dateKey)).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
    expect(days.map((d) => d.activityCount)).toEqual([2, 0, 1, 0, 0, 0, 0]);
    expect(days[0]!.movingDurationMs).toBe(3_000_000);
  });

  it("buckets by the viewer's local day, not UTC", () => {
    // 03:30Z Monday is still Sunday evening in New York, so it belongs to the previous week.
    const lateSunday = Date.UTC(2026, 10, 9, 3, 30);
    const ny = weekDays([activity({ id: 'a', startedAt: lateSunday })], T, 'America/New_York');
    expect(ny.every((d) => d.activityCount === 0)).toBe(true);
    const utc = weekDays([activity({ id: 'a', startedAt: lateSunday })], T, 'UTC');
    expect(utc[0]!.activityCount).toBe(1);
  });
});

describe('trainingConsistency', () => {
  it('reports zeros for an athlete with no history', () => {
    expect(trainingConsistency([], { now: T, timeZone: 'UTC' })).toEqual({
      windowWeeks: 8,
      activeWeeks: 0,
      currentStreakWeeks: 0,
      activeDaysThisWeek: 0,
    });
  });

  it('counts active weeks in the window and the current streak', () => {
    const list = [
      activity({ id: 'w0', startedAt: T }),
      activity({ id: 'w0b', startedAt: T - DAY }),
      activity({ id: 'w1', startedAt: T - WEEK }),
      activity({ id: 'w2', startedAt: T - 2 * WEEK }),
      // gap at w3
      activity({ id: 'w4', startedAt: T - 4 * WEEK }),
      activity({ id: 'old', startedAt: T - 20 * WEEK }), // outside the 8-week window
    ];
    expect(trainingConsistency(list, { now: T, timeZone: 'UTC' })).toEqual({
      windowWeeks: 8,
      activeWeeks: 4,
      currentStreakWeeks: 3,
      activeDaysThisWeek: 2,
    });
  });

  it('keeps the streak alive while the current week is still empty', () => {
    const list = [
      activity({ id: 'w1', startedAt: T - WEEK }),
      activity({ id: 'w2', startedAt: T - 2 * WEEK }),
    ];
    const c = trainingConsistency(list, { now: T, timeZone: 'UTC' });
    expect(c.currentStreakWeeks).toBe(2);
    expect(c.activeDaysThisWeek).toBe(0);
  });

  it('ignores deleted, incomplete and future activities', () => {
    const list = [
      activity({ id: 'del', startedAt: T, deletedAt: T }),
      activity({ id: 'rec', startedAt: T, status: 'recording' }),
      activity({ id: 'future', startedAt: T + 3 * WEEK }),
    ];
    const c = trainingConsistency(list, { now: T, timeZone: 'UTC' });
    expect(c.activeWeeks).toBe(0);
    expect(c.currentStreakWeeks).toBe(0);
  });
});

describe('week comparison', () => {
  it('returns null instead of a change against an empty baseline', () => {
    expect(relativeChange(5000, 0)).toBeNull();
    expect(relativeChange(0, 0)).toBeNull();
    expect(relativeChange(Number.NaN, 10)).toBeNull();
    expect(relativeChange(15, 10)).toBeCloseTo(0.5);
    expect(relativeChange(5, 10)).toBeCloseTo(-0.5);
  });

  it('compares this week with last week from real totals', () => {
    const thisWeek = totals([activity({ id: 'a', startedAt: T, distanceMeters: 12_000 })]);
    const lastWeek = totals([activity({ id: 'b', startedAt: T - WEEK, distanceMeters: 8000 })]);
    const c = compareWeeks(thisWeek, lastWeek);
    expect(c.distanceChange).toBeCloseTo(0.5);
    expect(c.movingTimeChange).toBe(0);
    expect(compareWeeks(thisWeek, totals([]))).toEqual({
      distanceChange: null,
      movingTimeChange: null,
    });
  });
});

describe('trailingWeeklyAverage', () => {
  const list = [
    activity({ id: 'w1', startedAt: T - WEEK, distanceMeters: 10_000 }),
    activity({ id: 'w2', startedAt: T - 2 * WEEK, distanceMeters: 6000 }),
    activity({ id: 'w4', startedAt: T - 4 * WEEK, distanceMeters: 4000 }),
    activity({ id: 'now', startedAt: T, distanceMeters: 99_000 }),
  ];
  const buckets = periodBuckets(list, { period: 'week', count: 8, now: T, timeZone: 'UTC' });

  it('averages the complete weeks before the current one', () => {
    const avg = trailingWeeklyAverage(buckets, T - 4 * WEEK, 'UTC', 4)!;
    // weeks -4..-1: 4000 + 0 + 6000 + 10000; the current week is excluded.
    expect(avg.distanceMeters).toBe(5000);
    expect(avg.weeks).toBe(4);
  });

  it('is null when history does not cover the whole comparison window', () => {
    expect(trailingWeeklyAverage(buckets, T - 2 * WEEK, 'UTC', 4)).toBeNull();
    expect(trailingWeeklyAverage(buckets, null, 'UTC', 4)).toBeNull();
    expect(trailingWeeklyAverage(buckets.slice(-3), T - 10 * WEEK, 'UTC', 4)).toBeNull();
  });
});
