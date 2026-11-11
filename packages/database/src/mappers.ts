import type {
  Activity,
  ActivitySegment,
  Lap,
  LocationSample,
  PersonalRecord,
  Split,
  TrainingGoal,
} from '@pace/domain';
import type { SqlValue } from './driver';

export interface ActivityRow {
  id: string;
  user_id: string | null;
  sport_type: Activity['sportType'];
  title: string;
  description: string | null;
  started_at: number;
  ended_at: number | null;
  timezone: string;
  status: Activity['status'];
  source: Activity['source'];
  swim_mode: Activity['swimMode'];
  pool_length_meters: number | null;
  elapsed_duration_ms: number;
  moving_duration_ms: number;
  distance_meters: number;
  elevation_gain_meters: number;
  elevation_loss_meters: number;
  average_speed_mps: number | null;
  maximum_speed_mps: number | null;
  average_pace_ms_per_km: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  version: number;
}

export const ACTIVITY_COLUMNS =
  'id, user_id, sport_type, title, description, started_at, ended_at, timezone, status, source, swim_mode, ' +
  'pool_length_meters, elapsed_duration_ms, moving_duration_ms, distance_meters, elevation_gain_meters, ' +
  'elevation_loss_meters, average_speed_mps, maximum_speed_mps, average_pace_ms_per_km, created_at, updated_at, ' +
  'deleted_at, version';

export function toActivity(r: ActivityRow): Activity {
  return {
    id: r.id,
    userId: r.user_id,
    sportType: r.sport_type,
    title: r.title,
    description: r.description,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    timezone: r.timezone,
    status: r.status,
    source: r.source,
    swimMode: r.swim_mode,
    poolLengthMeters: r.pool_length_meters,
    elapsedDurationMs: r.elapsed_duration_ms,
    movingDurationMs: r.moving_duration_ms,
    distanceMeters: r.distance_meters,
    elevationGainMeters: r.elevation_gain_meters,
    elevationLossMeters: r.elevation_loss_meters,
    averageSpeedMps: r.average_speed_mps,
    maximumSpeedMps: r.maximum_speed_mps,
    averagePaceMsPerKm: r.average_pace_ms_per_km,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    version: r.version,
  };
}

export function activityValues(a: Activity): SqlValue[] {
  return [
    a.id,
    a.userId,
    a.sportType,
    a.title,
    a.description,
    a.startedAt,
    a.endedAt,
    a.timezone,
    a.status,
    a.source,
    a.swimMode,
    a.poolLengthMeters,
    Math.round(a.elapsedDurationMs),
    Math.round(a.movingDurationMs),
    a.distanceMeters,
    a.elevationGainMeters,
    a.elevationLossMeters,
    a.averageSpeedMps,
    a.maximumSpeedMps,
    a.averagePaceMsPerKm,
    a.createdAt,
    a.updatedAt,
    a.deletedAt,
    a.version,
  ];
}

export interface RoutePointRow {
  sequence_number: number;
  latitude: number;
  longitude: number;
  altitude_meters: number | null;
  horizontal_accuracy_meters: number;
  vertical_accuracy_meters: number | null;
  speed_mps: number | null;
  course_degrees: number | null;
  recorded_at: number;
  source: LocationSample['source'];
}

export const ROUTE_POINT_COLUMNS = [
  'activity_id',
  'sequence_number',
  'latitude',
  'longitude',
  'altitude_meters',
  'horizontal_accuracy_meters',
  'vertical_accuracy_meters',
  'speed_mps',
  'course_degrees',
  'recorded_at',
  'source',
] as const;

export function toSample(r: RoutePointRow): LocationSample {
  return {
    latitude: r.latitude,
    longitude: r.longitude,
    altitudeMeters: r.altitude_meters,
    horizontalAccuracyMeters: r.horizontal_accuracy_meters,
    verticalAccuracyMeters: r.vertical_accuracy_meters,
    speedMps: r.speed_mps,
    courseDegrees: r.course_degrees,
    recordedAt: r.recorded_at,
    source: r.source,
  };
}

