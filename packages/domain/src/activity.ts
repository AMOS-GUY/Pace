import type { MultisportSegmentType, SportType, SwimMode } from './sport';

/** Persisted lifecycle status of an activity record. */
export type ActivityStatus = 'recording' | 'paused' | 'interrupted' | 'completed' | 'discarded';

/** Origin of an activity record. */
export type ActivitySource =
  'recorded' | 'imported_gpx' | 'imported_tcx' | 'imported_backup' | 'manual' | 'healthkit';

export interface ActivitySummaryMetrics {
  elapsedDurationMs: number;
  movingDurationMs: number;
  distanceMeters: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  /** Average moving speed; null when not meaningful. */
  averageSpeedMps: number | null;
  maximumSpeedMps: number | null;
  /** Average moving pace in milliseconds per kilometre; null when not meaningful. */
  averagePaceMsPerKm: number | null;
}

export interface Activity extends ActivitySummaryMetrics {
  id: string;
  userId: string | null;
  sportType: SportType;
  title: string;
  description: string | null;
  /** Unix epoch ms (UTC). */
  startedAt: number;
  endedAt: number | null;
  /** IANA time zone in which the activity was recorded, used for local-day bucketing. */
  timezone: string;
  status: ActivityStatus;
  source: ActivitySource;
  swimMode: SwimMode | null;
  poolLengthMeters: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Monotonic local version used by synchronisation. */
  version: number;
}

export interface Lap {
  id: string;
  activityId: string;
  sequenceNumber: number;
  startedAt: number;
  durationMs: number;
  distanceMeters: number;
  averagePaceMsPerKm: number | null;
  averageSpeedMps: number | null;
  /** Pool swimming: number of pool lengths in this lap. */
  lengthCount: number | null;
}

export interface ActivitySegment {
  id: string;
  parentActivityId: string;
  segmentType: MultisportSegmentType;
  sequenceNumber: number;
  startedAt: number;
  endedAt: number | null;
  elapsedDurationMs: number;
  movingDurationMs: number;
  distanceMeters: number;
  elevationGainMeters: number;
}

export interface Split {
  index: number;
  /** Distance covered by this split (the final split may be partial). */
  distanceMeters: number;
  movingDurationMs: number;
  paceMsPerKm: number | null;
  speedMps: number | null;
  elevationGainMeters: number;
  isPartial: boolean;
}

export type SensorType = 'heart_rate' | 'cadence' | 'power';

export interface SensorSample {
  id: string;
  activityId: string;
  sensorType: SensorType;
  value: number;
  /** bpm for heart_rate, rpm/spm for cadence, watts for power. */
  unit: 'bpm' | 'rpm' | 'spm' | 'watts';
  recordedAt: number;
  sourceDeviceId: string | null;
}
