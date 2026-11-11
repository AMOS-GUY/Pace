import {
  ActivityRepository,
  type DatabaseContext,
  GoalRepository,
  PersonalRecordRepository,
} from '@pace/database';
import type { Activity, PersonalRecord, SportType, TrainingGoal } from '@pace/domain';
import { localDateKey } from '@pace/domain';
import {
  type GoalProgress,
  type Highlights,
  type PeriodBucket,
  type SportTotals,
  type Totals,
  goalIsActive,
  goalProgress,
  highlights,
  periodBuckets,
  totals,
  totalsBySport,
} from '@pace/metrics-engine';

export interface Dashboard {
  thisWeek: Totals;
  weeks: PeriodBucket[];
  recent: Activity[];
  goals: Array<{ goal: TrainingGoal; progress: GoalProgress }>;
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
    return {
      thisWeek: weeks[weeks.length - 1]!,
      weeks,
      recent: [...all].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5),
      goals: goals.map((goal) => ({ goal, progress: goalProgress(goal, all, now, timeZone) })),
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
