import type {
  ActivitySummaryMetrics,
  LocationSample,
  MultisportSegmentType,
  Split,
  SportType,
  SwimMode,
} from '@pace/domain';
import {
  GPS_POLICIES,
  type GpsPolicy,
  type ProcessedPoint,
  type RouteGap,
  RouteProcessor,
} from '@pace/gps-engine';
import {
  type MovingInterval,
  type TimedDistancePoint,
  averagePaceMsPerKm,
  averageSpeedMps,
  computeSplits,
  movingTimeAt,
  speedToPaceMsPerKm,
} from '@pace/metrics-engine';
import { type AutoPausePolicy, TRIATHLON_SEGMENTS, getSport, gpsPolicyFor } from '@pace/sports';
import type { SessionEvent } from './session-events';
import { type RecordingEvent, type RecordingState, transition } from './state-machine';

export interface LegConfig {
  /** Multisport segment type, or null for a single-sport activity. */
  segmentType: MultisportSegmentType | null;
  /** Sport whose metrics apply; null for transitions. */
  sport: SportType | null;
  /** GPS policy, or null when this leg is not GPS-measured (pool swim, transitions). */
  policy: GpsPolicy | null;
  /** Pool swimming: length of the pool; distance comes from lap lengths. */
  poolLengthMeters: number | null;
}

export interface SessionConfig {
  activityId: string;
  sportType: SportType;
  legs: LegConfig[];
  /** null disables auto-pause. */
  autoPause: AutoPausePolicy | null;
  minDistanceForAveragesMeters: number;
  splitDistanceMeters: number | null;
}

export interface SessionConfigOptions {
  swimMode?: SwimMode;
  poolLengthMeters?: number;
  autoPauseEnabled?: boolean;
}

/** Builds the canonical configuration for a sport. Persist the result with the activity for replay. */
export function sessionConfigFor(
  activityId: string,
  sportType: SportType,
  options: SessionConfigOptions = {},
): SessionConfig {
  const sport = getSport(sportType);
  const autoPause = (options.autoPauseEnabled ?? sport.autoPauseDefault) ? sport.autoPause : null;
  let legs: LegConfig[];
  if (sportType === 'triathlon') {
    legs = TRIATHLON_SEGMENTS.map((s) => ({
      segmentType: s.type,
      sport: s.sport,
      policy: s.gpsProfile ? GPS_POLICIES[s.gpsProfile] : null,
      poolLengthMeters: null,
    }));
  } else if (sportType === 'swimming') {
    const mode = options.swimMode ?? 'pool';
    if (mode === 'pool' && !(options.poolLengthMeters && options.poolLengthMeters > 0)) {
      throw new Error('Pool swimming requires a positive pool length');
    }
    legs = [
      {
        segmentType: null,
        sport: 'swimming',
        policy: gpsPolicyFor('swimming', mode),
        poolLengthMeters: mode === 'pool' ? options.poolLengthMeters! : null,
      },
    ];
  } else {
    legs = [
      {
        segmentType: null,
        sport: sportType,
        policy: gpsPolicyFor(sportType),
        poolLengthMeters: null,
      },
    ];
  }
  return {
    activityId,
    sportType,
    legs,
    autoPause,
    minDistanceForAveragesMeters: sport.minDistanceForAveragesMeters,
    splitDistanceMeters: sport.splitDistanceMeters,
  };
}

/** An event together with how many samples had been processed when it occurred (for exact replay). */
export interface RecordedEvent {
  event: SessionEvent;
  afterSampleCount: number;
}

export type GpsQuality = 'none' | 'poor' | 'fair' | 'good';

export interface LiveMetrics {
  state: RecordingState;
  legIndex: number;
  legCount: number;
  elapsedMs: number;
  movingMs: number;
  distanceMeters: number;
  currentSpeedMps: number | null;
  currentPaceMsPerKm: number | null;
  averageSpeedMps: number | null;
  averagePaceMsPerKm: number | null;
  maximumSpeedMps: number | null;
  elevationGainMeters: number;
  gps: {
    quality: GpsQuality;
    lastAccuracyMeters: number | null;
    lastFixAt: number | null;
    signalLost: boolean;
  };
  lapCount: number;
  currentLap: { movingMs: number; distanceMeters: number };
}

export interface LapSummary {
  sequenceNumber: number;
  startedAt: number;
  durationMs: number;
  distanceMeters: number;
  averagePaceMsPerKm: number | null;
  averageSpeedMps: number | null;
  lengthCount: number | null;
}

