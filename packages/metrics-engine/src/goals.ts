import type { TrainingGoal } from '@pace/domain';
import { type AnalyticsActivity, countable, periodKey } from './analytics';

export interface GoalProgress {
  goalId: string;
  periodKey: string;
  current: number;
  target: number;
  /** 0..n (can exceed 1 when the goal is surpassed). */
  ratio: number;
  achieved: boolean;
}

/** Progress for the period containing `now`, computed from recorded activities only. */
export function goalProgress(
  goal: Pick<
    TrainingGoal,
    'id' | 'sportType' | 'goalType' | 'targetValue' | 'period' | 'startDate' | 'endDate'
  >,
  activities: readonly AnalyticsActivity[],
  now: number,
  timeZone: string,
): GoalProgress {
  const key = periodKey(now, goal.period, timeZone);
  let current = 0;
  for (const a of countable(activities)) {
    if (goal.sportType && a.sportType !== goal.sportType) continue;
    if (periodKey(a.startedAt, goal.period, timeZone) !== key) continue;
    switch (goal.goalType) {
      case 'distance':
        current += a.distanceMeters;
        break;
      case 'activity_count':
        current += 1;
        break;
      case 'duration':
        current += a.movingDurationMs;
        break;
    }
  }
  const ratio = goal.targetValue > 0 ? current / goal.targetValue : 0;
  return {
    goalId: goal.id,
    periodKey: key,
    current,
    target: goal.targetValue,
    ratio,
    achieved: ratio >= 1,
  };
}

/** Whether the goal applies on the local date of `now` (respects optional start/end dates). */
export function goalIsActive(
  goal: Pick<TrainingGoal, 'startDate' | 'endDate' | 'deletedAt'>,
  todayKey: string,
): boolean {
  if (goal.deletedAt != null) return false;
  if (goal.startDate && todayKey < goal.startDate) return false;
  if (goal.endDate && todayKey > goal.endDate) return false;
  return true;
}
