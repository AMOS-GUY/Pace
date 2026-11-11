import type { MeasurementSystem, TrainingGoal } from '@pace/domain';
import { distanceUnitLabel, formatDistanceValue, formatDuration } from '@pace/domain';
import type { GoalProgress } from '@pace/metrics-engine';
import { sportLabel } from './display';

export function goalDescription(
  goal: TrainingGoal,
  progress: GoalProgress,
  units: MeasurementSystem,
): string {
  const scope = goal.sportType ? `${sportLabel(goal.sportType)} · ` : '';
  const period = goal.period === 'week' ? 'this week' : 'this month';
  switch (goal.goalType) {
    case 'distance':
      return `${scope}${formatDistanceValue(progress.current, units, 1)} / ${formatDistanceValue(goal.targetValue, units, 0)} ${distanceUnitLabel(units)} ${period}`;
    case 'activity_count':
      return `${scope}${progress.current} / ${goal.targetValue} activities ${period}`;
    case 'duration':
      return `${scope}${formatDuration(progress.current)} / ${formatDuration(goal.targetValue)} ${period}`;
  }
}
