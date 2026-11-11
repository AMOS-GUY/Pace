/**
 * REALISTIC SYNTHETIC ROUTES — FOR TESTS ONLY. Never used to create user-visible activities.
 *
 * Deterministic (seeded) generators for the GPS replay suite. Compared to the simple tracks in
 * synthetic-track.ts, these model the properties that make real GPS hard:
 *
 * - Positional error is temporally correlated (first-order Gauss–Markov / AR(1) process), as
 *   real receiver error drifts over tens of seconds rather than jittering independently.
 * - Routes have corners, speed variation, stops at junctions, hills and descents.
 * - Reported accuracy varies and degrades in "urban canyon" sections.
 * - Fault injection: signal gaps (tunnels), poor-accuracy bursts, multipath spikes and clusters.
 *
 * Every scenario carries its ground truth (true path length, moving time, ascent) computed from
 * the noiseless trajectory, so tests assert against known answers.
 */
import type { GeoPoint, LocationSample } from '@pace/domain';
import { destinationPoint, haversineDistanceMeters } from '../geodesy';
import { seededRandom } from './synthetic-track';

export const ROUTE_ORIGIN: GeoPoint = { latitude: 47.3769, longitude: 8.5417 };
export const ROUTE_T0 = Date.UTC(2026, 5, 6, 6, 0, 0);

/** Standard normal from a uniform PRNG (Box–Muller). */
function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/**
 * AR(1) error process sampled at 1 Hz: e[t] = φ·e[t−1] + σ·√(1−φ²)·w[t]. Stationary standard
 * deviation σ; correlation time τ = −1/ln φ seconds.
 */
export class CorrelatedNoise {
  private e = 0;
  private readonly phi: number;
  constructor(
    private readonly sigma: number,
    correlationSeconds: number,
    private readonly normal: () => number,
  ) {
    this.phi = Math.exp(-1 / correlationSeconds);
    this.e = sigma * normal();
  }
  next(sigma = this.sigma): number {
    this.e = this.phi * this.e + sigma * Math.sqrt(1 - this.phi ** 2) * this.normal();
    return this.e;
  }
}

/** Local east/north metres relative to ROUTE_ORIGIN. */
export interface Waypoint {
  x: number;
  y: number;
}

function toGeo(x: number, y: number): GeoPoint {
  const east = destinationPoint(ROUTE_ORIGIN, 90, x);
  return destinationPoint(east, 0, y);
}

export interface ScenarioTruth {
  distanceMeters: number;
  movingDurationMs: number;
  elapsedDurationMs: number;
  ascentMeters: number;
}

export interface Scenario {
  name: string;
  samples: LocationSample[];
  /** Noiseless position at every elapsed second (including seconds with no fix). */
  truePoints: GeoPoint[];
  truth: ScenarioTruth;
  /** Documentation for the test report: what makes this scenario hard. */
  notes: string;
}

export interface RouteSpec {
  name: string;
  notes: string;
  waypoints: Waypoint[];
  laps?: number;
  seed: number;
  /** Speed (m/s) as a function of elapsed seconds while moving. */
  speed: (t: number) => number;
  /** Stops: [startSecond, durationSeconds] in elapsed time. The athlete is stationary. */
  stops?: Array<[number, number]>;
  /** True altitude as a function of along-track distance (metres). */
  altitude?: (s: number) => number;
  /** Horizontal error standard deviation (m) and correlation time (s). */
  noiseSigma: number;
  noiseCorrelationSeconds: number;
  /** Reported horizontal accuracy (m), before per-fix variation. */
  reportedAccuracy: number;
  verticalSigma?: number;
  /** Overrides per elapsed second: degrade, drop or displace fixes. */
  faults?: Array<(t: number) => Fault | null>;
  maxSeconds?: number;
}

export type Fault =
  | { kind: 'drop' }
  | { kind: 'degrade'; sigma: number; accuracy: number }
  | { kind: 'displace'; bearingDeg: number; meters: number; accuracy?: number };

/**
 * Generates 1 Hz fixes along the waypoint polyline, with the given speed profile, stops, terrain
 * and correlated error. Truth distance is the path length actually travelled.
 */
