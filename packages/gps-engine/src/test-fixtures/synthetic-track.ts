/**
 * SYNTHETIC GPS DATA — FOR TESTS ONLY.
 *
 * Deterministic generators for replay tests. Never used to create user-visible activities.
 */
import type { GeoPoint, LocationSample } from '@pace/domain';
import { destinationPoint } from '../geodesy';

/** Mulberry32: tiny deterministic PRNG so "noise" is reproducible across runs. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ORIGIN: GeoPoint = { latitude: 1.2903, longitude: 103.8519 };
export const T0 = Date.UTC(2026, 5, 1, 6, 0, 0);

export interface StraightTrackOptions {
  start?: GeoPoint;
  startTime?: number;
  bearingDeg?: number;
  speedMps: number;
  durationSeconds: number;
  intervalMs?: number;
  accuracyMeters?: number;
  /** Max random horizontal noise (metres) added to each fix. */
  noiseMeters?: number;
  seed?: number;
  altitude?: (elapsedSeconds: number) => number | null;
}

/** Samples along a straight line at constant speed. */
export function straightTrack(o: StraightTrackOptions): LocationSample[] {
  const start = o.start ?? ORIGIN;
  const startTime = o.startTime ?? T0;
  const interval = o.intervalMs ?? 1000;
  const bearing = o.bearingDeg ?? 90;
  const rand = seededRandom(o.seed ?? 1);
  const samples: LocationSample[] = [];
  const count = Math.floor((o.durationSeconds * 1000) / interval);
  for (let i = 0; i <= count; i++) {
    const t = (i * interval) / 1000;
    let p = destinationPoint(start, bearing, o.speedMps * t);
    if (o.noiseMeters) {
      p = destinationPoint(p, rand() * 360, rand() * o.noiseMeters);
    }
    samples.push(
      sample(p, startTime + i * interval, {
        accuracy: o.accuracyMeters ?? 5,
        altitude: o.altitude ? o.altitude(t) : null,
        speed: o.speedMps,
      }),
    );
  }
  return samples;
}

/** A stationary device reporting jittering fixes around a point. */
export function driftTrack(o: {
  center?: GeoPoint;
  startTime?: number;
  durationSeconds: number;
  noiseMeters: number;
  accuracyMeters?: number;
  seed?: number;
}): LocationSample[] {
  const center = o.center ?? ORIGIN;
  const rand = seededRandom(o.seed ?? 7);
  const out: LocationSample[] = [];
  for (let i = 0; i <= o.durationSeconds; i++) {
    const p = destinationPoint(center, rand() * 360, rand() * o.noiseMeters);
    out.push(
      sample(p, (o.startTime ?? T0) + i * 1000, {
        accuracy: o.accuracyMeters ?? 10,
        altitude: 10 + rand() * 6 - 3,
        speed: 0,
      }),
    );
  }
  return out;
}

export function sample(
  p: GeoPoint,
  recordedAt: number,
  o: {
    accuracy?: number;
    altitude?: number | null;
    speed?: number | null;
    verticalAccuracy?: number | null;
  } = {},
): LocationSample {
  return {
    latitude: p.latitude,
    longitude: p.longitude,
    altitudeMeters: o.altitude ?? null,
    horizontalAccuracyMeters: o.accuracy ?? 5,
    verticalAccuracyMeters: o.verticalAccuracy ?? (o.altitude != null ? 5 : null),
    speedMps: o.speed ?? null,
    courseDegrees: null,
    recordedAt,
    source: 'replay',
  };
}