export function sampleValues(activityId: string, seq: number, s: LocationSample): SqlValue[] {
  const num = (v: number | null): number | null => (v != null && Number.isFinite(v) ? v : null);
  return [
    activityId,
    seq,
    s.latitude,
    s.longitude,
    num(s.altitudeMeters),
    s.horizontalAccuracyMeters,
    num(s.verticalAccuracyMeters),
    num(s.speedMps),
    num(s.courseDegrees),
    s.recordedAt,
    s.source,
  ];
}

export interface LapRow {
  id: string;
  activity_id: string;
  sequence_number: number;
  started_at: number;
  duration_ms: number;
  distance_meters: number;
  average_pace_ms_per_km: number | null;
  average_speed_mps: number | null;
  length_count: number | null;
}
export const toLap = (r: LapRow): Lap => ({
  id: r.id,
  activityId: r.activity_id,
  sequenceNumber: r.sequence_number,
  startedAt: r.started_at,
  durationMs: r.duration_ms,
  distanceMeters: r.distance_meters,
  averagePaceMsPerKm: r.average_pace_ms_per_km,
  averageSpeedMps: r.average_speed_mps,
  lengthCount: r.length_count,
});

export interface SegmentRow {
  id: string;
  parent_activity_id: string;
  segment_type: ActivitySegment['segmentType'];
  sequence_number: number;
  started_at: number;
  ended_at: number | null;
  elapsed_duration_ms: number;
  moving_duration_ms: number;
  distance_meters: number;
  elevation_gain_meters: number;
}
export const toSegment = (r: SegmentRow): ActivitySegment => ({
  id: r.id,
  parentActivityId: r.parent_activity_id,
  segmentType: r.segment_type,
  sequenceNumber: r.sequence_number,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  elapsedDurationMs: r.elapsed_duration_ms,
  movingDurationMs: r.moving_duration_ms,
  distanceMeters: r.distance_meters,
  elevationGainMeters: r.elevation_gain_meters,
});

export interface SplitRow {
  split_index: number;
  distance_meters: number;
  moving_duration_ms: number;
  pace_ms_per_km: number | null;
  speed_mps: number | null;
  elevation_gain_meters: number;
  is_partial: number;
}
export const toSplit = (r: SplitRow): Split => ({
  index: r.split_index,
  distanceMeters: r.distance_meters,
  movingDurationMs: r.moving_duration_ms,
  paceMsPerKm: r.pace_ms_per_km,
  speedMps: r.speed_mps,
  elevationGainMeters: r.elevation_gain_meters,
  isPartial: r.is_partial === 1,
});

export interface GoalRow {
  id: string;
  user_id: string | null;
  sport_type: TrainingGoal['sportType'];
  goal_type: TrainingGoal['goalType'];
  target_value: number;
  period: TrainingGoal['period'];
  start_date: string | null;
  end_date: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
export const toGoal = (r: GoalRow): TrainingGoal => ({
  id: r.id,
  userId: r.user_id,
  sportType: r.sport_type,
  goalType: r.goal_type,
  targetValue: r.target_value,
  period: r.period,
  startDate: r.start_date,
  endDate: r.end_date,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

export interface RecordRow {
  id: string;
  user_id: string | null;
  sport_type: PersonalRecord['sportType'];
  metric_type: PersonalRecord['metricType'];
  value: number;
  unit: PersonalRecord['unit'];
  basis: PersonalRecord['basis'];
  activity_id: string;
  achieved_at: number;
}
export const toRecord = (r: RecordRow): PersonalRecord => ({
  id: r.id,
  userId: r.user_id,
  sportType: r.sport_type,
  metricType: r.metric_type,
  value: r.value,
  unit: r.unit,
  basis: r.basis,
  activityId: r.activity_id,
  achievedAt: r.achieved_at,
});
