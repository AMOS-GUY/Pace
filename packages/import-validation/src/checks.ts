/**
 * Result vocabulary and tolerances. Every comparison produces one `Check` with a status, both
 * sides, the difference, the tolerance applied and a plain explanation.
 */
import type { NumberExpectation, PresenceExpectation } from './manifest';
import { round } from './privacy';

export type Status = 'PASS' | 'FAIL' | 'WARNING' | 'NOT TESTED';

/**
 * - integrity: the FIT file parsed, and PACE stored exactly what was parsed (no points or sensor
 *   values added, lost or changed).
 * - format: the FIT file versus a GPX/TCX export of the same activity, both read by PACE's
 *   parsers (direct format comparison, before any processing).
 * - pipeline: PACE's final activity from the FIT versus PACE's final activity from the companion.
 * - device: PACE's final activity versus the totals the device wrote into the FIT file
 *   (informational: device totals are not ground truth, so differences are WARNINGs).
 * - expectation: the scenario manifest's expected properties.
 * - roundtrip: the activity exported as GPX by the app and imported again (what an export keeps).
 * - archive: reading archives with PACE's archive reader and bulk import.
 */
export type Tier =
  'integrity' | 'format' | 'pipeline' | 'device' | 'roundtrip' | 'expectation' | 'archive';

export interface Check {
  tier: Tier;
  metric: string;
  status: Status;
  /** PACE's value (or the FIT side in format comparisons). */
  value?: number | string | null;
  /** What it is compared with: companion, device total or expectation. */
  reference?: number | string | null;
  difference?: number | null;
  tolerance?: string | null;
  explanation: string;
}

/** Tolerances, printed with every report. */
export const TOLERANCES = {
  /** Start/end times of the same activity in two formats. */
  timeMs: 2000,
  /** Positions at the same timestamp in the FIT and its companion export. */
  positionMeters: 5,
  /** Lap and pause boundaries between formats. */
  boundaryMs: 2000,
  /** Sensor values at the same timestamp (TCX/GPX store integers, FIT may store 85.5 rpm). */
  sensor: { heart_rate: 0.5, cadence: 1, power: 0.5 },
  /** PACE (FIT) versus PACE (companion): same points, so tight. */
  pipelineDistanceRelative: 0.01,
  pipelineDistanceMeters: 5,
  pipelineMovingRelative: 0.01,
  pipelineMovingSeconds: 5,
  pipelineElapsedSeconds: 2,
  /** PACE versus device totals: informational only. */
  deviceDistanceRelative: 0.02,
  deviceTimerRelative: 0.02,
  deviceTimerSeconds: 10,
  deviceElapsedSeconds: 5,
  deviceLapStartSeconds: 2,
  /** Default minimum gap in a sensor series that counts as a dropout. */
  sensorGapSeconds: 10,
} as const;

export const check = (c: Check): Check => ({
  ...c,
  ...(typeof c.value === 'number' ? { value: round(c.value, 2) } : {}),
  ...(typeof c.reference === 'number' ? { reference: round(c.reference, 2) } : {}),
  ...(typeof c.difference === 'number' ? { difference: round(c.difference, 2) } : {}),
});

export const notTested = (tier: Tier, metric: string, explanation: string): Check =>
  check({ tier, metric, status: 'NOT TESTED', explanation });

/**
 * Compares two numbers with an absolute and/or relative tolerance. Outside the tolerance the
 * check gets `outside` (FAIL for comparisons that must match, WARNING for informational ones).
 */
export function compareNumbers(o: {
  tier: Tier;
  metric: string;
  value: number | null | undefined;
  reference: number | null | undefined;
  absolute?: number;
  relative?: number;
  outside: 'FAIL' | 'WARNING';
  unit: string;
  same: string;
  differs: string;
  missing: string;
}): Check {
  if (
    o.value == null ||
    o.reference == null ||
    !Number.isFinite(o.value) ||
    !Number.isFinite(o.reference)
  )
    return notTested(o.tier, o.metric, o.missing);
  const diff = o.value - o.reference;
  const allowed = Math.max(o.absolute ?? 0, (o.relative ?? 0) * Math.abs(o.reference));
  const tol = [
    o.absolute != null ? `±${o.absolute} ${o.unit}` : null,
    o.relative != null ? `±${o.relative * 100}%` : null,
  ]
    .filter(Boolean)
    .join(' or ');
  const ok = Math.abs(diff) <= allowed + 1e-9;
  return check({
    tier: o.tier,
    metric: o.metric,
    status: ok ? 'PASS' : o.outside,
    value: o.value,
    reference: o.reference,
    difference: diff,
    tolerance: tol || 'exact',
    explanation: ok ? o.same : o.differs,
  });
}

/** Evaluates an expected number. Unknown never passes. */
export function expectNumber(
  metric: string,
  actual: number | null | undefined,
  expected: NumberExpectation | undefined,
  unit = '',
): Check {
  if (expected == null || expected === 'unknown')
    return notTested('expectation', metric, 'Expected value unknown (not given in the manifest)');
  if (actual == null || !Number.isFinite(actual))
    return check({
      tier: 'expectation',
      metric,
      status: 'FAIL',
      value: null,
      reference: describeExpectation(expected, unit),
      explanation: 'PACE produced no value to compare with the expectation',
    });
  let ok: boolean;
  if (typeof expected === 'number') ok = actual === expected;
  else if ('equals' in expected) ok = actual === expected.equals;
  else if ('approx' in expected) ok = Math.abs(actual - expected.approx) <= expected.tolerance;
  else
    ok =
      (expected.min == null || actual >= expected.min) &&
      (expected.max == null || actual <= expected.max);
  return check({
    tier: 'expectation',
    metric,
    status: ok ? 'PASS' : 'FAIL',
    value: actual,
    reference: describeExpectation(expected, unit),
    explanation: ok ? 'Matches the expectation' : 'Does not match the expectation',
  });
}

export function describeExpectation(
  e: Exclude<NumberExpectation, null | 'unknown'>,
  unit = '',
): string {
  const u = unit ? ` ${unit}` : '';
  if (typeof e === 'number') return `${e}${u}`;
  if ('equals' in e) return `${e.equals}${u}`;
  if ('approx' in e) return `${e.approx} ± ${e.tolerance}${u}`;
  if (e.min != null && e.max != null) return `${e.min}–${e.max}${u}`;
  return e.min != null ? `≥ ${e.min}${u}` : `≤ ${e.max}${u}`;
}

export function expectPresence(
  metric: string,
  present: boolean,
  expected: PresenceExpectation | undefined,
): Check {
  if (expected == null || expected === 'unknown')
    return notTested('expectation', metric, 'Expected value unknown (not given in the manifest)');
  const ok = (expected === 'present') === present;
  return check({
    tier: 'expectation',
    metric,
    status: ok ? 'PASS' : 'FAIL',
    value: present ? 'present' : 'absent',
    reference: expected,
    explanation: ok ? 'Matches the expectation' : 'Does not match the expectation',
  });
}

/** FAIL beats WARNING beats PASS; NOT TESTED only when nothing was tested. */
export function overallStatus(checks: readonly Check[]): Status {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'WARNING')) return 'WARNING';
  if (checks.some((c) => c.status === 'PASS')) return 'PASS';
  return 'NOT TESTED';
}

export function countStatuses(checks: readonly Check[]): Record<Status, number> {
  const out: Record<Status, number> = { PASS: 0, FAIL: 0, WARNING: 0, 'NOT TESTED': 0 };
  for (const c of checks) out[c.status]++;
  return out;
}
