import type { SportType } from './sport';

export type GoalType = 'distance' | 'activity_count' | 'duration';
export type GoalPeriod = 'week' | 'month';

export interface TrainingGoal {
  id: string;
  userId: string | null;
  /** null = all sports. */
  sportType: SportType | null;
  goalType: GoalType;
  /** metres for distance, count for activity_count, milliseconds for duration. */
  targetValue: number;
  period: GoalPeriod;
  /** Optional ISO dates (YYYY-MM-DD); null = open ended. */
  startDate: string | null;
  endDate: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type RecordMetricType =
  | 'fastest_1k'
  | 'fastest_5k'
  | 'fastest_10k'
  | 'fastest_half_marathon'
  | 'fastest_marathon'
  | 'fastest_10k_ride'
  | 'fastest_20k_ride'
  | 'fastest_40k_ride'
  | 'longest_distance'
  | 'longest_duration'
  | 'highest_elevation_gain';

/** How a record value was derived. */
export type RecordBasis = 'estimated_segment' | 'whole_activity' | 'official_result';

export interface PersonalRecord {
  id: string;
  userId: string | null;
  sportType: SportType;
  metricType: RecordMetricType;
  value: number;
  unit: 'ms' | 'meters';
  basis: RecordBasis;
  activityId: string;
  achievedAt: number;
}
