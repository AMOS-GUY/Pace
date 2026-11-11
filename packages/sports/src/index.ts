import type { MultisportSegmentType, RecordMetricType, SportType, SwimMode } from '@pace/domain';
import { GPS_POLICIES, type GpsPolicy, type GpsProfileId } from '@pace/gps-engine';

export type PrimaryMetric = 'pace' | 'speed' | 'pace_per_100m';

export interface AutoPausePolicy {
  /** Speed below which the athlete is considered stopped. */
  stopSpeedMps: number;
  /** Speed above which a stopped athlete is considered moving again. Must be > stopSpeedMps. */
  resumeSpeedMps: number;
  /** How long the athlete must stay below stopSpeed before auto-pausing. */
  stopDelayMs: number;
}

export interface SportDefinition {
  type: SportType;
  label: string;
  primaryMetric: PrimaryMetric;
  /** GPS profile, or null when the sport is not GPS-recorded on the phone. */
  gpsProfile: GpsProfileId | null;
  /** Split length for automatic splits; null = no automatic splits. */
  splitDistanceMeters: number | null;
  /** Auto-pause thresholds; null = auto-pause not supported for this sport. */
  autoPause: AutoPausePolicy | null;
  /** Whether auto-pause is on by default. */
  autoPauseDefault: boolean;
  /** Pace/speed averages are suppressed below this distance as not meaningful. */
  minDistanceForAveragesMeters: number;
  supportsManualLaps: boolean;
  /** Personal records evaluated for this sport. */
  records: readonly RecordDefinition[];
  /** Icon name in the app icon set (single family: Ionicons). */
  icon: string;
}

export interface RecordDefinition {
  metric: RecordMetricType;
  label: string;
  /** For segment records: the target distance. */
  distanceMeters?: number;
  kind: 'fastest_distance' | 'longest_distance' | 'longest_duration' | 'highest_elevation_gain';
}

const RUN_RECORDS: readonly RecordDefinition[] = [
  { metric: 'fastest_1k', label: 'Fastest 1 km', distanceMeters: 1000, kind: 'fastest_distance' },
  { metric: 'fastest_5k', label: 'Fastest 5 km', distanceMeters: 5000, kind: 'fastest_distance' },
  {
    metric: 'fastest_10k',
    label: 'Fastest 10 km',
    distanceMeters: 10_000,
    kind: 'fastest_distance',
  },
  {
    metric: 'fastest_half_marathon',
    label: 'Fastest half marathon',
    distanceMeters: 21_097.5,
    kind: 'fastest_distance',
  },
  {
    metric: 'fastest_marathon',
    label: 'Fastest marathon',
    distanceMeters: 42_195,
    kind: 'fastest_distance',
  },
  { metric: 'longest_distance', label: 'Longest run', kind: 'longest_distance' },
];

const RIDE_RECORDS: readonly RecordDefinition[] = [
  { metric: 'longest_distance', label: 'Longest ride', kind: 'longest_distance' },
  {
    metric: 'fastest_10k_ride',
    label: 'Fastest 10 km',
    distanceMeters: 10_000,
    kind: 'fastest_distance',
  },
  {
    metric: 'fastest_20k_ride',
    label: 'Fastest 20 km',
    distanceMeters: 20_000,
    kind: 'fastest_distance',
  },
  {
    metric: 'fastest_40k_ride',
    label: 'Fastest 40 km',
    distanceMeters: 40_000,
    kind: 'fastest_distance',
  },
  {
    metric: 'highest_elevation_gain',
    label: 'Highest elevation gain',
    kind: 'highest_elevation_gain',
  },
];

const WALK_HIKE_RECORDS: readonly RecordDefinition[] = [
  { metric: 'longest_distance', label: 'Longest distance', kind: 'longest_distance' },
  { metric: 'longest_duration', label: 'Longest duration', kind: 'longest_duration' },
  {
    metric: 'highest_elevation_gain',
    label: 'Highest elevation gain',
    kind: 'highest_elevation_gain',
  },
];

