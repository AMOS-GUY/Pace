import type { Activity, Split, TrainingGoal } from '@pace/domain';
import type { GoalProgress, PeriodBucket } from '@pace/metrics-engine';
import {
  activityTimeLabel,
  cardMetrics,
  groupByMonth,
  pausedDurationMs,
  routeQuality,
  showsElevation,
  splitBars,
  sourceLabel,
} from './activity-view';
import {
  consistencyText,
  formatChange,
  initials,
  longDate,
  primaryWeeklyGoal,
  weekdayInitial,
  weeklyDistanceChart,
} from './dashboard-view';

const base = {
  sportType: 'running' as const,
  distanceMeters: 10_000,
  movingDurationMs: 3_000_000,
  averagePaceMsPerKm: 300_000,
  averageSpeedMps: 3.333,
  elevationGainMeters: 42,
};

describe('dashboard view model', () => {
  it('formats the header date and avatar initials', () => {
    expect(longDate(new Date(Date.UTC(2026, 10, 12, 9)), 'en-GB', 'UTC')).toBe(
      'Thursday 12 November',
    );
    expect(initials('Amos Guy')).toBe('AG');
    expect(initials('  maria  de la cruz ')).toBe('MC');
    expect(initials('Zoë')).toBe('Z');
    expect(initials('')).toBeNull();
    expect(initials(null)).toBeNull();
  });

  it('formats changes and refuses a change without a baseline', () => {
    expect(formatChange(0.254)).toEqual({ text: '+25%', direction: 'up' });
    expect(formatChange(-0.08)).toEqual({ text: '−8%', direction: 'down' });
    expect(formatChange(0.001)).toEqual({ text: '0%', direction: 'flat' });
    expect(formatChange(null)).toBeNull();
  });

  it('labels weekdays and builds an accessible weekly chart from buckets', () => {
    expect(weekdayInitial('2026-11-09', 'en-GB')).toBe('M');
    expect(weekdayInitial('2026-11-15', 'en-GB')).toBe('S');
    const weeks: PeriodBucket[] = [
      {
        key: '2026-11-02',
        activityCount: 0,
        distanceMeters: 0,
        movingDurationMs: 0,
        elapsedDurationMs: 0,
        elevationGainMeters: 0,
      },
      {
        key: '2026-11-09',
        activityCount: 2,
        distanceMeters: 12_340,
        movingDurationMs: 1,
        elapsedDurationMs: 1,
        elevationGainMeters: 0,
      },
    ];
    const chart = weeklyDistanceChart(weeks, 'metric', 'en-GB');
    expect(chart.map((c) => [c.label, c.value])).toEqual([
      ['2 Nov', 0],
      ['9 Nov', 12_340],
    ]);
    expect(chart[1]!.description).toBe('Week of 9 Nov: 12.3 km, 2 activities');
  });

  it('describes consistency and only mentions a streak of two weeks or more', () => {
    const c = { windowWeeks: 8, activeWeeks: 5, currentStreakWeeks: 3, activeDaysThisWeek: 2 };
    expect(consistencyText(c)).toEqual({
      summary: 'Active in 5 of the last 8 weeks',
      streak: '3-week streak',
    });
    expect(consistencyText({ ...c, currentStreakWeeks: 1 }).streak).toBeNull();
  });

  it('picks the all-sports weekly goal first, and none when there is no weekly goal', () => {
    const goal = (id: string, p: Partial<TrainingGoal>) => ({
      goal: { id, period: 'week', sportType: null, ...p } as TrainingGoal,
      progress: { goalId: id } as GoalProgress,
    });
    expect(
      primaryWeeklyGoal([goal('run', { sportType: 'running' }), goal('all', {})])!.goal.id,
    ).toBe('all');
    expect(primaryWeeklyGoal([goal('month', { period: 'month' })])).toBeNull();
    expect(primaryWeeklyGoal([])).toBeNull();
  });
});