export interface LegSummary {
  segmentType: MultisportSegmentType | null;
  sequenceNumber: number;
  startedAt: number;
  endedAt: number;
  elapsedDurationMs: number;
  movingDurationMs: number;
  distanceMeters: number;
  elevationGainMeters: number;
}

export interface SessionSummary {
  startedAt: number;
  endedAt: number;
  metrics: ActivitySummaryMetrics;
  laps: LapSummary[];
  legs: LegSummary[];
  splits: Split[];
  route: { segments: ProcessedPoint[][]; gaps: RouteGap[] };
  /** Points against moving time (single GPS leg only), used for splits and records. */
  timedPoints: TimedDistancePoint[];
  quality: { hasReliableTrack: boolean; rejectedSamples: number; acceptedSamples: number };
}

interface LegRuntime {
  config: LegConfig;
  processor: RouteProcessor | null;
  startedAt: number | null;
  endedAt: number | null;
  poolDistanceMeters: number;
}

interface LapBoundary {
  at: number;
  distanceMeters: number;
  lengthCount: number | null;
}

export class SessionError extends Error {}

/**
 * The single source of truth for a recording in progress.
 *
 * All mutations go through `applyEvent` / `ingestSample`, both in live use and during replay,
 * so a session reconstructed from persisted events and samples is identical to the live one.
 * Time is always supplied by the caller (no hidden clock), which makes every result testable.
 */
export class RecordingSession {
  private machine: RecordingState = { status: 'READY' };
  private readonly legs: LegRuntime[];
  private legIndex = 0;
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private readonly intervals: MovingInterval[] = [];
  private readonly laps: LapBoundary[] = [];
  private readonly log: RecordedEvent[] = [];
  private sampleCount = 0;
  private belowSpeedSince: number | null = null;
  private lastAccuracy: number | null = null;
  /** Time after which a sample counts as recorded while paused/interrupted. */
  private stoppedSince: number | null = null;
  /** Start of the current recording interval (start or last manual resume). */
  private activeSince: number | null = null;
  /** Timestamp of the newest sample seen after start (for interruption timing). */
  private newestSampleAt: number | null = null;

  constructor(readonly config: SessionConfig) {
    if (config.legs.length === 0) throw new SessionError('A session needs at least one leg');
    this.legs = config.legs.map((c) => ({
      config: c,
      processor: c.policy ? new RouteProcessor(c.policy) : null,
      startedAt: null,
      endedAt: null,
      poolDistanceMeters: 0,
    }));
  }

  get state(): RecordingState {
    return this.machine;
  }
  get events(): readonly RecordedEvent[] {
    return this.log;
  }
  /**
   * Latest time for which data exists: newest sample or newest event. Used to stop the moving
   * clock at the right moment when a recording is found interrupted.
   */
  get lastDataAt(): number | null {
    const lastEvent = this.log[this.log.length - 1]?.event.at ?? null;
    if (lastEvent == null) return this.newestSampleAt;
    return this.newestSampleAt == null ? lastEvent : Math.max(lastEvent, this.newestSampleAt);
  }

  /** A pre-start acquisition fix: updates the GPS indicator only (never counted or stored). */
  observeAcquisitionSample(sample: LocationSample): void {
    if (this.startedAt != null) return;
    this.lastAccuracy = Number.isFinite(sample.horizontalAccuracyMeters)
      ? sample.horizontalAccuracyMeters
      : null;
  }

  get processedSampleCount(): number {
    return this.sampleCount;
  }
  get requiresGps(): boolean {
    return this.legs[0]!.processor != null;
  }
  get currentLeg(): LegConfig {
    return this.legs[this.legIndex]!.config;
  }

  // ------------------------------------------------------------------ lifecycle (non-persisted)

  /** Drives pre-recording lifecycle states (permission, acquisition). No data is produced. */
  dispatch(event: RecordingEvent): RecordingState {
    const r = transition(this.machine, event);
    if (!r.ok) throw new SessionError(r.reason);
    this.machine = r.state;
    return this.machine;
  }

  // ------------------------------------------------------------------ user commands (persisted)

