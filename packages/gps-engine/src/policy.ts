/**
 * GPS policy: every tunable used by acquisition and processing for one movement profile.
 * Policies are plain data so they can be versioned, passed to native code and replayed.
 */
export interface GpsPolicy {
  /** Identifier of this policy, persisted with each recording for reproducible replay. */
  id: GpsProfileId;
  // ---- Acquisition hints (consumed by native location services) ----
  desiredAccuracy: 'best_for_navigation' | 'best' | 'ten_meters';
  /** Minimum movement (m) before the OS delivers a new fix. 0 = every fix. */
  distanceFilterMeters: number;
  /** iOS CLActivityType hint. */
  iosActivityType: 'fitness' | 'other_navigation' | 'automotive_navigation' | 'other';
  /** Android requested update interval (ms); unused on iOS. */
  androidIntervalMs: number;

  // ---- Processing ----
  /** Samples worse than this horizontal accuracy are rejected. */
  maxHorizontalAccuracyMeters: number;
  /** Altitudes with worse vertical accuracy are ignored for elevation. */
  maxVerticalAccuracyMeters: number;
  /** Minimum displacement from the anchor before distance is accrued. */
  minMovementMeters: number;
  /** Kalman process noise: how quickly the athlete can plausibly move (m/s). */
  processNoiseMps: number;
  /** Fraction of the mean horizontal accuracy treated as noise when deciding movement. */
  accuracyNoiseFactor: number;
  /** Speeds above this (after subtracting accuracy) are considered physically implausible. */
  maxPlausibleSpeedMps: number;
  /** Consecutive mutually-consistent "jump" samples needed to re-anchor the track. */
  jumpRecoverySampleCount: number;
  /** Time without a usable fix after which a route gap is recorded. */
  gapThresholdMs: number;
  /**
   * Whether straight-line distance across a gap is counted (when plausible). No points are
   * ever synthesised; this only decides whether the displacement contributes to distance.
   */
  countDistanceAcrossGaps: boolean;
  /** Hysteresis threshold for elevation gain/loss accumulation. */
  elevationHysteresisMeters: number;
  /** Exponential smoothing time constant applied to altitude before the hysteresis. */
  elevationSmoothingSeconds: number;
  /**
   * Doppler speed below which a fix is treated as stationary (no distance), or null to ignore
   * platform speed. Core Location's Doppler speed stays near 0 while the position wanders, which
   * makes it the most reliable stationary signal. Displacement is measured from the anchor, so a
   * gated fix never loses real movement — it is counted once a moving fix arrives.
   */
  stationarySpeedMps: number | null;
  /** Rolling window used for current/maximum speed. */
  speedWindowMs: number;
  /** Douglas–Peucker tolerance for display geometry. */
  displaySimplificationMeters: number;
}

export type GpsProfileId = 'run' | 'ride' | 'walk' | 'hike' | 'open_water_swim';

const base = {
  androidIntervalMs: 1000,
  maxVerticalAccuracyMeters: 20,
  accuracyNoiseFactor: 0.5,
  jumpRecoverySampleCount: 3,
  countDistanceAcrossGaps: true,
  displaySimplificationMeters: 3,
  elevationSmoothingSeconds: 10,
} as const;

export const GPS_POLICIES: Readonly<Record<GpsProfileId, GpsPolicy>> = {
  run: {
    ...base,
    id: 'run',
    stationarySpeedMps: 0.3,
    processNoiseMps: 3,
    desiredAccuracy: 'best',
    distanceFilterMeters: 0,
    iosActivityType: 'fitness',
    maxHorizontalAccuracyMeters: 30,
    minMovementMeters: 2.5,
    // Elite sprint ~12.5 m/s; allow headroom while rejecting vehicle-speed jumps.
    maxPlausibleSpeedMps: 13,
    gapThresholdMs: 15_000,
    elevationHysteresisMeters: 5,
    speedWindowMs: 10_000,
  },
  walk: {
    ...base,
    id: 'walk',
    stationarySpeedMps: 0.25,
    processNoiseMps: 1.5,
    desiredAccuracy: 'best',
    distanceFilterMeters: 0,
    iosActivityType: 'fitness',
    maxHorizontalAccuracyMeters: 30,
    minMovementMeters: 2.5,
    maxPlausibleSpeedMps: 7,
    gapThresholdMs: 20_000,
    elevationHysteresisMeters: 5,
    speedWindowMs: 15_000,
  },
  hike: {
    ...base,
    id: 'hike',
    stationarySpeedMps: 0.2,
    processNoiseMps: 1.5,
    desiredAccuracy: 'best',
    distanceFilterMeters: 2,
    iosActivityType: 'fitness',
    androidIntervalMs: 2000,
    maxHorizontalAccuracyMeters: 40,
    minMovementMeters: 3,
    maxPlausibleSpeedMps: 7,
    gapThresholdMs: 30_000,
    elevationHysteresisMeters: 5,
    speedWindowMs: 20_000,
  },
  ride: {
    ...base,
    id: 'ride',
    stationarySpeedMps: 0.5,
    processNoiseMps: 8,
    desiredAccuracy: 'best_for_navigation',
    distanceFilterMeters: 0,
    iosActivityType: 'other_navigation',
    maxHorizontalAccuracyMeters: 30,
    minMovementMeters: 4,
    // ~108 km/h: covers fast descents while rejecting most car/train jumps.
    maxPlausibleSpeedMps: 30,
    gapThresholdMs: 10_000,
    elevationHysteresisMeters: 5,
    speedWindowMs: 5_000,
  },
  open_water_swim: {
    ...base,
    id: 'open_water_swim',
    stationarySpeedMps: null,
    processNoiseMps: 1,
    desiredAccuracy: 'best',
    distanceFilterMeters: 0,
    iosActivityType: 'fitness',
    maxHorizontalAccuracyMeters: 50,
    minMovementMeters: 3,
    maxPlausibleSpeedMps: 3.5,
    // Wrist/phone GPS loses fix on every stroke underwater; gaps are expected.
    gapThresholdMs: 30_000,
    elevationHysteresisMeters: 1000,
    speedWindowMs: 30_000,
  },
};
