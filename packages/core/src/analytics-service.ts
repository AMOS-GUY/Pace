import {
  ActivityRepository,
  type DatabaseContext,
  GoalRepository,
  PersonalRecordRepository,
} from '@pace/database';
import type { Activity, PersonalRecord, SportType, TrainingGoal } from '@pace/domain';
import { localDateKey } from '@pace/domain';
import {
  type Consistency,
  type DayActivity,
  type GoalProgress,
  type Highlights,
  type PeriodBucket,
  type SportTotals,
  type Totals,
  type WeekComparison,
  compareWeeks,
  goalIsActive,
  goalProgress,
  highlights,
  periodBuckets,
  periodKey,
  totals,
  totalsBySport,
  trailingWeeklyAverage,
  trainingConsistency,
  weekDays,
} from '@pace/metrics-engine';

export interface Dashboard {
  thisWeek: Totals;
  /** Last 8 weeks, chronological, ending with the current week (empty weeks included). */
  weeks: PeriodBucket[];
  recent: Activity[];
  goals: Array<{ goal: TrainingGoal; progress: GoalProgress }>;
  /** Number of completed activities ever recorded or imported. 0 = new athlete. */
  totalActivityCount: number;
  /** This week's totals per sport (only sports with activities), never blended. */
  thisWeekBySport: SportTotals[];
  lastWeek: Totals;
  /** Changes versus last week; each null when last week has no baseline. */
  comparison: WeekComparison;
  /** Average of the 4 complete weeks before this one; null until history covers them. */
  trailingAverage: { distanceMeters: number; movingDurationMs: number; weeks: number } | null;
  /** Monday..Sunday of the current week. */
  days: DayActivity[];
  consistency: Consistency;
}

export interface ProgressView {
  period: 'week' | 'month' | 'year';
  buckets: PeriodBucket[];
  bySport: SportTotals[];
  allTime: Totals;
  highlights: Highlights;
  records: PersonalRecord[];
}

/** Read-side service: every figure is computed from persisted activities. */
export class AnalyticsService {
  private readonly activities: ActivityRepository;
  private readonly goals: GoalRepository;
  private readonly records: PersonalRecordRepository;

  constructor(ctx: DatabaseContext) {
    this.activities = new ActivityRepository(ctx);
    this.goals = new GoalRepository(ctx);
    this.records = new PersonalRecordRepository(ctx);
  }

  async dashboard(now: number, timeZone: string): Promise<Dashboard> {
    const all = await this.activities.allCompleted();
    const weeks = periodBuckets(all, { period: 'week', count: 8, now, timeZone });
    const today = localDateKey(now, timeZone);
    const goals = (await this.goals.list()).filter((g) => goalIsActive(g, today));
    const thisWeek = weeks[weeks.length - 1]!;
    const lastWeek = weeks[weeks.length - 2]!;
    const currentWeekKey = periodKey(now, 'week', timeZone);
    const counted = totals(all).activityCount;
    // allCompleted() is ordered by started_at.
    const firstActivityAt = all[0]?.startedAt ?? null;
    return {
      thisWeek,
      weeks,
      recent: [...all].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5),
      goals: goals.map((goal) => ({ goal, progress: goalProgress(goal, all, now, timeZone) })),
      totalActivityCount: counted,
      thisWeekBySport: totalsBySport(
        all.filter((a) => periodKey(a.startedAt, 'week', timeZone) === currentWeekKey),
      ),
      lastWeek,
      comparison: compareWeeks(thisWeek, lastWeek),
      trailingAverage: trailingWeeklyAverage(weeks, firstActivityAt, timeZone, 4),
      days: weekDays(all, now, timeZone),
      consistency: trainingConsistency(all, { now, timeZone, windowWeeks: 8 }),
    };
  }

  async progress(options: {
    period: 'week' | 'month' | 'year';
    count: number;
    now: number;
    timeZone: string;
    sportType?: SportType;
  }): Promise<ProgressView> {
    const all = await this.activities.allCompleted();
    const scoped = options.sportType ? all.filter((a) => a.sportType === options.sportType) : all;
    return {
      period: options.period,
      buckets: periodBuckets(all, options),
      bySport: totalsBySport(all),
      allTime: totals(scoped),
      highlights: highlights(scoped),
      records: await this.records.list(),
    };
  }
}