  /** Begin capturing. Valid from READY (no-GPS legs), ACQUIRING_GPS or LOCATION_UNAVAILABLE. */
  start(at: number, options: { withoutFix?: boolean } = {}): RecordedEvent[] {
    if (this.startedAt != null) throw new SessionError('Session already started');
    if (this.machine.status === 'READY') {
      this.machineStep({ type: 'START_REQUESTED', at, requiresGps: this.requiresGps });
    }
    if (this.machine.status === 'ACQUIRING_GPS' || this.machine.status === 'LOCATION_UNAVAILABLE') {
      this.machineStep(
        options.withoutFix ? { type: 'START_WITHOUT_FIX' } : { type: 'GPS_ACQUIRED' },
      );
    }
    if (this.machine.status !== 'RECORDING')
      throw new SessionError(`Cannot start from ${this.machine.status}`);
    // Machine is already in RECORDING; record the data event.
    return [this.record({ type: 'started', at }, true)];
  }

  pause(at: number): RecordedEvent[] {
    return [this.command({ type: 'paused', at })];
  }
  resume(at: number): RecordedEvent[] {
    return [this.command({ type: 'resumed', at })];
  }
  interrupt(at: number): RecordedEvent[] {
    return [this.command({ type: 'interrupted', at })];
  }
  finish(at: number): RecordedEvent[] {
    return [this.command({ type: 'finished', at })];
  }
  lap(at: number, lengthCount?: number): RecordedEvent[] {
    return [
      this.command(lengthCount != null ? { type: 'lap', at, lengthCount } : { type: 'lap', at }),
    ];
  }
  advanceLeg(at: number): RecordedEvent[] {
    return [this.command({ type: 'leg_advanced', at })];
  }

  /** Transition FINALIZING → SAVED / FAILED once persistence completes. */
  markSaved(): void {
    this.machineStep({ type: 'SAVE_SUCCEEDED' });
  }
  markSaveFailed(error: string): void {
    this.machineStep({ type: 'SAVE_FAILED', error });
  }

  // ------------------------------------------------------------------ samples

  /**
   * Feed one raw sample (already persisted or about to be persisted by the caller).
   * In live mode auto-pause detection may emit events, which the caller must persist.
   */
  ingestSample(
    sample: LocationSample,
    options: { detectAutoPause: boolean } = { detectAutoPause: true },
  ): RecordedEvent[] {
    this.lastAccuracy = Number.isFinite(sample.horizontalAccuracyMeters)
      ? sample.horizontalAccuracyMeters
      : null;
    // Before start, samples only inform the GPS indicator; they are neither persisted nor counted.
    if (this.startedAt == null) return [];
    const sequenceNumber = this.sampleCount++;
    if (Number.isFinite(sample.recordedAt)) {
      this.newestSampleAt = Math.max(this.newestSampleAt ?? sample.recordedAt, sample.recordedAt);
    }
    const leg = this.legs[this.legIndex]!;
    if (!leg.processor) return [];

    const status = this.machine.status;
    const capturing =
      // While recording, fixes taken before the current start/resume belong to the pause (or to
      // acquisition) and must not count toward the new segment.
      (status === 'RECORDING' &&
        (this.activeSince == null || sample.recordedAt >= this.activeSince)) ||
      // Samples recorded before a pause but delivered after it still count.
      ((status === 'PAUSED' ||
        status === 'INTERRUPTED' ||
        status === 'FINALIZING' ||
        status === 'SAVED') &&
        this.stoppedSince != null &&
        sample.recordedAt <= this.stoppedSince);
    if (!capturing) return [];
    if (leg.startedAt != null && sample.recordedAt < leg.startedAt) return [];

    leg.processor.process(sample, sequenceNumber);
    if (!options.detectAutoPause || status !== 'RECORDING') return [];
    return this.detectAutoPause(leg.processor, sample.recordedAt);
  }

  private detectAutoPause(processor: RouteProcessor, now: number): RecordedEvent[] {
    const ap = this.config.autoPause;
    if (!ap || this.machine.status !== 'RECORDING') return [];
    const speed = processor.currentSpeedMps(now);
    if (!this.machine.autoPaused) {
      // Unknown speed (no fix) never triggers auto-pause: tunnels must not stop the clock.
      if (speed != null && speed < ap.stopSpeedMps) {
        this.belowSpeedSince ??= now;
        if (now - this.belowSpeedSince >= ap.stopDelayMs) {
          const at = this.belowSpeedSince;
          this.belowSpeedSince = null;
          return [this.command({ type: 'auto_paused', at })];
        }
      } else {
        this.belowSpeedSince = null;
      }
    } else if (speed != null && speed > ap.resumeSpeedMps) {
      return [this.command({ type: 'auto_resumed', at: now })];
    }
    return [];
  }

  // ------------------------------------------------------------------ event application

