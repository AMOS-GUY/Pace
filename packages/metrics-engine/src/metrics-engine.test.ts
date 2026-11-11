import type { Activity } from '@pace/domain';
import {
  type AnalyticsActivity,
  averagePaceMsPerKm,
  averageSpeedMps,
  bestEffort,
  bestRecords,
  computeSplits,
  goalProgress,
  highlights,
  improvedRecords,
  isMovingAt,
  movingTimeAt,
  periodBuckets,
  recordCandidatesForActivity,
  sportDistribution,
  totals,
  totalsBySport,
  type TimedDistancePoint,
} from './index';

/** Even-pace track: `speed` m/s for `seconds`, one point per second. */
function evenTrack(
  speed: number,
  seconds: number,
  altitude?: (t: number) => number,
): TimedDistancePoint[] {
  return Array.from({ length: seconds + 1 }, (_, t) => ({
    movingTimeMs: t * 1000,
    cumulativeDistanceMeters: speed * t,
    altitudeMeters: altitude ? altitude(t) : null,
  }));
}

const T = Date.UTC(2026, 10, 9, 7); // Monday 2026-11-09 07:00Z

function activity(
  p: Partial<AnalyticsActivity> & Pick<AnalyticsActivity, 'id'>,
): AnalyticsActivity {
  return {
    sportType: 'running',
    startedAt: T,
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

describe('pace and speed', () => {
  it('computes pace from moving time', () => {
    expect(averagePaceMsPerKm(5000, 1_500_000)).toBe(300_000);
    expect(averagePaceMsPerKm(50, 10_000)).toBeNull();
    expect(averagePaceMsPerKm(5000, 0)).toBeNull();
  });
  it('computes speed from moving time', () => {
    expect(averageSpeedMps(1000, 100_000)).toBe(10);
    expect(averageSpeedMps(0, 100_000)).toBeNull();
  });
});

describe('moving time', () => {
  const intervals = [
    { startedAt: 0, endedAt: 60_000 },
    { startedAt: 120_000, endedAt: null },
  ];
  it('excludes paused intervals', () => {
    expect(movingTimeAt(intervals, 30_000)).toBe(30_000);
    expect(movingTimeAt(intervals, 90_000)).toBe(60_000);
    expect(movingTimeAt(intervals, 180_000)).toBe(120_000);
    expect(isMovingAt(intervals, 90_000)).toBe(false);
    expect(isMovingAt(intervals, 130_000)).toBe(true);
  });
});

describe('splits', () => {
  it('produces whole km splits with an interpolated boundary time and a partial final split', () => {
    // 4 m/s for 2600 m (650 s) -> 250 s/km
    const splits = computeSplits(evenTrack(4, 650), 1000);
    expect(splits).toHaveLength(3);
    expect(splits[0]!.movingDurationMs).toBeCloseTo(250_000, 6);
    expect(splits[0]!.paceMsPerKm).toBeCloseTo(250_000, 6);
    expect(splits[2]!.isPartial).toBe(true);
    expect(splits[2]!.distanceMeters).toBeCloseTo(600, 6);
  });

  it('handles sparse points spanning multiple boundaries', () => {
    const pts: TimedDistancePoint[] = [
      { movingTimeMs: 0, cumulativeDistanceMeters: 0, altitudeMeters: null },
      { movingTimeMs: 1_000_000, cumulativeDistanceMeters: 3000, altitudeMeters: null },
    ];
    const s = computeSplits(pts, 1000);
    expect(s.map((x) => Math.round(x.movingDurationMs))).toEqual([333_333, 333_333, 333_333]);
  });

  it('uses filtered elevation per split', () => {
    const s = computeSplits(
      evenTrack(4, 500, (t) => 100 + t * 0.1 + (t % 2 ? 1 : -1)),
      1000,
    );
    const totalGain = s.reduce((a, x) => a + x.elevationGainMeters, 0);
    expect(totalGain).toBeGreaterThan(40);
    expect(totalGain).toBeLessThan(55);
  });
});

describe('best effort', () => {
  it('finds the fastest window', () => {
    // 1 km slow (2 m/s = 500 s), then 1 km fast (5 m/s = 200 s)
    const slow = evenTrack(2, 500);
    const fast = evenTrack(5, 200).map((p) => ({
      movingTimeMs: p.movingTimeMs + 500_000,
      cumulativeDistanceMeters: p.cumulativeDistanceMeters + 1000,
      altitudeMeters: null,
    }));
    const e = bestEffort([...slow, ...fast.slice(1)], 1000);
    expect(e!.durationMs).toBeCloseTo(200_000, 6);
    expect(bestEffort(slow, 5000)).toBeNull();
  });
});

describe('analytics', () => {
  const list = [
    activity({ id: 'a' }),
    activity({
      id: 'b',
      sportType: 'cycling',
      distanceMeters: 40_000,
      movingDurationMs: 4_800_000,
      averagePaceMsPerKm: null,
    }),
    activity({ id: 'c', startedAt: T - 7 * 86_400_000 }),
    activity({ id: 'deleted', deletedAt: T }),
    activity({ id: 'live', status: 'recording' }),
  ];

  it('counts only completed, non-deleted activities', () => {
    expect(totals(list).activityCount).toBe(3);
    expect(totals(list).distanceMeters).toBe(50_000);
  });

  it('never blends pace across sports', () => {
    const by = totalsBySport(list);
    const run = by.find((s) => s.sportType === 'running')!;
    const ride = by.find((s) => s.sportType === 'cycling')!;
    expect(run.averagePaceMsPerKm).toBe(300_000);
    expect(ride.averagePaceMsPerKm).toBeNull();
    expect(ride.averageSpeedMps).toBeCloseTo(8.333, 3);
  });

  it('buckets by week including empty weeks', () => {
    const b = periodBuckets(list, { period: 'week', count: 3, now: T + 3600_000, timeZone: 'UTC' });
    expect(b.map((x) => x.key)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    expect(b.map((x) => x.activityCount)).toEqual([0, 1, 2]);
  });

  it('buckets by month and filters by sport', () => {
    const b = periodBuckets(list, {
      period: 'month',
      count: 2,
      now: T,
      timeZone: 'UTC',
      sportType: 'cycling',
    });
    expect(b.map((x) => [x.key, x.distanceMeters])).toEqual([
      ['2026-10', 0],
      ['2026-11', 40_000],
    ]);
  });

  it('computes highlights and distribution', () => {
    const h = highlights(list);
    expect(h.longestByDistance!.id).toBe('b');
    expect(h.fastestRunPace!.sportType).toBe('running');
    const d = sportDistribution(list);
    expect(d.reduce((s, x) => s + x.countShare, 0)).toBeCloseTo(1, 9);
  });
});

describe('records', () => {
  const run: Pick<
    Activity,
    | 'id'
    | 'sportType'
    | 'startedAt'
    | 'distanceMeters'
    | 'movingDurationMs'
    | 'elevationGainMeters'
    | 'status'
    | 'deletedAt'
  > = {
    id: 'r1',
    sportType: 'running',
    startedAt: T,
    distanceMeters: 5200,
    movingDurationMs: 1_300_000,
    elevationGainMeters: 10,
    status: 'completed',
    deletedAt: null,
  };
  const rules = [
    { metric: 'fastest_1k' as const, kind: 'fastest_distance' as const, distanceMeters: 1000 },
    { metric: 'fastest_10k' as const, kind: 'fastest_distance' as const, distanceMeters: 10_000 },
    { metric: 'longest_distance' as const, kind: 'longest_distance' as const },
  ];

  it('produces estimated segment records only with a reliable track', () => {
    const c = recordCandidatesForActivity(run, evenTrack(4, 1300), rules, {
      hasReliableTrack: true,
    });
    expect(c.find((x) => x.metricType === 'fastest_1k')).toMatchObject({
      value: 250_000,
      basis: 'estimated_segment',
    });
    expect(c.find((x) => x.metricType === 'fastest_10k')).toBeUndefined();
    const unreliable = recordCandidatesForActivity(run, evenTrack(4, 1300), rules, {
      hasReliableTrack: false,
    });
    expect(unreliable.map((x) => x.metricType)).toEqual(['longest_distance']);
  });

  it('selects best records and detects improvements', () => {
    const a = {
      sportType: 'running' as const,
      metricType: 'fastest_1k' as const,
      unit: 'ms' as const,
      basis: 'estimated_segment' as const,
    };
    const best = bestRecords([
      { ...a, value: 260_000, activityId: 'x', achievedAt: 1 },
      { ...a, value: 250_000, activityId: 'y', achievedAt: 2 },
      { ...a, value: 250_000, activityId: 'z', achievedAt: 3 },
    ]);
    expect(best).toHaveLength(1);
    expect(best[0]!.activityId).toBe('y');
    expect(
      improvedRecords([{ sportType: 'running', metricType: 'fastest_1k', value: 255_000 }], best),
    ).toHaveLength(1);
    expect(
      improvedRecords([{ sportType: 'running', metricType: 'fastest_1k', value: 240_000 }], best),
    ).toHaveLength(0);
  });
});

describe('goals', () => {
  it('computes weekly distance goal progress from activities', () => {
    const p = goalProgress(
      {
        id: 'g',
        sportType: 'running',
        goalType: 'distance',
        targetValue: 20_000,
        period: 'week',
        startDate: null,
        endDate: null,
      },
      [
        activity({ id: 'a' }),
        activity({ id: 'b', startedAt: T + 86_400_000 }),
        activity({ id: 'old', startedAt: T - 8 * 86_400_000 }),
      ],
      T + 2 * 86_400_000,
      'UTC',
    );
    expect(p.current).toBe(10_000);
    expect(p.ratio).toBe(0.5);
    expect(p.achieved).toBe(false);
  });
});
