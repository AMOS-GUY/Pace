import type { GeoPoint, LocationSample } from '@pace/domain';
import { ElevationAccumulator } from './elevation';
import { haversineDistanceMeters } from './geodesy';
import type { GpsPolicy } from './policy';
import { PositionFilter } from './position-filter';
import { RollingSpeedEstimator } from './speed';
import { type SampleValidationFailure, usableAltitude, validateSample } from './sample-validation';

export type RejectionReason =
  SampleValidationFailure | 'out_of_order' | 'duplicate' | 'poor_accuracy' | 'implausible_jump';

/** A point of the processed (filtered) route geometry. One processed point per raw sample at most. */
export interface ProcessedPoint extends GeoPoint {
  /** Sequence number of the originating raw sample. */
  sequenceNumber: number;
  altitudeMeters: number | null;
  recordedAt: number;
  /** Distance accrued from the start of the activity up to and including this point. */
  cumulativeDistanceMeters: number;
  segmentIndex: number;
}

export type RouteGapKind = 'signal_loss' | 'reanchor';

export interface RouteGap {
  kind: RouteGapKind;
  startedAt: number;
  endedAt: number;
  /** Straight-line displacement across the gap counted toward distance (0 when not counted). */
  countedDistanceMeters: number;
}

export type SampleDecision =
  | { kind: 'rejected'; reason: RejectionReason }
  /** Valid sample within the noise radius of the anchor: no distance, not added to geometry. */
  | { kind: 'stationary' }
  | {
      kind: 'accepted';
      point: ProcessedPoint;
      distanceDeltaMeters: number;
      startedNewSegment: boolean;
      gap: RouteGap | null;
    };

interface Anchor {
  point: ProcessedPoint;
  accuracy: number;
}

/** A raw fix that passed every gate (accepted or stationary): the latest trustworthy position. */
interface PlausibleFix {
  sample: LocationSample;
  sequenceNumber: number;
}

/**
 * Segment-close lag recovery only applies while genuinely moving. Below this speed the latest raw
 * fix is dominated by positional noise rather than filter lag, so it is not used.
 */
export const LAG_RECOVERY_MIN_SPEED_MPS = 0.5;

interface JumpCandidate {
  sample: LocationSample;
  sequenceNumber: number;
}

/**
 * Incremental, deterministic route processor.
 *
 * Feed raw samples in recording order. The processor never mutates or discards raw samples;
 * it only decides how each one contributes to the processed route and to distance:
 *
 * 1. Structural validation, ordering and accuracy gates.
 * 2. Physical plausibility against the current anchor (jump rejection with re-anchoring).
 * 3. Gap detection (signal loss) — gaps are recorded, points are never synthesised.
 * 4. Accuracy-weighted position filtering, then movement detection against a noise radius
 *    so stationary drift does not accrue distance.
 *
 * Given the same policy and the same input sequence, the output is always identical.
 */
export class RouteProcessor {
  private anchor: Anchor | null = null;
  private lastSampleTime: number | null = null;
  private lastSample: LocationSample | null = null;
  private lastUsableFixTime: number | null = null;
  private lastPlausible: PlausibleFix | null = null;
  private segmentIndex = -1;
  private pendingBreak = true;
  private distance = 0;
  private readonly segments: ProcessedPoint[][] = [];
  private readonly gaps: RouteGap[] = [];
  private jumpCandidates: JumpCandidate[] = [];
  private readonly filter: PositionFilter;
  private readonly elevation: ElevationAccumulator;
  private readonly speed: RollingSpeedEstimator;
  private readonly rejectionCounts: Partial<Record<RejectionReason, number>> = {};
  private acceptedCount = 0;
  private stationaryCount = 0;

  constructor(readonly policy: GpsPolicy) {
    this.filter = new PositionFilter(policy.processNoiseMps);
    this.elevation = new ElevationAccumulator(
      policy.elevationHysteresisMeters,
      policy.elevationSmoothingSeconds,
    );
    this.speed = new RollingSpeedEstimator(policy.speedWindowMs);
  }