  /** Apply a persisted event during replay. */
  replayEvent(recorded: RecordedEvent): void {
    if (recorded.afterSampleCount !== this.sampleCount) {
      throw new SessionError(
        `Replay order mismatch: event expected after ${recorded.afterSampleCount} samples, have ${this.sampleCount}`,
      );
    }
    if (recorded.event.type === 'started') {
      if (this.machine.status === 'READY') {
        this.machineStep({ type: 'START_REQUESTED', at: recorded.event.at, requiresGps: false });
      } else if (this.machine.status === 'RECOVERING') {
        this.machineStep({
          type: 'RECOVERY_SUCCEEDED',
          resumeAs: 'RECORDING',
          at: recorded.event.at,
        });
      }
      this.record(recorded.event, true);
      return;
    }
    this.command(recorded.event);
  }

  private command(event: SessionEvent): RecordedEvent {
    if (this.startedAt == null) throw new SessionError('Session has not started');
    switch (event.type) {
      case 'paused':
        this.machineStep({ type: 'PAUSE', at: event.at });
        break;
      case 'resumed':
        this.machineStep({ type: 'RESUME' });
        break;
      case 'auto_paused':
        this.machineStep({ type: 'AUTO_PAUSE' });
        break;
      case 'auto_resumed':
        this.machineStep({ type: 'AUTO_RESUME' });
        break;
      case 'interrupted':
        this.machineStep({ type: 'INTERRUPT', at: event.at });
        break;
      case 'finished':
        this.machineStep({ type: 'FINISH' });
        break;
      case 'lap':
      case 'leg_advanced':
        if (this.machine.status !== 'RECORDING' && this.machine.status !== 'PAUSED') {
          throw new SessionError(`Cannot record ${event.type} in ${this.machine.status}`);
        }
        if (event.type === 'leg_advanced' && this.legIndex >= this.legs.length - 1) {
          throw new SessionError('Already on the final leg');
        }
        break;
      case 'started':
        throw new SessionError('Session already started');
    }
    return this.record(event, false);
  }

  private record(event: SessionEvent, isStart: boolean): RecordedEvent {
    const recorded: RecordedEvent = { event, afterSampleCount: this.sampleCount };
    this.log.push(recorded);
    const leg = this.legs[this.legIndex]!;
    switch (event.type) {
      case 'started':
        if (!isStart) break;
        this.startedAt = event.at;
        leg.startedAt = event.at;
        this.activeSince = event.at;
        this.openInterval(event.at);
        this.laps.push({ at: event.at, distanceMeters: 0, lengthCount: null });
        break;
      case 'paused':
      case 'interrupted':
        this.closeInterval(event.at);
        this.stoppedSince = event.at;
        break;
      case 'auto_paused':
        this.closeInterval(event.at);
        break;
      case 'resumed':
        this.openInterval(event.at);
        this.stoppedSince = null;
        this.activeSince = event.at;
        this.belowSpeedSince = null;
        leg.processor?.breakSegment();
        break;
      case 'auto_resumed':
        this.openInterval(event.at);
        break;
      case 'lap': {
        if (event.lengthCount != null && leg.config.poolLengthMeters != null) {
          if (!(event.lengthCount > 0)) throw new SessionError('Lap length count must be positive');
          leg.poolDistanceMeters += event.lengthCount * leg.config.poolLengthMeters;
        }
        this.laps.push({
          at: event.at,
          distanceMeters: this.totalDistance(),
          lengthCount: event.lengthCount ?? null,
        });
        break;
      }
      case 'leg_advanced': {
        leg.processor?.closeSegment();
        leg.endedAt = event.at;
        this.legIndex++;
        const next = this.legs[this.legIndex]!;
        next.startedAt = event.at;
        next.processor?.breakSegment();
        break;
      }
      case 'finished':
        leg.processor?.closeSegment();
        this.closeInterval(event.at);
        this.stoppedSince = event.at;
        this.endedAt = event.at;
        leg.endedAt = event.at;
        break;
    }
    return recorded;
  }

  private machineStep(event: RecordingEvent): void {
    const r = transition(this.machine, event);
    if (!r.ok) throw new SessionError(r.reason);
    this.machine = r.state;
  }

  private openInterval(at: number): void {
    const last = this.intervals[this.intervals.length - 1];
    if (last && last.endedAt == null) return;
    this.intervals.push({ startedAt: at, endedAt: null });
  }

