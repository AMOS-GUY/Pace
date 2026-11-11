import {
  ElevationAccumulator,
  GPS_POLICIES,
  RouteProcessor,
  computeBounds,
  decodePolyline,
  destinationPoint,
  encodePolyline,
  haversineDistanceMeters,
  initialBearingDegrees,
  simplifyRoute,
  validateSample,
} from './index';
import type { LocationSample } from '@pace/domain';
import { ORIGIN, T0, driftTrack, sample, straightTrack } from './test-fixtures/synthetic-track';

function run(samples: LocationSample[], policy = GPS_POLICIES.run): RouteProcessor {
  const p = new RouteProcessor(policy);
  samples.forEach((s, i) => p.process(s, i));
  return p;
}

describe('geodesy', () => {
  it('computes known Haversine distances', () => {
    // One degree of latitude on the mean-radius sphere.
    const d = haversineDistanceMeters(
      { latitude: 0, longitude: 10 },
      { latitude: 1, longitude: 10 },
    );
    expect(d).toBeCloseTo(111_195.08, 0);
    // London -> Paris ~343.5 km great circle.
    const lp = haversineDistanceMeters(
      { latitude: 51.5074, longitude: -0.1278 },
      { latitude: 48.8566, longitude: 2.3522 },
    );
    expect(lp / 1000).toBeCloseTo(343.5, 0);
  });

  it('is zero for identical points and symmetric', () => {
    expect(haversineDistanceMeters(ORIGIN, ORIGIN)).toBe(0);
    const b = destinationPoint(ORIGIN, 45, 1234);
    expect(haversineDistanceMeters(ORIGIN, b)).toBeCloseTo(haversineDistanceMeters(b, ORIGIN), 9);
  });

  it('round-trips destination and bearing', () => {
    const b = destinationPoint(ORIGIN, 30, 5000);
    expect(haversineDistanceMeters(ORIGIN, b)).toBeCloseTo(5000, 6);
    expect(initialBearingDegrees(ORIGIN, b)).toBeCloseTo(30, 6);
  });

  it('handles the antimeridian', () => {
    const d = haversineDistanceMeters(
      { latitude: 0, longitude: 179.9999 },
      { latitude: 0, longitude: -179.9999 },
    );
    expect(d).toBeCloseTo(22.24, 1);
  });

  it('computes bounds', () => {
    expect(computeBounds([])).toBeNull();
    expect(
      computeBounds([
        { latitude: 1, longitude: 2 },
        { latitude: -1, longitude: 5 },
      ]),
    ).toEqual({
      minLatitude: -1,
      maxLatitude: 1,
      minLongitude: 2,
      maxLongitude: 5,
    });
  });

  it('round-trips encoded polylines', () => {
    const pts = [
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ];
    const enc = encodePolyline(pts);
    expect(enc).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline(enc)).toEqual(pts);
  });

  it('simplifies collinear points but keeps corners', () => {
    const line = Array.from({ length: 50 }, (_, i) => destinationPoint(ORIGIN, 90, i * 10));
    const corner = Array.from({ length: 50 }, (_, i) =>
      destinationPoint(line[49]!, 0, (i + 1) * 10),
    );
    const simplified = simplifyRoute([...line, ...corner], 1);
    expect(simplified).toHaveLength(3);
  });
});

describe('sample validation', () => {
  const ok = sample(ORIGIN, T0);
  it('accepts a normal sample', () => expect(validateSample(ok)).toBeNull());
  it('rejects bad coordinates', () => {
    expect(validateSample({ ...ok, latitude: 91 })).toBe('invalid_coordinates');
    expect(validateSample({ ...ok, longitude: Number.NaN })).toBe('invalid_coordinates');
    expect(validateSample({ ...ok, latitude: 0, longitude: 0 })).toBe('invalid_coordinates');
  });
  it('rejects bad timestamps and accuracy', () => {
    expect(validateSample({ ...ok, recordedAt: 0 })).toBe('invalid_timestamp');
    expect(validateSample({ ...ok, horizontalAccuracyMeters: -1 })).toBe('invalid_accuracy');
  });
});