  /**
   * Request that the next accepted sample starts a new segment with no distance bridged
   * from the previous anchor. Used for pause/resume: movement while paused never counts.
   */
  breakSegment(): void {
    this.closeSegment();
    this.pendingBreak = true;
    this.jumpCandidates = [];
    this.elevation.resetReference();
    this.speed.reset();
  }

  /**
   * Ends the current segment at the latest plausible *raw* fix when the athlete is moving.
   *
   * The position filter trails genuine motion by a few metres; without this the lag is lost at
   * every pause, gap and finish. The added point is a real recorded sample (never synthesised),
   * and the call is idempotent, so replay and repeated summaries give identical results.
   */
  closeSegment(): void {
    const last = this.lastPlausible;
    const anchor = this.anchor;
    if (!last || !anchor || this.pendingBreak) return;
    if (last.sequenceNumber < anchor.point.sequenceNumber) return;
    const speed = this.speed.currentSpeedMps(last.sample.recordedAt);
    if (speed == null || speed < LAG_RECOVERY_MIN_SPEED_MPS) return;

    const segment = this.segments[this.segmentIndex]!;
    if (last.sequenceNumber === anchor.point.sequenceNumber) {
      // The latest fix is the anchor itself, stored at its filtered (lagging) position. Re-solve
      // the final leg against that same fix's raw coordinates.
      if (
        anchor.point.latitude === last.sample.latitude &&
        anchor.point.longitude === last.sample.longitude
      )
        return;
      const prev = segment[segment.length - 2];
      if (!prev) return;
      const oldLeg = haversineDistanceMeters(prev, anchor.point);
      const newLeg = haversineDistanceMeters(prev, last.sample);
      this.distance += newLeg - oldLeg;
      const corrected: ProcessedPoint = {
        ...anchor.point,
        latitude: last.sample.latitude,
        longitude: last.sample.longitude,
        cumulativeDistanceMeters: this.distance,
      };
      segment[segment.length - 1] = corrected;
      this.anchor = { point: corrected, accuracy: anchor.accuracy };
      return;
    }

    const d = haversineDistanceMeters(anchor.point, last.sample);
    if (d < this.noiseRadius(anchor.accuracy, last.sample.horizontalAccuracyMeters)) return;
    this.distance += d;
    this.pushPoint(last.sample, last.sample, last.sequenceNumber, false);
  }

  private noiseRadius(accA: number, accB: number): number {
    return Math.max(
      this.policy.minMovementMeters,
      (this.policy.accuracyNoiseFactor * (accA + accB)) / 2,
    );
  }