describe('activity view model', () => {
  it('shows only measured metrics on cards', () => {
    expect(cardMetrics(base, 'metric').map((m) => [m.label, m.value, m.unit])).toEqual([
      ['Distance', '10.00', 'km'],
      ['Time', '50:00', undefined],
      ['pace', '5:00', '/km'],
      ['Elev', '42', 'm'],
    ]);
    // No distance (e.g. an interrupted recording), no pace, no elevation: nothing invented.
    const bare = { ...base, distanceMeters: 0, averagePaceMsPerKm: null, elevationGainMeters: 0 };
    expect(cardMetrics(bare, 'metric').map((m) => m.label)).toEqual(['Time']);
    // Swims never show elevation.
    expect(
      cardMetrics({ ...base, sportType: 'swimming', averagePaceMsPerKm: 1_200_000 }, 'metric').map(
        (m) => m.label,
      ),
    ).toEqual(['Distance', 'Time', 'pace']);
    expect(showsElevation({ sportType: 'swimming' })).toBe(false);
    expect(cardMetrics({ ...base, sportType: 'cycling' }, 'imperial')[2]).toEqual({
      label: 'speed',
      value: '7.5',
      unit: 'mph',
    });
  });

  it('derives paused time and source labels', () => {
    expect(pausedDurationMs({ elapsedDurationMs: 3_600_000, movingDurationMs: 3_000_000 })).toBe(
      600_000,
    );
    expect(pausedDurationMs({ elapsedDurationMs: 100, movingDurationMs: 200 })).toBe(0);
    expect(sourceLabel('imported_gpx')).toBe('Imported GPX');
    expect(sourceLabel('imported_tcx')).toBe('Imported TCX');
    expect(sourceLabel('imported_fit')).toBe('Imported FIT');
  });

  it("formats the start time in the activity's own time zone", () => {
    const a = { startedAt: Date.UTC(2026, 10, 11, 6, 42), timezone: 'Asia/Singapore' };
    expect(activityTimeLabel(a, 'en-GB')).toBe('Wed 11 Nov · 14:42');
  });

  it('groups a sorted list into month sections without reordering', () => {
    const items = [
      { id: 'a', startedAt: Date.UTC(2026, 10, 11) },
      { id: 'b', startedAt: Date.UTC(2026, 10, 1) },
      { id: 'c', startedAt: Date.UTC(2026, 9, 30) },
    ] as Array<Pick<Activity, 'id' | 'startedAt'>>;
    const s = groupByMonth(items, 'UTC', 'en-GB');
    expect(s.map((x) => [x.key, x.title, x.data.map((d) => d.id)])).toEqual([
      ['2026-11', 'November 2026', ['a', 'b']],
      ['2026-10', 'October 2026', ['c']],
    ]);
    expect(groupByMonth([], 'UTC')).toEqual([]);
  });

  it('scales split bars to the fastest split and leaves unmeasured splits empty', () => {
    const split = (index: number, pace: number | null, speed: number | null): Split => ({
      index,
      distanceMeters: 1000,
      movingDurationMs: pace ?? 0,
      paceMsPerKm: pace,
      speedMps: speed,
      elevationGainMeters: 0,
      isPartial: false,
    });
    const run = splitBars(
      [split(0, 300_000, null), split(1, 330_000, null), split(2, null, null)],
      'running',
    );
    expect(run[0]).toEqual({ index: 0, ratio: 1, fastest: true });
    expect(run[1]!.ratio).toBeCloseTo(300 / 330, 5);
    expect(run[1]!.fastest).toBe(false);
    expect(run[2]).toEqual({ index: 2, ratio: null, fastest: false });
    const ride = splitBars([split(0, null, 8), split(1, null, 10)], 'cycling');
    expect(ride.map((b) => b.ratio)).toEqual([0.8, 1]);
    expect(splitBars([], 'running')).toEqual([]);
  });

  it('summarises GPS quality from the processed route', () => {
    expect(
      routeQuality({
        gaps: [
          { startedAt: 0, endedAt: 30_000 },
          { startedAt: 100_000, endedAt: 110_000 },
        ],
        acceptedSampleCount: 950,
        rejectedSampleCount: 50,
      }),
    ).toEqual({
      gapCount: 2,
      gapDurationMs: 40_000,
      acceptedSamples: 950,
      rejectedSamples: 50,
      rejectedShare: 0.05,
    });
    expect(
      routeQuality({ gaps: [], acceptedSampleCount: 0, rejectedSampleCount: 0 }).rejectedShare,
    ).toBeNull();
  });
});
