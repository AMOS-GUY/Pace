/**
 * Deterministic GPS replay suite.
 *
 * Each scenario is generated with a fixed seed and replayed through the *full* recording stack
 * (RecordingSession → RouteProcessor → metrics), exactly as live recording would, then compared
 * with ground truth. Tolerances are justified in docs/GPS_RELIABILITY_AUDIT.md (§ Accuracy) —
 * they are derived from the simulated error model, not tuned until the tests pass.
 *
 * The suite also prints a results table (set PACE_GPS_REPORT=1) used for the audit document.
 */
import type { LocationSample } from '@pace/domain';
import { haversineDistanceMeters } from '@pace/gps-engine';
import {
  type Scenario,
  cityRun,
  hillyRide,
  rideThroughTunnel,
  runWithJumps,
  runWithPoorAccuracyBurst,
  stationaryDrift,
} from '../../gps-engine/src/test-fixtures/realistic-routes';
import { type SessionSummary, replaySession, runScript, sessionConfigFor } from './index';
import type { SportType } from '@pace/domain';

interface Result {
  summary: SessionSummary;
  distanceError: number;
  relativeError: number;
}

const results: Array<{
  name: string;
  truth: number;
  measured: number;
  pct: string;
  extra: string;
}> = [];

function replay(s: Scenario, sport: SportType, opts: { autoPause?: boolean } = {}): Result {
  const cfg = sessionConfigFor(`replay-${s.name}`, sport, {
    autoPauseEnabled: opts.autoPause ?? false,
  });
  const { session, events } = runScript(cfg, s.samples, []);
  const summary = session.summary();
  // Determinism: replaying the persisted events + raw samples must give the identical result.
  expect(replaySession(cfg, events, s.samples).summary()).toEqual(summary);
  const distanceError = summary.metrics.distanceMeters - s.truth.distanceMeters;
  const relativeError = s.truth.distanceMeters > 0 ? distanceError / s.truth.distanceMeters : 0;
  results.push({
    name: s.name,
    truth: Math.round(s.truth.distanceMeters),
    measured: Math.round(summary.metrics.distanceMeters),
    pct: s.truth.distanceMeters > 0 ? `${(relativeError * 100).toFixed(2)}%` : '—',
    extra: `moving ${Math.round(summary.metrics.movingDurationMs / 1000)}s / truth ${Math.round(
      s.truth.movingDurationMs / 1000,
    )}s; climb ${Math.round(summary.metrics.elevationGainMeters)} m / truth ${Math.round(s.truth.ascentMeters)} m`,
  });
  return { summary, distanceError, relativeError };
}

afterAll(() => {
  if (process.env.PACE_GPS_REPORT) {
    console.warn(
      ['| Scenario | Truth (m) | Measured (m) | Error | Notes |', '|---|---|---|---|---|']
        .concat(
          results.map((r) => `| ${r.name} | ${r.truth} | ${r.measured} | ${r.pct} | ${r.extra} |`),
        )
        .join('\n'),
    );
  }
});