  process(sample: LocationSample, sequenceNumber: number): SampleDecision {
    const structural = validateSample(sample);
    if (structural) return this.reject(structural);

    if (this.lastSampleTime != null && sample.recordedAt <= this.lastSampleTime) {
      const same =
        sample.recordedAt === this.lastSampleTime &&
        this.lastSample != null &&
        this.lastSample.latitude === sample.latitude &&
        this.lastSample.longitude === sample.longitude;
      return this.reject(same ? 'duplicate' : 'out_of_order');
    }
    this.lastSampleTime = sample.recordedAt;
    this.lastSample = sample;

    if (sample.horizontalAccuracyMeters > this.policy.maxHorizontalAccuracyMeters) {
      return this.reject('poor_accuracy');
    }

    const previousFixTime = this.lastUsableFixTime;
    this.lastUsableFixTime = sample.recordedAt;

    // First point, or first point after a pause/resume break.
    if (this.anchor == null || this.pendingBreak) {
      this.jumpCandidates = [];
      this.lastPlausible = { sample, sequenceNumber };
      return this.startSegmentDecision(sample, sequenceNumber, null, 0);
    }

    const anchor = this.anchor;
    const rawDistance = haversineDistanceMeters(anchor.point, sample);
    // Elapsed time is measured from the latest plausible fix, not from the anchor: after standing
    // still for minutes the anchor is old, and a multipath spike would otherwise look like a
    // slow, believable move.
    const referenceTime = this.lastPlausible?.sample.recordedAt ?? anchor.point.recordedAt;
    const dtMs = sample.recordedAt - referenceTime;

    if (!this.isPlausible(rawDistance, dtMs, anchor.accuracy, sample.horizontalAccuracyMeters)) {
      return this.handleImplausible(sample, sequenceNumber);
    }
    // A plausible sample means any pending jump candidates were outliers.
    this.jumpCandidates = [];

    const isGap =
      previousFixTime != null && sample.recordedAt - previousFixTime > this.policy.gapThresholdMs;
    if (isGap) {
      // Close the segment before the gap at its last real fix, then measure the chord from there.
      this.closeSegment();
      const chord = haversineDistanceMeters(this.anchor!.point, sample);
      const counted = this.policy.countDistanceAcrossGaps ? chord : 0;
      const gap: RouteGap = {
        kind: 'signal_loss',
        startedAt: previousFixTime!,
        endedAt: sample.recordedAt,
        countedDistanceMeters: counted,
      };
      this.gaps.push(gap);
      this.distance += counted;
      this.lastPlausible = { sample, sequenceNumber };
      return this.startSegmentDecision(sample, sequenceNumber, gap, counted);
    }

    const filtered = this.filter.update(sample, sample.horizontalAccuracyMeters, sample.recordedAt);
    const d = haversineDistanceMeters(anchor.point, filtered);
    this.lastPlausible = { sample, sequenceNumber };
    const reportedStill =
      this.policy.stationarySpeedMps != null &&
      sample.speedMps != null &&
      sample.speedMps >= 0 &&
      sample.speedMps < this.policy.stationarySpeedMps;
    if (reportedStill || d < this.noiseRadius(anchor.accuracy, sample.horizontalAccuracyMeters)) {
      this.stationaryCount++;
      return { kind: 'stationary' };
    }

    this.distance += d;
    const point = this.pushPoint(sample, filtered, sequenceNumber, false);
    return { kind: 'accepted', point, distanceDeltaMeters: d, startedNewSegment: false, gap: null };
  }

  private isPlausible(d: number, dtMs: number, accA: number, accB: number): boolean {
    if (dtMs <= 0) return false;
    const effective = Math.max(0, d - accA - accB);
    return (effective * 1000) / dtMs <= this.policy.maxPlausibleSpeedMps;
  }