export function buildScenario(spec: RouteSpec): Scenario {
  const rand = seededRandom(spec.seed);
  const normal = gaussian(rand);
  const nx = new CorrelatedNoise(spec.noiseSigma, spec.noiseCorrelationSeconds, normal);
  const ny = new CorrelatedNoise(spec.noiseSigma, spec.noiseCorrelationSeconds, normal);
  const nz = new CorrelatedNoise(spec.verticalSigma ?? 3, 30, normal);
  const wp = spec.waypoints;
  const legs: Array<{ a: Waypoint; b: Waypoint; len: number }> = [];
  for (let lap = 0; lap < (spec.laps ?? 1); lap++) {
    for (let i = 1; i < wp.length; i++) {
      const a = wp[i - 1]!;
      const b = wp[i]!;
      legs.push({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
    }
  }
  const pathLength = legs.reduce((s, l) => s + l.len, 0);
  const positionAt = (s: number): Waypoint => {
    let rem = Math.min(s, pathLength);
    for (const l of legs) {
      if (rem <= l.len) {
        const f = l.len > 0 ? rem / l.len : 0;
        return { x: l.a.x + f * (l.b.x - l.a.x), y: l.a.y + f * (l.b.y - l.a.y) };
      }
      rem -= l.len;
    }
    return legs[legs.length - 1]!.b;
  };

  const samples: LocationSample[] = [];
  const truePoints: GeoPoint[] = [];
  const stops = spec.stops ?? [];
  let s = 0;
  let t = 0;
  let stoppedSeconds = 0;
  let prevTrue: GeoPoint | null = null;
  let truthDistance = 0;
  let ascent = 0;
  let lastAlt: number | null = null;
  const maxSeconds = spec.maxSeconds ?? 6 * 3600;
  while (s < pathLength && t < maxSeconds) {
    const stopped = stops.some(([start, dur]) => t >= start && t < start + dur);
    if (stopped) stoppedSeconds++;
    else s = Math.min(pathLength, s + spec.speed(t));
    const p = positionAt(s);
    const truePoint = toGeo(p.x, p.y);
    truePoints.push(truePoint);
    if (prevTrue) truthDistance += haversineDistanceMeters(prevTrue, truePoint);
    prevTrue = truePoint;
    const alt = spec.altitude ? spec.altitude(s) : 400;
    if (lastAlt != null && alt > lastAlt) ascent += alt - lastAlt;
    lastAlt = alt;

    let sigma = spec.noiseSigma;
    let accuracy = spec.reportedAccuracy * (0.8 + 0.4 * rand());
    let displacement: GeoPoint | null = null;
    let drop = false;
    for (const f of spec.faults ?? []) {
      const fault = f(t);
      if (!fault) continue;
      if (fault.kind === 'drop') drop = true;
      else if (fault.kind === 'degrade') {
        sigma = fault.sigma;
        accuracy = fault.accuracy * (0.8 + 0.4 * rand());
      } else {
        displacement = destinationPoint(truePoint, fault.bearingDeg, fault.meters);
        if (fault.accuracy != null) accuracy = fault.accuracy;
      }
    }
    const ex = nx.next(sigma);
    const ey = ny.next(sigma);
    const ez = nz.next();
    if (!drop) {
      const base = displacement ?? truePoint;
      const noisy = destinationPoint(destinationPoint(base, 90, ex), 0, ey);
      samples.push({
        latitude: noisy.latitude,
        longitude: noisy.longitude,
        altitudeMeters: alt + ez,
        horizontalAccuracyMeters: accuracy,
        verticalAccuracyMeters: (spec.verticalSigma ?? 3) * 1.5,
        speedMps: stopped ? 0 : spec.speed(t),
        courseDegrees: null,
        recordedAt: ROUTE_T0 + t * 1000,
        source: 'replay',
      });
    }
    t++;
  }
  return {
    name: spec.name,
    notes: spec.notes,
    samples,
    truePoints,
    truth: {
      distanceMeters: truthDistance,
      movingDurationMs: (t - 1 - stoppedSeconds) * 1000,
      elapsedDurationMs: (t - 1) * 1000,
      ascentMeters: ascent,
    },
  };
}

// ----------------------------------------------------------------------------- scenario library

/** A ~2.6 km city block loop with 12 corners (run laps of it). */
const CITY_LOOP: Waypoint[] = [
  { x: 0, y: 0 },
  { x: 420, y: 0 },
  { x: 420, y: 180 },
  { x: 610, y: 180 },
  { x: 610, y: 520 },
  { x: 380, y: 520 },
  { x: 380, y: 700 },
  { x: 60, y: 700 },
  { x: 60, y: 460 },
  { x: -150, y: 460 },
  { x: -150, y: 150 },
  { x: 0, y: 150 },
  { x: 0, y: 0 },
];

/** A winding ~20 km road out-and-back with a long climb and descent. */
const ROAD: Waypoint[] = (() => {
  const pts: Waypoint[] = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  let heading = 20;
  for (let i = 0; i < 40; i++) {
    heading += (i % 2 === 0 ? 1 : -1) * (15 + (i % 5) * 6);
    x += 250 * Math.sin((heading * Math.PI) / 180);
    y += 250 * Math.cos((heading * Math.PI) / 180);
    pts.push({ x, y });
  }
  return [...pts, ...pts.slice(0, -1).reverse()];
})();

export function cityRun(): Scenario {
  return buildScenario({
    name: 'city run, 4 laps (~10.5 km)',
    notes:
      'Open-sky running with corners, variable pace and three junction stops; σ=3 m correlated error (τ=20 s).',
    waypoints: CITY_LOOP,
    laps: 4,
    seed: 101,
    speed: (t) => 3.1 + 0.35 * Math.sin(t / 97) + 0.15 * Math.sin(t / 13),
    stops: [
      [900, 25],
      [1800, 20],
      [2700, 30],
    ],
    altitude: (s) => 410 + 8 * Math.sin(s / 300),
    noiseSigma: 3,
    noiseCorrelationSeconds: 20,
    reportedAccuracy: 5,
  });
}

export function hillyRide(): Scenario {
  return buildScenario({
    name: 'hilly road ride (~20 km, ~250 m climbing)',
    notes:
      'Cycling at 5–16 m/s with a long climb and fast descent, two traffic-light stops; σ=2.5 m (τ=25 s).',
    waypoints: ROAD,
    seed: 202,
    speed: (t) => {
      // Climb slowly on the way out, descend fast on the way back.
      const outbound = t < 1700;
      return outbound ? 5.5 + 1.2 * Math.sin(t / 60) : 13 + 3 * Math.sin(t / 45);
    },
    stops: [
      [600, 40],
      [2200, 35],
    ],
    altitude: (s) => (s < 10_000 ? 400 + 0.025 * s : 400 + 0.025 * Math.max(0, 20_000 - s)),
    noiseSigma: 2.5,
    noiseCorrelationSeconds: 25,
    reportedAccuracy: 4,
    verticalSigma: 4,
  });
}

export function stationaryDrift(): Scenario {
  return buildScenario({
    name: 'urban-canyon stationary drift (15 min)',
    notes:
      'Phone left recording at a café between tall buildings: σ=6 m correlated wander (τ=60 s), accuracy 10–20 m.',
    waypoints: [
      { x: 0, y: 0 },
      { x: 0.001, y: 0 },
    ],
    seed: 303,
    speed: () => 0,
    stops: [[0, 900]],
    noiseSigma: 6,
    noiseCorrelationSeconds: 60,
    reportedAccuracy: 14,
    maxSeconds: 901,
  });
}

export function runWithPoorAccuracyBurst(): Scenario {
  return buildScenario({
    name: 'run with a 60 s poor-accuracy burst on a corner section',
    notes:
      'Fixes degrade to σ=25 m / reported 35–70 m (e.g. under trees and buildings) for 60 s around corners.',
    waypoints: CITY_LOOP,
    seed: 404,
    speed: () => 3.2,
    noiseSigma: 3,
    noiseCorrelationSeconds: 20,
    reportedAccuracy: 5,
    faults: [(t) => (t >= 120 && t < 180 ? { kind: 'degrade', sigma: 25, accuracy: 55 } : null)],
  });
}

export function rideThroughTunnel(): Scenario {
  return buildScenario({
    name: 'ride through a 90 s tunnel',
    notes: 'No fixes at all for 90 s on a straight section at 9 m/s (≈810 m).',
    waypoints: [
      { x: 0, y: 0 },
      { x: 6000, y: 0 },
    ],
    seed: 505,
    speed: () => 9,
    noiseSigma: 2.5,
    noiseCorrelationSeconds: 25,
    reportedAccuracy: 4,
    faults: [(t) => (t >= 200 && t < 290 ? { kind: 'drop' } : null)],
  });
}

export function runWithJumps(): Scenario {
  return buildScenario({
    name: 'run with multipath spikes and a displaced cluster',
    notes:
      'A single 450 m spike, a 2-fix 300 m spike, and a 3-fix cluster displaced 150 m that then returns — the hardest case: the cluster is self-consistent.',
    waypoints: CITY_LOOP,
    seed: 606,
    speed: () => 3.2,
    noiseSigma: 3,
    noiseCorrelationSeconds: 20,
    reportedAccuracy: 5,
    faults: [
      (t) => (t === 200 ? { kind: 'displace', bearingDeg: 45, meters: 450, accuracy: 8 } : null),
      (t) =>
        t === 400 || t === 401
          ? { kind: 'displace', bearingDeg: 200, meters: 300, accuracy: 8 }
          : null,
      (t) =>
        t >= 600 && t < 603
          ? { kind: 'displace', bearingDeg: 120, meters: 150, accuracy: 10 }
          : null,
    ],
  });
}