export const SPORTS: Readonly<Record<SportType, SportDefinition>> = {
  running: {
    type: 'running',
    label: 'Run',
    primaryMetric: 'pace',
    gpsProfile: 'run',
    splitDistanceMeters: 1000,
    autoPause: { stopSpeedMps: 0.6, resumeSpeedMps: 1.2, stopDelayMs: 5000 },
    autoPauseDefault: false,
    minDistanceForAveragesMeters: 100,
    supportsManualLaps: true,
    records: RUN_RECORDS,
    icon: 'walk-outline',
  },
  cycling: {
    type: 'cycling',
    label: 'Ride',
    primaryMetric: 'speed',
    gpsProfile: 'ride',
    splitDistanceMeters: 5000,
    autoPause: { stopSpeedMps: 1.0, resumeSpeedMps: 2.0, stopDelayMs: 3000 },
    autoPauseDefault: true,
    minDistanceForAveragesMeters: 200,
    supportsManualLaps: true,
    records: RIDE_RECORDS,
    icon: 'bicycle-outline',
  },
  walking: {
    type: 'walking',
    label: 'Walk',
    primaryMetric: 'pace',
    gpsProfile: 'walk',
    splitDistanceMeters: 1000,
    autoPause: { stopSpeedMps: 0.3, resumeSpeedMps: 0.7, stopDelayMs: 10_000 },
    autoPauseDefault: false,
    minDistanceForAveragesMeters: 100,
    supportsManualLaps: true,
    records: WALK_HIKE_RECORDS,
    icon: 'footsteps-outline',
  },
  hiking: {
    type: 'hiking',
    label: 'Hike',
    primaryMetric: 'speed',
    gpsProfile: 'hike',
    splitDistanceMeters: 1000,
    autoPause: { stopSpeedMps: 0.25, resumeSpeedMps: 0.6, stopDelayMs: 15_000 },
    autoPauseDefault: false,
    minDistanceForAveragesMeters: 100,
    supportsManualLaps: true,
    records: WALK_HIKE_RECORDS,
    icon: 'trail-sign-outline',
  },
  swimming: {
    type: 'swimming',
    label: 'Swim',
    primaryMetric: 'pace_per_100m',
    // Pool swims are lap-based. Open water uses `open_water_swim` (see swimGpsProfile).
    gpsProfile: null,
    splitDistanceMeters: null,
    autoPause: null,
    autoPauseDefault: false,
    minDistanceForAveragesMeters: 25,
    supportsManualLaps: true,
    records: [{ metric: 'longest_distance', label: 'Longest swim', kind: 'longest_distance' }],
    icon: 'water-outline',
  },
  triathlon: {
    type: 'triathlon',
    label: 'Triathlon',
    primaryMetric: 'speed',
    gpsProfile: null,
    splitDistanceMeters: null,
    autoPause: null,
    autoPauseDefault: false,
    minDistanceForAveragesMeters: 100,
    supportsManualLaps: false,
    records: [],
    icon: 'medal-outline',
  },
};

export function getSport(type: SportType): SportDefinition {
  return SPORTS[type];
}

/** GPS profile for swimming by mode: pool swims never use GPS. */
export function swimGpsProfile(mode: SwimMode): GpsProfileId | null {
  return mode === 'open_water' ? 'open_water_swim' : null;
}

export function gpsPolicyFor(type: SportType, swimMode: SwimMode | null = null): GpsPolicy | null {
  const profile =
    type === 'swimming' ? swimGpsProfile(swimMode ?? 'pool') : SPORTS[type].gpsProfile;
  return profile ? GPS_POLICIES[profile] : null;
}

/** Standard pool lengths offered in the UI (metres; 22.86 m = 25 yd). */
export const STANDARD_POOL_LENGTHS_METERS = [25, 50, 22.86, 33.33] as const;

/** Honest, user-facing limitation shown before an open-water swim is recorded. */
export const OPEN_WATER_LIMITATION_NOTICE =
  'GPS signals do not travel through water. A phone cannot record a reliable open-water route ' +
  'on its own. Use a waterproof GPS device worn on the head (e.g. under a swim cap) or a ' +
  'compatible watch, or expect gaps and reduced distance accuracy.';

// ---------------- Multisport ----------------

export interface MultisportSegmentDefinition {
  type: MultisportSegmentType;
  label: string;
  /** The sport whose metrics apply to this leg; null for transitions (time only). */
  sport: SportType | null;
  gpsProfile: GpsProfileId | null;
}

export const TRIATHLON_SEGMENTS: readonly MultisportSegmentDefinition[] = [
  { type: 'swim', label: 'Swim', sport: 'swimming', gpsProfile: 'open_water_swim' },
  { type: 'transition_1', label: 'T1', sport: null, gpsProfile: null },
  { type: 'bike', label: 'Bike', sport: 'cycling', gpsProfile: 'ride' },
  { type: 'transition_2', label: 'T2', sport: null, gpsProfile: null },
  { type: 'run', label: 'Run', sport: 'running', gpsProfile: 'run' },
];