  private closeInterval(at: number): void {
    const last = this.intervals[this.intervals.length - 1];
    if (!last || last.endedAt != null) return;
    // Backdated closes (auto-pause) never precede the interval's own start.
    last.endedAt = Math.max(last.startedAt, at);
  }

  // ------------------------------------------------------------------ read model

  private legDistance(leg: LegRuntime): number {
    return (leg.processor?.distanceMeters ?? 0) + leg.poolDistanceMeters;
  }

  totalDistance(): number {
    return this.legs.reduce((s, l) => s + this.legDistance(l), 0);
  }

  movingTime(at: number): number {
    return movingTimeAt(this.intervals, at);
  }

  snapshot(now: number): LiveMetrics {
    const leg = this.legs[this.legIndex]!;
    const end = this.endedAt ?? now;
    const elapsedMs = this.startedAt == null ? 0 : Math.max(0, end - this.startedAt);
    const movingMs = this.startedAt == null ? 0 : this.movingTime(end);
    const distanceMeters = this.totalDistance();
    const currentSpeed =
      this.machine.status === 'RECORDING' && leg.processor
        ? leg.processor.currentSpeedMps(now)
        : null;
    const lastLap = this.laps[this.laps.length - 1];
    const lastFixAt = leg.processor?.lastFixAt ?? null;
    const policy = leg.config.policy;
    const signalLost =
      policy != null &&
      this.machine.status === 'RECORDING' &&
      (lastFixAt == null
        ? this.startedAt != null && now - this.startedAt > policy.gapThresholdMs
        : now - lastFixAt > policy.gapThresholdMs);
    return {
      state: this.machine,
      legIndex: this.legIndex,
      legCount: this.legs.length,
      elapsedMs,
      movingMs,
      distanceMeters,
      currentSpeedMps: currentSpeed,
      currentPaceMsPerKm:
        currentSpeed != null && currentSpeed > 0.3 ? speedToPaceMsPerKm(currentSpeed) : null,
      averageSpeedMps: averageSpeedMps(
        distanceMeters,
        movingMs,
        this.config.minDistanceForAveragesMeters,
      ),
      averagePaceMsPerKm: averagePaceMsPerKm(
        distanceMeters,
        movingMs,
        this.config.minDistanceForAveragesMeters,
      ),
      maximumSpeedMps: this.maxSpeed(),
      elevationGainMeters: this.legs.reduce(
        (s, l) => s + (l.processor?.elevationGainMeters ?? 0),
        0,
      ),
      gps: {
        quality: policy == null ? 'none' : qualityFor(this.lastAccuracy, signalLost),
        lastAccuracyMeters: this.lastAccuracy,
        lastFixAt,
        signalLost,
      },
      lapCount: Math.max(0, this.laps.length - 1),
      currentLap: lastLap
        ? {
            movingMs: Math.max(0, movingMs - this.movingTime(lastLap.at)),
            distanceMeters: distanceMeters - lastLap.distanceMeters,
          }
        : { movingMs: 0, distanceMeters: 0 },
    };
  }

  private maxSpeed(): number | null {
    let max: number | null = null;
    for (const l of this.legs) {
      const m = l.processor?.maximumSpeedMps ?? null;
      if (m != null && (max == null || m > max)) max = m;
    }
    return max;
  }

  /**
   * Processed route for live display, decimated to at most `maxPoints` points (the last point of
   * each segment is always kept). Display only — never used for metrics.
   */
  liveRoute(maxPoints = 1500): Array<Array<{ latitude: number; longitude: number }>> {
    const segments = this.legs.flatMap((l) => (l.processor ? l.processor.routeSegments : []));
    const total = segments.reduce((n, s) => n + s.length, 0);
    const step = Math.max(1, Math.ceil(total / maxPoints));
    return segments.map((seg) =>
      seg
        .filter((_, i) => i % step === 0 || i === seg.length - 1)
        .map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    );
  }