describe('GPS replay suite — realistic routes', () => {
  it('city run: distance within 1.5 % with correlated error, corners and stops', () => {
    const s = cityRun();
    const r = replay(s, 'running');
    expect(Math.abs(r.relativeError)).toBeLessThan(0.015);
    // Without auto-pause, moving time = elapsed time (stops are part of the run).
    expect(r.summary.metrics.movingDurationMs).toBe(s.truth.elapsedDurationMs);
    expect(r.summary.route.gaps).toHaveLength(0);
    // GPS-only altitude: rolling ±8 m terrain is tracked within 20 % (see audit § Elevation).
    expect(
      Math.abs(r.summary.metrics.elevationGainMeters - s.truth.ascentMeters) / s.truth.ascentMeters,
    ).toBeLessThan(0.2);
  });

  it('hilly ride: distance within 1 %, climbing within 10 %, auto-pause close to true stops', () => {
    const s = hillyRide();
    const r = replay(s, 'cycling', { autoPause: true });
    expect(Math.abs(r.relativeError)).toBeLessThan(0.01);
    expect(
      Math.abs(r.summary.metrics.elevationGainMeters - s.truth.ascentMeters) / s.truth.ascentMeters,
    ).toBeLessThan(0.1);
    // Two stops of 40 s and 35 s. Detection needs the speed window to fall below threshold and
    // auto-resume needs it to rise again, so allow 12 s per stop.
    expect(Math.abs(r.summary.metrics.movingDurationMs - s.truth.movingDurationMs)).toBeLessThan(
      24_000,
    );
    // Max speed is averaged over a 5 s window. Correlated position error (σ=2.5 m, τ=25 s) changes
    // by σ·√(2(1−e^(−5/25))) ≈ 1.5 m over 5 s, i.e. ≈0.3 m/s of speed noise; the maximum over the
    // ~800 descent windows is ≈3σ ≈ 0.9 m/s above the true 16 m/s peak. Bound: peak + 1.0 m/s.
    expect(r.summary.metrics.maximumSpeedMps!).toBeLessThan(17);
    expect(r.summary.metrics.maximumSpeedMps!).toBeGreaterThan(14);
  });

  it('stationary drift: 15 minutes of urban-canyon wander adds less than 30 m', () => {
    const s = stationaryDrift();
    const r = replay(s, 'running');
    expect(r.summary.metrics.distanceMeters).toBeLessThan(30);
    expect(r.summary.metrics.elevationGainMeters).toBeLessThan(10);
  });

  it('poor-accuracy burst: degraded fixes are rejected, the gap is recorded, error stays within 2.5 %', () => {
    const s = runWithPoorAccuracyBurst();
    const r = replay(s, 'running');
    expect(r.summary.quality.rejectedSamples).toBeGreaterThan(40);
    expect(r.summary.route.gaps.some((g) => g.kind === 'signal_loss')).toBe(true);
    // The burst spans corners; the straight chord across them is shorter than the true path.
    expect(r.distanceError).toBeLessThan(0);
    expect(Math.abs(r.relativeError)).toBeLessThan(0.025);
    // Flat route: spurious climbing stays below 5 m per km.
    expect(r.summary.metrics.elevationGainMeters).toBeLessThan(15);
  });

  it('tunnel: 90 s without fixes is bridged by a straight chord without inventing points', () => {
    const s = rideThroughTunnel();
    const r = replay(s, 'cycling');
    const gap = r.summary.route.gaps.find((g) => g.kind === 'signal_loss')!;
    expect(gap).toBeDefined();
    expect(gap.endedAt - gap.startedAt).toBeGreaterThanOrEqual(90_000);
    expect(Math.abs(gap.countedDistanceMeters - 819)).toBeLessThan(15); // 91 s × 9 m/s
    expect(Math.abs(r.relativeError)).toBeLessThan(0.01);
    const processed = r.summary.route.segments.flat().length;
    expect(processed).toBeLessThanOrEqual(s.samples.length);
  });

  it('jumps: spikes never add distance; a self-consistent displaced cluster costs at most ~2 %', () => {
    const s = runWithJumps();
    const r = replay(s, 'running');
    // Without rejection the spikes alone would add ≈ 2×450 + 2×300 + 2×150 = 1800 m.
    expect(r.distanceError).toBeLessThan(25);
    expect(Math.abs(r.relativeError)).toBeLessThan(0.02);
    expect(r.summary.quality.rejectedSamples).toBeGreaterThanOrEqual(3);
  });
});

describe('GPS replay suite — fault invariants', () => {
  const base = cityRun().samples.slice(0, 1200);

  function measure(samples: LocationSample[]): number {
    const cfg = sessionConfigFor('fault', 'running');
    return runScript(cfg, samples, []).session.summary().metrics.distanceMeters;
  }

  it('duplicated fixes do not change the result', () => {
    const doubled = base.flatMap((s, i) => (i % 7 === 0 ? [s, { ...s }] : [s]));
    expect(measure(doubled)).toBeCloseTo(measure(base), 6);
  });

  it('out-of-order fixes are rejected rather than counted twice', () => {
    const shuffled = base.slice();
    for (let i = 50; i < shuffled.length - 1; i += 97) {
      [shuffled[i], shuffled[i + 1]] = [shuffled[i + 1]!, shuffled[i]!];
    }
    expect(Math.abs(measure(shuffled) - measure(base))).toBeLessThan(10);
  });

  it('invalid fixes (null island, negative accuracy, NaN) are ignored', () => {
    const corrupted = base.map((s, i) =>
      i % 101 === 0
        ? { ...s, latitude: 0, longitude: 0 }
        : i % 103 === 0
          ? { ...s, horizontalAccuracyMeters: -1 }
          : i % 107 === 0
            ? { ...s, latitude: Number.NaN }
            : s,
    );
    expect(Math.abs(measure(corrupted) - measure(base))).toBeLessThan(15);
  });

  it('thinning to one fix every 5 s stays within 1 % of the best achievable at that rate', () => {
    // At 0.2 Hz the true path between fixes is unobserved, so corners are cut by geometry, not
    // by the engine. The fair reference is the true path sampled at the same instants.
    const thinned = base.filter((_, i) => i % 5 === 0);
    const truePts = cityRun()
      .truePoints.slice(0, base.length)
      .filter((_, i) => i % 5 === 0);
    let sampledTruth = 0;
    for (let i = 1; i < truePts.length; i++)
      sampledTruth += haversineDistanceMeters(truePts[i - 1]!, truePts[i]!);
    expect(Math.abs(measure(thinned) - sampledTruth) / sampledTruth).toBeLessThan(0.01);
  });
});