describe('RouteProcessor', () => {
  it('measures a clean 10 km/h run accurately', () => {
    // 2.7778 m/s for 30 minutes = 5000 m
    const p = run(straightTrack({ speedMps: 10 / 3.6, durationSeconds: 1800 }));
    expect(p.distanceMeters).toBeGreaterThan(4990);
    expect(p.distanceMeters).toBeLessThan(5010);
    expect(p.routeSegments).toHaveLength(1);
    expect(p.stats.rejected).toEqual({});
  });

  it('keeps distance accurate with realistic GPS noise', () => {
    const p = run(
      straightTrack({
        speedMps: 3,
        durationSeconds: 1200,
        noiseMeters: 3,
        accuracyMeters: 6,
        seed: 42,
      }),
    );
    const truth = 3600;
    expect(Math.abs(p.distanceMeters - truth) / truth).toBeLessThan(0.03);
  });

  it('does not accumulate distance from stationary drift', () => {
    const p = run(driftTrack({ durationSeconds: 600, noiseMeters: 8, accuracyMeters: 10 }));
    // A naive sum of 600 jittering fixes would be >2 km.
    expect(p.distanceMeters).toBeLessThan(60);
    expect(p.stats.stationary).toBeGreaterThan(400);
  });

  it('accrues slow walking that never exceeds the per-sample noise radius', () => {
    // 0.8 m/s with 1 Hz fixes: each step is below minMovement, but displacement from anchor is not.
    const p = run(straightTrack({ speedMps: 0.8, durationSeconds: 600 }), GPS_POLICIES.walk);
    expect(p.distanceMeters).toBeGreaterThan(470);
    expect(p.distanceMeters).toBeLessThanOrEqual(480.5);
  });

  it('rejects a single implausible jump without adding distance', () => {
    const track = straightTrack({ speedMps: 3, durationSeconds: 120 });
    const jumpIndex = 60;
    const jumped = destinationPoint(track[jumpIndex]!, 0, 2000);
    track[jumpIndex] = {
      ...track[jumpIndex]!,
      latitude: jumped.latitude,
      longitude: jumped.longitude,
    };
    const p = run(track);
    expect(p.stats.rejected.implausible_jump).toBe(1);
    expect(p.distanceMeters).toBeGreaterThan(355);
    expect(p.distanceMeters).toBeLessThan(362);
  });

  it('re-anchors after a sustained displacement without bridging the jump', () => {
    const before = straightTrack({ speedMps: 3, durationSeconds: 60 });
    const farStart = destinationPoint(ORIGIN, 0, 5000);
    const after = straightTrack({
      start: farStart,
      startTime: T0 + 61_000,
      speedMps: 3,
      durationSeconds: 60,
    });
    const p = run([...before, ...after]);
    expect(p.routeGaps.some((g) => g.kind === 'reanchor')).toBe(true);
    expect(p.routeSegments).toHaveLength(2);
    // ~180 m + ~180 m; the 5 km jump is not counted.
    expect(p.distanceMeters).toBeGreaterThan(350);
    expect(p.distanceMeters).toBeLessThan(370);
  });

  it('rejects poor accuracy samples', () => {
    const track = straightTrack({ speedMps: 3, durationSeconds: 30 });
    track[10] = { ...track[10]!, horizontalAccuracyMeters: 200 };
    const p = run(track);
    expect(p.stats.rejected.poor_accuracy).toBe(1);
  });

  it('rejects out-of-order and duplicate samples', () => {
    const track = straightTrack({ speedMps: 3, durationSeconds: 10 });
    const p = new RouteProcessor(GPS_POLICIES.run);
    p.process(track[0]!, 0);
    p.process(track[2]!, 1);
    expect(p.process(track[1]!, 2)).toEqual({ kind: 'rejected', reason: 'out_of_order' });
    expect(p.process(track[2]!, 3)).toEqual({ kind: 'rejected', reason: 'duplicate' });
  });

  it('records a signal-loss gap and never fabricates points', () => {
    const a = straightTrack({ speedMps: 3, durationSeconds: 60 });
    const last = a[a.length - 1]!;
    // 60 s with no fixes (tunnel), then the runner reappears 180 m further on.
    const resume = destinationPoint(last, 90, 180);
    const b = straightTrack({
      start: resume,
      startTime: last.recordedAt + 60_000,
      speedMps: 3,
      durationSeconds: 60,
    });
    const p = run([...a, ...b]);
    p.closeSegment();
    expect(p.routeGaps).toHaveLength(1);
    expect(p.routeGaps[0]!.kind).toBe('signal_loss');
    // The segment is closed at its last real fix before the chord is measured, so the chord is
    // the true 180 m (clean track: no positional noise to tolerate).
    expect(Math.abs(p.routeGaps[0]!.countedDistanceMeters - 180)).toBeLessThan(0.5);
    expect(p.routeSegments).toHaveLength(2);
    expect(p.allPoints().length).toBeLessThanOrEqual(a.length + b.length);
    expect(Math.abs(p.distanceMeters - 540)).toBeLessThan(0.5);
  });

  it('does not count distance across a segment break (pause)', () => {
    const a = straightTrack({ speedMps: 3, durationSeconds: 60 });
    const far = destinationPoint(a[a.length - 1]!, 90, 1000);
    const b = straightTrack({
      start: far,
      startTime: T0 + 400_000,
      speedMps: 3,
      durationSeconds: 60,
    });
    const p = new RouteProcessor(GPS_POLICIES.run);
    a.forEach((s, i) => p.process(s, i));
    p.breakSegment();
    b.forEach((s, i) => p.process(s, a.length + i));
    p.closeSegment();
    // Clean track: filter lag is recovered at each segment close, so the result is exact.
    expect(Math.abs(p.distanceMeters - 360)).toBeLessThan(0.5);
    expect(p.routeSegments).toHaveLength(2);
    expect(p.routeGaps).toHaveLength(0);
  });

  it('rejects a multipath spike after a long stationary period', () => {
    // Regression: plausibility used the (old) anchor time, so after 10 minutes standing still a
    // 2 km spike looked like a 3 m/s move and was counted as distance.
    const still = driftTrack({ durationSeconds: 600, noiseMeters: 2, accuracyMeters: 8 });
    const lastStill = still[still.length - 1]!;
    const spike = destinationPoint(ORIGIN, 45, 2000);
    const track = [...still, sample(spike, lastStill.recordedAt + 1000, { accuracy: 8 })];
    const after = driftTrack({
      durationSeconds: 30,
      noiseMeters: 2,
      accuracyMeters: 8,
      startTime: lastStill.recordedAt + 2000,
      seed: 3,
    });
    const p = run([...track, ...after]);
    expect(p.stats.rejected.implausible_jump).toBe(1);
    expect(p.distanceMeters).toBeLessThan(20);
  });

  it('segment close is idempotent and ignores stationary noise', () => {
    const p = run(driftTrack({ durationSeconds: 120, noiseMeters: 8, accuracyMeters: 10 }));
    const before = p.distanceMeters;
    p.closeSegment();
    p.closeSegment();
    expect(p.distanceMeters).toBe(before);
    const q = run(straightTrack({ speedMps: 3, durationSeconds: 100 }));
    q.closeSegment();
    const once = q.distanceMeters;
    q.closeSegment();
    expect(q.distanceMeters).toBe(once);
    expect(Math.abs(once - 300)).toBeLessThan(0.5);
  });

  it('is deterministic', () => {
    const track = straightTrack({ speedMps: 4, durationSeconds: 300, noiseMeters: 4, seed: 9 });
    const a = run(track);
    const b = run(track);
    expect(a.distanceMeters).toBe(b.distanceMeters);
    expect(a.allPoints()).toEqual(b.allPoints());
  });

  it('estimates current and maximum speed for cycling', () => {
    const p = run(straightTrack({ speedMps: 8, durationSeconds: 120 }), GPS_POLICIES.ride);
    expect(p.currentSpeedMps(T0 + 120_000)).toBeCloseTo(8, 1);
    expect(p.maximumSpeedMps!).toBeCloseTo(8, 1);
  });

  it('reports zero speed when stationary and null without fixes', () => {
    const p = run(driftTrack({ durationSeconds: 60, noiseMeters: 2, accuracyMeters: 10 }));
    expect(p.currentSpeedMps(T0 + 60_000)).toBe(0);
    expect(p.currentSpeedMps(T0 + 600_000)).toBeNull();
  });
});

describe('ElevationAccumulator', () => {
  it('ignores noise below the hysteresis threshold', () => {
    const e = new ElevationAccumulator(3);
    [100, 101.5, 99, 100.8, 98.9, 101.2, 100].forEach((a) => e.add(a));
    expect(e.gainMeters).toBe(0);
    expect(e.lossMeters).toBe(0);
  });

  it('accumulates real climbs and descents', () => {
    const e = new ElevationAccumulator(3);
    for (let a = 100; a <= 200; a += 1) e.add(a);
    for (let a = 200; a >= 150; a -= 1) e.add(a);
    expect(e.gainMeters).toBeCloseTo(99, 0);
    expect(e.lossMeters).toBeCloseTo(48, 0);
    expect(e.maxAltitudeMeters).toBe(200);
  });

  it('is applied by the route processor with vertical accuracy filtering', () => {
    const track = straightTrack({
      speedMps: 3,
      durationSeconds: 600,
      altitude: (t) => 10 + t / 10,
    });
    const p = run(track);
    expect(p.elevationGainMeters).toBeGreaterThan(55);
    expect(p.elevationGainMeters).toBeLessThanOrEqual(60);
  });
});