  /** Final summary. Only valid once the session has finished. */
  summary(): SessionSummary {
    if (this.startedAt == null || this.endedAt == null)
      throw new SessionError('Session has not finished');
    const startedAt = this.startedAt;
    const endedAt = this.endedAt;
    const movingDurationMs = this.movingTime(endedAt);
    const distanceMeters = this.totalDistance();
    const min = this.config.minDistanceForAveragesMeters;

    const laps: LapSummary[] = [];
    const boundaries = [...this.laps, { at: endedAt, distanceMeters, lengthCount: null }];
    for (let i = 1; i < boundaries.length; i++) {
      const a = boundaries[i - 1]!;
      const b = boundaries[i]!;
      // The trailing "lap" after the final manual lap is only kept when it has content.
      const isTrailing = i === boundaries.length - 1;
      const duration = this.movingTime(b.at) - this.movingTime(a.at);
      const dist = b.distanceMeters - a.distanceMeters;
      // A trailing remainder with no distance (e.g. resting at the pool wall) is not a lap.
      if (isTrailing && boundaries.length > 2 && dist <= 0) continue;
      if (isTrailing && boundaries.length === 2) continue; // no manual laps recorded
      laps.push({
        sequenceNumber: laps.length,
        startedAt: a.at,
        durationMs: duration,
        distanceMeters: dist,
        averagePaceMsPerKm: averagePaceMsPerKm(dist, duration, Math.min(min, dist)),
        averageSpeedMps: averageSpeedMps(dist, duration),
        lengthCount: isTrailing ? null : b.lengthCount,
      });
    }

    const legs: LegSummary[] =
      this.legs.length > 1
        ? this.legs.map((l, i) => {
            const s = l.startedAt ?? endedAt;
            const e = l.endedAt ?? (l.startedAt != null ? endedAt : s);
            return {
              segmentType: l.config.segmentType,
              sequenceNumber: i,
              startedAt: s,
              endedAt: e,
              elapsedDurationMs: e - s,
              movingDurationMs: this.movingTime(e) - this.movingTime(s),
              distanceMeters: this.legDistance(l),
              elevationGainMeters: l.processor?.elevationGainMeters ?? 0,
            };
          })
        : [];

    const segments = this.legs.flatMap((l) =>
      l.processor ? l.processor.routeSegments.map((s) => [...s]) : [],
    );
    const gaps = this.legs.flatMap((l) => (l.processor ? [...l.processor.routeGaps] : []));
    const singleGpsLeg = this.legs.length === 1 && this.legs[0]!.processor != null;
    const timedPoints: TimedDistancePoint[] = singleGpsLeg
      ? segments.flat().map((p) => ({
          movingTimeMs: this.movingTime(p.recordedAt),
          cumulativeDistanceMeters: p.cumulativeDistanceMeters,
          altitudeMeters: p.altitudeMeters,
        }))
      : [];
    const splits =
      singleGpsLeg && this.config.splitDistanceMeters
        ? computeSplits(timedPoints, this.config.splitDistanceMeters)
        : [];

    let accepted = 0;
    let rejected = 0;
    let gapMs = 0;
    let reanchors = 0;
    for (const l of this.legs) {
      if (!l.processor) continue;
      const st = l.processor.stats;
      accepted += st.accepted + st.stationary;
      rejected += Object.values(st.rejected).reduce((a, b) => a + (b ?? 0), 0);
      for (const g of l.processor.routeGaps) {
        if (g.kind === 'reanchor') reanchors++;
        else gapMs += g.endedAt - g.startedAt;
      }
    }
    const hasReliableTrack =
      singleGpsLeg &&
      accepted >= 10 &&
      reanchors === 0 &&
      gapMs <= 0.05 * Math.max(1, movingDurationMs);

    return {
      startedAt,
      endedAt,
      metrics: {
        elapsedDurationMs: endedAt - startedAt,
        movingDurationMs,
        distanceMeters,
        elevationGainMeters: this.legs.reduce(
          (s, l) => s + (l.processor?.elevationGainMeters ?? 0),
          0,
        ),
        elevationLossMeters: this.legs.reduce(
          (s, l) => s + (l.processor?.elevationLossMeters ?? 0),
          0,
        ),
        averageSpeedMps: averageSpeedMps(distanceMeters, movingDurationMs, min),
        maximumSpeedMps: this.maxSpeed(),
        averagePaceMsPerKm: averagePaceMsPerKm(distanceMeters, movingDurationMs, min),
      },
      laps,
      legs,
      splits,
      route: { segments, gaps },
      timedPoints,
      quality: { hasReliableTrack, acceptedSamples: accepted, rejectedSamples: rejected },
    };
  }

  /** Mark the machine as recovering before replay (used by `replaySession`). */
  beginRecovery(): void {
    this.machineStep({ type: 'RECOVERY_STARTED' });
  }
}

function qualityFor(accuracy: number | null, signalLost: boolean): GpsQuality {
  if (signalLost || accuracy == null || accuracy < 0) return 'none';
  if (accuracy <= 10) return 'good';
  if (accuracy <= 25) return 'fair';
  return 'poor';
}