  private handleImplausible(sample: LocationSample, sequenceNumber: number): SampleDecision {
    const last = this.jumpCandidates[this.jumpCandidates.length - 1];
    if (last) {
      const d = haversineDistanceMeters(last.sample, sample);
      const dt = sample.recordedAt - last.sample.recordedAt;
      if (
        !this.isPlausible(
          d,
          dt,
          last.sample.horizontalAccuracyMeters,
          sample.horizontalAccuracyMeters,
        )
      ) {
        this.jumpCandidates = [];
      }
    }
    this.jumpCandidates.push({ sample, sequenceNumber });

    if (this.jumpCandidates.length < this.policy.jumpRecoverySampleCount) {
      return this.reject('implausible_jump');
    }

    // Enough mutually consistent samples: the old anchor was most likely wrong (or the device
    // was transported). Re-anchor at the candidates without bridging distance across the jump.
    const candidates = this.jumpCandidates;
    this.jumpCandidates = [];
    const gap: RouteGap = {
      kind: 'reanchor',
      startedAt: this.anchor!.point.recordedAt,
      endedAt: candidates[0]!.sample.recordedAt,
      countedDistanceMeters: 0,
    };
    this.gaps.push(gap);
    this.elevation.resetReference();

    const first = candidates[0]!;
    this.lastPlausible = candidates[candidates.length - 1]!;
    this.startSegment(first.sample, first.sequenceNumber);
    let lastDelta = 0;
    let lastPoint = this.anchor!.point;
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i]!;
      const filtered = this.filter.update(
        c.sample,
        c.sample.horizontalAccuracyMeters,
        c.sample.recordedAt,
      );
      lastDelta = haversineDistanceMeters(this.anchor!.point, filtered);
      this.distance += lastDelta;
      lastPoint = this.pushPoint(c.sample, filtered, c.sequenceNumber, false);
    }
    return {
      kind: 'accepted',
      point: lastPoint,
      distanceDeltaMeters: lastDelta,
      startedNewSegment: true,
      gap,
    };
  }

  private startSegmentDecision(
    sample: LocationSample,
    sequenceNumber: number,
    gap: RouteGap | null,
    distanceDelta: number,
  ): SampleDecision {
    const point = this.startSegment(sample, sequenceNumber);
    return {
      kind: 'accepted',
      point,
      distanceDeltaMeters: distanceDelta,
      startedNewSegment: true,
      gap,
    };
  }

  private startSegment(sample: LocationSample, sequenceNumber: number): ProcessedPoint {
    this.segmentIndex++;
    this.segments.push([]);
    this.pendingBreak = false;
    this.speed.reset();
    const filtered = this.filter.reset(sample, sample.horizontalAccuracyMeters, sample.recordedAt);
    return this.pushPoint(sample, filtered, sequenceNumber, true);
  }

  private pushPoint(
    sample: LocationSample,
    position: GeoPoint,
    sequenceNumber: number,
    _segmentStart: boolean,
  ): ProcessedPoint {
    const point: ProcessedPoint = {
      sequenceNumber,
      latitude: position.latitude,
      longitude: position.longitude,
      altitudeMeters: sample.altitudeMeters,
      recordedAt: sample.recordedAt,
      cumulativeDistanceMeters: this.distance,
      segmentIndex: this.segmentIndex,
    };
    this.segments[this.segmentIndex]!.push(point);
    this.anchor = { point, accuracy: sample.horizontalAccuracyMeters };
    this.acceptedCount++;
    this.speed.add(sample.recordedAt, this.distance);
    const alt = usableAltitude(sample, this.policy.maxVerticalAccuracyMeters);
    if (alt != null) this.elevation.add(alt, sample.recordedAt);
    return point;
  }

  private reject(reason: RejectionReason): SampleDecision {
    this.rejectionCounts[reason] = (this.rejectionCounts[reason] ?? 0) + 1;
    return { kind: 'rejected', reason };
  }

  // ---------- Read model ----------

  get distanceMeters(): number {
    return this.distance;
  }
  get elevationGainMeters(): number {
    return this.elevation.gainMeters;
  }
  get elevationLossMeters(): number {
    return this.elevation.lossMeters;
  }
  get maximumSpeedMps(): number | null {
    return this.speed.maximumSpeedMps;
  }
  /**
   * Current speed at `now`. Returns 0 when fixes are arriving but all lie within the noise
   * radius (standing still), and null when there is no recent usable fix at all.
   */
  currentSpeedMps(now: number): number | null {
    const s = this.speed.currentSpeedMps(now);
    if (s != null) return s;
    if (
      this.lastUsableFixTime != null &&
      now - this.lastUsableFixTime <= this.policy.speedWindowMs
    ) {
      return 0;
    }
    return null;
  }
  /** Time of the most recent sample with usable accuracy, or null. */
  get lastFixAt(): number | null {
    return this.lastUsableFixTime;
  }
  get routeSegments(): readonly (readonly ProcessedPoint[])[] {
    return this.segments;
  }
  get routeGaps(): readonly RouteGap[] {
    return this.gaps;
  }
  get stats(): {
    accepted: number;
    stationary: number;
    rejected: Readonly<Partial<Record<RejectionReason, number>>>;
  } {
    return {
      accepted: this.acceptedCount,
      stationary: this.stationaryCount,
      rejected: { ...this.rejectionCounts },
    };
  }
  /** All processed points across segments, in order. */
  allPoints(): ProcessedPoint[] {
    return this.segments.flat();
  }
}
