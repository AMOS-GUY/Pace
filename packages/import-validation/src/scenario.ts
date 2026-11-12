/**
 * Validates one FIT activity scenario: the original FIT file, optional GPX/TCX exports of the
 * same activity, and PACE's final imported activity — compared three ways (format, pipeline,
 * device) plus integrity checks and the manifest's expectations.
 *
 * Nothing here changes how PACE imports: the parsers and the import pipeline are used as they
 * are, and discrepancies are recorded, never corrected.
 */
import {
  FitDecodeError,
  FitImportError,
  SENSOR_BOUNDS,
  type ParsedTrack,
  parseFit,
  parseGpxTrack,
  parseTcx,
} from '@pace/formats';
import type { LocationSample } from '@pace/domain';
import {
  type Check,
  type Status,
  TOLERANCES,
  check,
  compareNumbers,
  expectNumber,
  expectPresence,
  notTested,
  overallStatus,
} from './checks';
import { type DeviceTotals, readDeviceTotals, sessionTotal } from './device-totals';
import { type ActivityExpectations, SENSOR_KINDS, type SensorKind } from './manifest';
import { type ActivityMetrics, importAndMeasure, memoryDatabase } from './pipeline';
import { type Secrets, round, scrub } from './privacy';

export interface CompanionInput {
  format: 'gpx' | 'tcx';
  text: string;
}

export interface ActivityInput {
  id: string;
  fit: Uint8Array;
  companions: CompanionInput[];
  expect: ActivityExpectations;
  /** Treat a refused file as a failure (all files are expected to be importable). */
  expectValid?: boolean;
}

export type Outcome = 'imported' | 'refused' | 'needs_sport' | 'archive';

export interface ActivitySummary {
  sport: string | null;
  points: number;
  segments: number;
  pauses: number;
  laps: number;
  legs: number | null;
  durationMinutes: number;
  distanceKm: number | null;
  movingMinutes: number | null;
  sensors: Record<SensorKind, number>;
}

export interface ScenarioResult {
  id: string;
  kind: 'activity' | 'archive';
  status: Status;
  outcome: Outcome;
  /** Formats of the companion files compared (never their names). */
  companions: string[];
  summary: ActivitySummary | Record<string, unknown> | null;
  warnings: string[];
  checks: Check[];
}

const UNITS = { heart_rate: 'bpm', cadence: 'rpm', power: 'W' } as const;
const SENSOR_LABEL = { heart_rate: 'heart rate', cadence: 'cadence', power: 'power' } as const;

function haversine(a: LocationSample, b: LocationSample): number {
  const r = (d: number): number => (d * Math.PI) / 180;
  const dLat = r(b.latitude - a.latitude);
  const dLon = r(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Laps of a stored activity. PACE stores lap rows only when an activity has lap changes; an
 * activity without any is one lap. This is a representation difference, counted explicitly.
 */
export const lapCount = (m: ActivityMetrics): number => m.laps.length || 1;
const NO_LAP_ROWS =
  ' (PACE stores no lap rows for an activity without lap changes; counted as one lap)';

const points = (t: ParsedTrack): LocationSample[] => t.segments.flat();
const startOf = (t: ParsedTrack): number => points(t)[0]!.recordedAt;
const endOf = (t: ParsedTrack): number => points(t).at(-1)!.recordedAt;

/** A time difference, reported without either absolute time (times are personal metadata). */
function compareOffset(
  tier: Check['tier'],
  metric: string,
  diffMs: number,
  toleranceMs: number,
  outside: 'FAIL' | 'WARNING',
  same: string,
  differs: string,
): Check {
  const ok = Math.abs(diffMs) <= toleranceMs;
  return check({
    tier,
    metric,
    status: ok ? 'PASS' : outside,
    difference: diffMs / 1000,
    tolerance: `±${toleranceMs / 1000} s`,
    explanation: ok ? same : differs,
  });
}

// ---------------------------------------------------------------------------------------------
// Integrity: the parsed track is well-formed and PACE stored exactly what was parsed.

export function trackInvariants(t: ParsedTrack): string[] {
  const problems: string[] = [];
  const pts = points(t);
  if (t.segments.some((s) => s.length === 0)) problems.push('empty segment');
  for (let i = 1; i < pts.length; i++)
    if (!(pts[i]!.recordedAt > pts[i - 1]!.recordedAt)) {
      problems.push(`point times not increasing at point ${i}`);
      break;
    }
  if (pts.some((p) => !(Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180)))
    problems.push('invalid coordinate');
  if (pts.some((p) => p.altitudeMeters != null && !Number.isFinite(p.altitudeMeters)))
    problems.push('non-finite altitude');
  for (const s of t.sensors) {
    const b = SENSOR_BOUNDS[s.type];
    if (!b || s.value < b.min || s.value > b.max || UNITS[s.type] !== s.unit) {
      problems.push(`sensor value out of range or wrong unit (${s.type})`);
      break;
    }
  }
  for (let i = 1; i < t.sensors.length; i++)
    if (t.sensors[i]!.recordedAt < t.sensors[i - 1]!.recordedAt) {
      problems.push('sensor times not in order');
      break;
    }
  const first = pts[0]?.recordedAt ?? 0;
  for (let i = 0; i < t.lapStarts.length; i++)
    if (t.lapStarts[i]! <= first || (i > 0 && t.lapStarts[i]! <= t.lapStarts[i - 1]!)) {
      problems.push('laps out of order');
      break;
    }
  if (t.sportType === 'triathlon') {
    const l = t.legStarts ?? [];
    if (l.length !== 4 || l.some((x, i) => i > 0 && x <= l[i - 1]!))
      problems.push('triathlon legs invalid');
  }
  return problems;
}

const sensorKey = (s: { type: string; recordedAt: number; value: number; unit: string }): string =>
  `${s.recordedAt}|${s.type}|${s.value}|${s.unit}`;

export function integrityChecks(t: ParsedTrack, m: ActivityMetrics): Check[] {
  const out: Check[] = [];
  const problems = trackInvariants(t);
  out.push(
    check({
      tier: 'integrity',
      metric: 'parsed track invariants',
      status: problems.length ? 'FAIL' : 'PASS',
      explanation: problems.length
        ? `Violated: ${problems.join('; ')}`
        : 'Point times strictly increase, coordinates and sensor values are valid, laps and legs are ordered',
    }),
  );

  const parsedTimes = points(t).map((p) => p.recordedAt);
  const samePoints =
    parsedTimes.length === m.pointTimes.length &&
    parsedTimes.every((x, i) => x === m.pointTimes[i]);
  out.push(
    check({
      tier: 'integrity',
      metric: 'GPS points stored as parsed',
      status: samePoints ? 'PASS' : 'FAIL',
      value: m.pointTimes.length,
      reference: parsedTimes.length,
      tolerance: 'exact',
      explanation: samePoints
        ? 'Every parsed point was stored once at its own time; none were added or lost'
        : 'Stored points differ from the parsed points (added, lost or re-timed)',
    }),
  );

  const parsed = t.sensors.map(sensorKey).sort();
  const stored = m.sensors.map(sensorKey).sort();
  const sameSensors = parsed.length === stored.length && parsed.every((x, i) => x === stored[i]);
  out.push(
    check({
      tier: 'integrity',
      metric: 'sensor samples stored as recorded',
      status: sameSensors ? 'PASS' : 'FAIL',
      value: stored.length,
      reference: parsed.length,
      tolerance: 'exact',
      explanation: sameSensors
        ? 'Heart rate, cadence and power were stored exactly as recorded: none interpolated, filled in, changed or dropped'
        : 'Stored sensor samples differ from the recorded ones',
    }),
  );

  const boundaries = t.segments.slice(1).map((seg, i) => ({
    pausedAt: t.segments[i]!.at(-1)!.recordedAt,
    resumedAt: seg[0]!.recordedAt,
  }));
  const samePauses =
    boundaries.length === m.pauses.length &&
    boundaries.every(
      (b, i) => b.pausedAt === m.pauses[i]!.pausedAt && b.resumedAt === m.pauses[i]!.resumedAt,
    );
  out.push(
    check({
      tier: 'integrity',
      metric: 'pauses at segment boundaries',
      status: samePauses ? 'PASS' : 'FAIL',
      value: m.pauses.length,
      reference: boundaries.length,
      tolerance: 'exact',
      explanation: samePauses
        ? 'Each timer stop in the file became exactly one pause between the same two points'
        : 'Stored pauses do not match the timer stops in the file',
    }),
  );

  const missingLaps = t.lapStarts.filter(
    (s) => !m.laps.some((l) => Math.abs(l.startedAt - s) <= 1000),
  ).length;
  out.push(
    check({
      tier: 'integrity',
      metric: 'lap starts stored',
      status: missingLaps === 0 ? 'PASS' : 'FAIL',
      value: t.lapStarts.length - missingLaps,
      reference: t.lapStarts.length,
      tolerance: '±1 s',
      explanation:
        missingLaps === 0
          ? 'Every lap start in the file has a stored lap starting at the same time'
          : `${missingLaps} lap start(s) in the file have no stored lap (see warnings: laps after the last GPS point are not imported)`,
    }),
  );

  if (t.sportType === 'triathlon') {
    const expected = [startOf(t), ...(t.legStarts ?? [])];
    const ok =
      m.legs.length === expected.length &&
      m.legs.every((l, i) => Math.abs(l.startedAt - expected[i]!) <= 1000);
    out.push(
      check({
        tier: 'integrity',
        metric: 'triathlon legs stored',
        status: ok ? 'PASS' : 'FAIL',
        value: m.legs.length,
        reference: expected.length,
        tolerance: '±1 s per leg start',
        explanation: ok
          ? 'Swim, T1, bike, T2 and run were stored at the leg start times in the file'
          : 'Stored legs do not match the legs in the file',
      }),
    );
  }

  out.push(
    compareOffset(
      'integrity',
      'stored start and end',
      Math.max(
        Math.abs(m.startedAt - startOf(t)),
        m.endedAt == null ? Infinity : Math.abs(m.endedAt - endOf(t)),
      ),
      0,
      'FAIL',
      'The activity starts at the first point and ends at the last point',
      'The stored start or end differs from the first or last point',
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// Format: FIT versus a GPX/TCX export of the same activity, both read by PACE's parsers.

function sensorComparison(a: ParsedTrack, b: ParsedTrack, label: string): Check[] {
  return SENSOR_KINDS.map((type) => {
    const sa = a.sensors.filter((s) => s.type === type);
    const sb = new Map(
      b.sensors.filter((s) => s.type === type).map((s) => [s.recordedAt, s.value]),
    );
    const metric = `${SENSOR_LABEL[type]} samples`;
    if (sa.length === 0 && sb.size === 0)
      return notTested('format', metric, 'Neither file has samples');
    if (sa.length === 0 || sb.size === 0)
      return check({
        tier: 'format',
        metric,
        status: 'WARNING',
        value: sa.length,
        reference: sb.size,
        explanation:
          sa.length === 0
            ? `Only the ${label} has ${SENSOR_LABEL[type]}; the FIT import has none`
            : `The ${label} export has no ${SENSOR_LABEL[type]} (many exports drop some sensor channels)`,
      });
    let matched = 0;
    let mismatched = 0;
    let maxDiff = 0;
    for (const s of sa) {
      const v = sb.get(s.recordedAt);
      if (v == null) continue;
      matched++;
      const d = Math.abs(s.value - v);
      maxDiff = Math.max(maxDiff, d);
      if (d > TOLERANCES.sensor[type]) mismatched++;
    }
    const onlyFit = sa.length - matched;
    const onlyOther = sb.size - matched;
    const status: Status =
      matched === 0
        ? 'WARNING'
        : mismatched > 0
          ? 'FAIL'
          : onlyFit || onlyOther
            ? 'WARNING'
            : 'PASS';
    const explanation =
      matched === 0
        ? 'No samples at matching times; values cannot be compared'
        : mismatched > 0
          ? `${mismatched} of ${matched} samples at matching times differ by more than the tolerance`
          : onlyFit || onlyOther
            ? `Values match at all ${matched} shared times; ${onlyFit} sample(s) only in the FIT and ${onlyOther} only in the ${label} (left missing, not filled in)`
            : `All ${matched} samples match`;
    return check({
      tier: 'format',
      metric,
      status,
      value: sa.length,
      reference: sb.size,
      difference: maxDiff,
      tolerance: `±${TOLERANCES.sensor[type]} ${UNITS[type]} per sample`,
      explanation,
    });
  });
}

export function formatChecks(fit: ParsedTrack, other: ParsedTrack): Check[] {
  const label = other.format.toUpperCase();
  const out: Check[] = [
    compareOffset(
      'format',
      'start time',
      startOf(fit) - startOf(other),
      TOLERANCES.timeMs,
      'FAIL',
      `The FIT and ${label} start at the same time`,
      `The FIT and ${label} start at different times`,
    ),
    compareOffset(
      'format',
      'end time',
      endOf(fit) - endOf(other),
      TOLERANCES.timeMs,
      'FAIL',
      `The FIT and ${label} end at the same time`,
      `The FIT and ${label} end at different times`,
    ),
  ];
  const a = points(fit);
  const b = points(other);
  out.push(
    check({
      tier: 'format',
      metric: 'GPS point count',
      status: a.length === b.length ? 'PASS' : 'WARNING',
      value: a.length,
      reference: b.length,
      difference: a.length - b.length,
      tolerance: 'exact',
      explanation:
        a.length === b.length
          ? 'Same number of positioned points'
          : `Different point counts; exports may thin points or drop points without a position`,
    }),
  );
  const byTime = new Map(b.map((x) => [x.recordedAt, x]));
  let matched = 0;
  let maxDist = 0;
  for (const x of a) {
    const y = byTime.get(x.recordedAt);
    if (!y) continue;
    matched++;
    maxDist = Math.max(maxDist, haversine(x, y));
  }
  out.push(
    matched === 0
      ? notTested('format', 'positions at matching times', 'No points share a timestamp')
      : check({
          tier: 'format',
          metric: 'positions at matching times',
          status: maxDist <= TOLERANCES.positionMeters ? 'PASS' : 'FAIL',
          value: matched,
          difference: maxDist,
          tolerance: `≤ ${TOLERANCES.positionMeters} m`,
          explanation:
            maxDist <= TOLERANCES.positionMeters
              ? `${matched} shared timestamps; positions agree (largest difference in metres shown)`
              : `Positions at the same time differ by up to the distance shown (metres)`,
        }),
  );
  out.push(
    check({
      tier: 'format',
      metric: 'segments (pause structure)',
      status: fit.segments.length === other.segments.length ? 'PASS' : 'WARNING',
      value: fit.segments.length,
      reference: other.segments.length,
      tolerance: 'exact',
      explanation:
        fit.segments.length === other.segments.length
          ? 'Same number of timer-running segments'
          : `The ${label} has a different segment structure; GPX exports usually have one segment and TCX tracks may not mark pauses, so pause comparisons with this file are not reliable`,
    }),
  );
  if (other.format === 'gpx') out.push(notTested('format', 'laps', 'GPX files carry no laps'));
  else {
    const la = fit.lapStarts.length + 1;
    const lb = other.lapStarts.length + 1;
    out.push(
      check({
        tier: 'format',
        metric: 'lap count',
        status: la === lb ? 'PASS' : 'FAIL',
        value: la,
        reference: lb,
        tolerance: 'exact',
        explanation:
          la === lb ? 'Same number of laps' : `The FIT and ${label} have different lap counts`,
      }),
    );
    const n = Math.min(fit.lapStarts.length, other.lapStarts.length);
    if (n > 0) {
      let maxDiff = 0;
      for (let i = 0; i < n; i++)
        maxDiff = Math.max(maxDiff, Math.abs(fit.lapStarts[i]! - other.lapStarts[i]!));
      out.push(
        compareOffset(
          'format',
          'lap start times',
          maxDiff,
          TOLERANCES.boundaryMs,
          'FAIL',
          'Lap starts agree (largest difference shown)',
          'Lap starts differ (largest difference shown)',
        ),
      );
    }
  }
  out.push(...sensorComparison(fit, other, label));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pipeline: PACE's final activity from the FIT versus from the companion.

export function pipelineChecks(
  fit: ActivityMetrics,
  other: ActivityMetrics,
  label: string,
  sameSegments: boolean,
): Check[] {
  const outside = sameSegments ? 'FAIL' : 'WARNING';
  const why = sameSegments ? '' : ` (expected: the ${label} has no matching pause information)`;
  const out: Check[] = [
    compareNumbers({
      tier: 'pipeline',
      metric: 'distance',
      value: fit.distanceMeters,
      reference: other.distanceMeters,
      absolute: TOLERANCES.pipelineDistanceMeters,
      relative: TOLERANCES.pipelineDistanceRelative,
      outside,
      unit: 'm',
      same: 'PACE calculates the same distance from both files',
      differs: `PACE calculates different distances from the two files${why}`,
      missing: 'Distance unavailable',
    }),
    compareNumbers({
      tier: 'pipeline',
      metric: 'moving time',
      value: fit.movingSeconds,
      reference: other.movingSeconds,
      absolute: TOLERANCES.pipelineMovingSeconds,
      relative: TOLERANCES.pipelineMovingRelative,
      outside,
      unit: 's',
      same: 'Same moving time from both files',
      differs: `Different moving times${why}`,
      missing: 'Moving time unavailable',
    }),
    compareNumbers({
      tier: 'pipeline',
      metric: 'elapsed time',
      value: fit.elapsedSeconds,
      reference: other.elapsedSeconds,
      absolute: TOLERANCES.pipelineElapsedSeconds,
      outside: 'FAIL',
      unit: 's',
      same: 'Same elapsed time from both files',
      differs: 'Different elapsed times',
      missing: 'Elapsed time unavailable',
    }),
  ];
  if (label === 'GPX') out.push(notTested('pipeline', 'laps', 'GPX files carry no laps'));
  else
    out.push(
      check({
        tier: 'pipeline',
        metric: 'stored laps',
        status: lapCount(fit) === lapCount(other) ? 'PASS' : 'FAIL',
        value: lapCount(fit),
        reference: lapCount(other),
        tolerance: 'exact',
        explanation:
          lapCount(fit) === lapCount(other)
            ? 'Same number of stored laps'
            : 'Different numbers of stored laps',
      }),
    );
  if (!sameSegments)
    out.push(notTested('pipeline', 'pauses', `The ${label} has a different segment structure`));
  else {
    let maxDiff = 0;
    fit.pauses.forEach((p, i) => {
      const q = other.pauses[i]!;
      maxDiff = Math.max(maxDiff, Math.abs(p.resumedAt - p.pausedAt - (q.resumedAt - q.pausedAt)));
    });
    out.push(
      check({
        tier: 'pipeline',
        metric: 'pause durations',
        status: maxDiff <= TOLERANCES.boundaryMs ? 'PASS' : 'FAIL',
        value: fit.pauses.length,
        reference: other.pauses.length,
        difference: maxDiff / 1000,
        tolerance: `±${TOLERANCES.boundaryMs / 1000} s per pause`,
        explanation:
          maxDiff <= TOLERANCES.boundaryMs
            ? 'Same pauses with the same durations (largest difference shown, seconds)'
            : 'Pause durations differ (largest difference shown, seconds)',
      }),
    );
  }
  for (const type of SENSOR_KINDS) {
    const a = fit.sensors.filter((s) => s.type === type).length;
    const b = other.sensors.filter((s) => s.type === type).length;
    out.push(
      a === 0 && b === 0
        ? notTested(
            'pipeline',
            `stored ${SENSOR_LABEL[type]} samples`,
            'Neither activity has samples',
          )
        : check({
            tier: 'pipeline',
            metric: `stored ${SENSOR_LABEL[type]} samples`,
            status: a === b ? 'PASS' : 'WARNING',
            value: a,
            reference: b,
            tolerance: 'exact',
            explanation:
              a === b
                ? 'Same number of stored samples'
                : 'Different numbers of stored samples (see the format comparison for why)',
          }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Device: PACE's final activity versus the totals the device wrote. Informational.

const DEVICE_NOTE =
  'Device totals are not ground truth: devices may use wheel or foot-pod sensors, smoothing, or count time differently.';

export function deviceChecks(m: ActivityMetrics, totals: DeviceTotals | null): Check[] {
  if (!totals || totals.files !== 1 || totals.sessions.length === 0)
    return [
      notTested(
        'device',
        'device totals',
        !totals
          ? 'Device totals could not be read'
          : totals.files !== 1
            ? 'Chained FIT files: device totals are not attributed to activities'
            : 'The file has no session summary',
      ),
    ];
  const out: Check[] = [
    compareNumbers({
      tier: 'device',
      metric: 'distance vs device total',
      value: m.distanceMeters,
      reference: sessionTotal(totals, 'distanceMeters'),
      relative: TOLERANCES.deviceDistanceRelative,
      outside: 'WARNING',
      unit: 'm',
      same: 'PACE GPS distance agrees with the device total',
      differs: `PACE calculates distance from GPS points; the device total differs. ${DEVICE_NOTE}`,
      missing: 'The device wrote no total distance',
    }),
    compareNumbers({
      tier: 'device',
      metric: 'moving time vs device timer time',
      value: m.movingSeconds,
      reference: sessionTotal(totals, 'timerSeconds'),
      absolute: TOLERANCES.deviceTimerSeconds,
      relative: TOLERANCES.deviceTimerRelative,
      outside: 'WARNING',
      unit: 's',
      same: 'PACE moving time agrees with the device timer time',
      differs: `PACE moving time differs from the device timer time (the device may count stationary time while its timer ran). ${DEVICE_NOTE}`,
      missing: 'The device wrote no timer time',
    }),
    compareNumbers({
      tier: 'device',
      metric: 'elapsed time vs device total',
      value: m.elapsedSeconds,
      reference: sessionTotal(totals, 'elapsedSeconds'),
      absolute: TOLERANCES.deviceElapsedSeconds,
      outside: 'WARNING',
      unit: 's',
      same: 'PACE elapsed time agrees with the device',
      differs: `PACE elapsed time runs from the first to the last GPS point; the device's may include time before the first fix. ${DEVICE_NOTE}`,
      missing: 'The device wrote no elapsed time',
    }),
  ];
  const deviceStart = totals.sessions[0]!.startedAt;
  out.push(
    deviceStart == null
      ? notTested('device', 'start vs device start', 'The device wrote no start time')
      : compareOffset(
          'device',
          'start vs device start',
          m.startedAt - deviceStart,
          TOLERANCES.deviceElapsedSeconds * 1000,
          'WARNING',
          'PACE starts at the device start time',
          `PACE starts at the first GPS point, which differs from the device start. ${DEVICE_NOTE}`,
        ),
  );
  // A device starts a new lap at every leg change of a multisport activity; PACE records those
  // as legs. For the comparison both count as lap boundaries.
  const boundaries: number[] = [];
  for (const t of [
    ...m.laps.slice(1).map((l) => l.startedAt),
    ...m.legs.slice(1).map((l) => l.startedAt),
  ].sort((a, b) => a - b))
    if (!boundaries.some((b) => Math.abs(b - t) <= 1000)) boundaries.push(t);
  const paceLaps = boundaries.length + 1;
  const legNote =
    m.legs.length > 0 ? ' (leg changes count as lap boundaries, as on the device)' : '';
  const deviceLaps = sessionTotal(totals, 'numLaps') ?? (totals.laps.length || null);
  out.push(
    deviceLaps == null
      ? notTested('device', 'laps vs device', 'The device wrote no laps')
      : check({
          tier: 'device',
          metric: 'laps vs device',
          status: paceLaps === deviceLaps ? 'PASS' : 'WARNING',
          value: paceLaps,
          reference: deviceLaps,
          tolerance: 'exact',
          explanation:
            paceLaps === deviceLaps
              ? `Same number of laps as the device${legNote}${m.laps.length === 0 && m.legs.length === 0 ? NO_LAP_ROWS : ''}`
              : `PACE has a different number of laps${legNote}; for example laps without GPS points are not imported. ${DEVICE_NOTE}`,
        }),
  );
  const starts = totals.laps.map((l) => l.startedAt).filter((s): s is number => s != null);
  if (starts.length > 1) {
    const first = Math.min(...starts);
    const unmatched = starts
      .filter((s) => s !== first)
      .filter(
        (s) => !boundaries.some((b) => Math.abs(b - s) <= TOLERANCES.deviceLapStartSeconds * 1000),
      ).length;
    out.push(
      check({
        tier: 'device',
        metric: 'lap starts vs device',
        status: unmatched === 0 ? 'PASS' : 'WARNING',
        value: starts.length - 1 - unmatched,
        reference: starts.length - 1,
        tolerance: `±${TOLERANCES.deviceLapStartSeconds} s`,
        explanation:
          unmatched === 0
            ? `Every device lap after the first starts at a PACE lap boundary${legNote}`
            : `${unmatched} device lap start(s) have no PACE lap boundary at the same time${legNote}. ${DEVICE_NOTE}`,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Expectations from the manifest.

function hasGap(m: ActivityMetrics, type: SensorKind, gapSeconds: number): boolean {
  const s = m.sensors.filter((x) => x.type === type);
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!.recordedAt;
    const b = s[i]!.recordedAt;
    if (b - a < gapSeconds * 1000) continue;
    // A gap explained by a pause is not a dropout.
    if (m.pauses.some((p) => p.pausedAt <= a + 1000 && p.resumedAt >= b - 1000)) continue;
    return true;
  }
  return false;
}

export function expectationChecks(
  e: ActivityExpectations,
  outcome: Outcome,
  m: ActivityMetrics | null,
  warnings: readonly string[],
): Check[] {
  const out: Check[] = [];
  const given = Object.keys(e).length > 0;
  if (!given)
    return [notTested('expectation', 'expectations', 'No expectations given for this scenario')];
  if (e.outcome != null && e.outcome !== 'unknown')
    out.push(
      check({
        tier: 'expectation',
        metric: 'outcome',
        status: outcome === e.outcome ? 'PASS' : 'FAIL',
        value: outcome,
        reference: e.outcome,
        explanation:
          outcome === e.outcome ? 'Matches the expectation' : 'Does not match the expectation',
      }),
    );
  else if ('outcome' in e) out.push(notTested('expectation', 'outcome', 'Expected value unknown'));
  if (!m) {
    if (Object.keys(e).some((k) => k !== 'outcome' && k !== 'warningsInclude'))
      out.push(notTested('expectation', 'activity properties', 'Nothing was imported to compare'));
  } else {
    if ('sport' in e)
      out.push(
        e.sport == null || e.sport === 'unknown'
          ? notTested('expectation', 'sport', 'Expected value unknown')
          : check({
              tier: 'expectation',
              metric: 'sport',
              status: m.sport === e.sport ? 'PASS' : 'FAIL',
              value: m.sport,
              reference: e.sport,
              explanation:
                m.sport === e.sport ? 'Matches the expectation' : 'Does not match the expectation',
            }),
      );
    const nums: Array<[keyof ActivityExpectations, string, number, string]> = [
      ['points', 'GPS points', m.pointTimes.length, ''],
      ['pauses', 'pauses', m.pauses.length, ''],
      [
        'pauseSeconds',
        'total pause time',
        m.pauses.reduce((s, p) => s + (p.resumedAt - p.pausedAt) / 1000, 0),
        's',
      ],
      ['laps', 'laps', lapCount(m), ''],
      ['legs', 'legs', m.legs.length, ''],
      ['distanceMeters', 'distance', m.distanceMeters, 'm'],
      ['movingTimeSeconds', 'moving time', m.movingSeconds, 's'],
      ['elapsedTimeSeconds', 'elapsed time', m.elapsedSeconds, 's'],
    ];
    for (const [key, metric, actual, unit] of nums)
      if (key in e) out.push(expectNumber(metric, actual, e[key] as never, unit));
    if ('lapDistanceMeters' in e) {
      const full = m.laps.slice(0, -1);
      const each = full.map((l) =>
        expectNumber('lap distance', l.distanceMeters, e.lapDistanceMeters, 'm'),
      );
      if (each.length === 0 || each[0]!.status === 'NOT TESTED')
        out.push(
          notTested(
            'expectation',
            'lap distances',
            each.length === 0
              ? 'Fewer than two laps; no full lap to check'
              : 'Expected value unknown',
          ),
        );
      else {
        const ok = each.filter((c) => c.status === 'PASS').length;
        out.push(
          check({
            tier: 'expectation',
            metric: 'lap distances (all but the last lap)',
            status: ok === each.length ? 'PASS' : 'FAIL',
            value: `${ok}/${each.length} within`,
            reference: each[0]!.reference ?? null,
            explanation:
              ok === each.length
                ? 'Every full lap matches the expected distance'
                : `${each.length - ok} lap(s) outside the expected distance`,
          }),
        );
      }
    }
    for (const type of SENSOR_KINDS) {
      const stored = m.sensors.filter((s) => s.type === type);
      const label = SENSOR_LABEL[type];
      const se = e.sensors?.[type];
      if (e.sensors && type in e.sensors)
        out.push(
          se === 'present' || se === 'absent' || se === 'unknown' || se == null
            ? expectPresence(`${label} samples`, stored.length > 0, se)
            : expectNumber(`${label} sample count`, stored.length, se),
        );
      if (e.zeroValues && type in e.zeroValues)
        out.push(
          expectPresence(
            `${label} zero values kept`,
            stored.some((s) => s.value === 0),
            e.zeroValues[type],
          ),
        );
      if (e.sensorGaps && type in e.sensorGaps)
        out.push(
          expectPresence(
            `${label} dropouts (gaps ≥ ${e.gapSeconds ?? TOLERANCES.sensorGapSeconds} s) left as gaps`,
            hasGap(m, type, e.gapSeconds ?? TOLERANCES.sensorGapSeconds),
            e.sensorGaps[type],
          ),
        );
    }
  }
  for (const w of e.warningsInclude ?? []) {
    const found = warnings.some((x) => x.toLowerCase().includes(w.toLowerCase()));
    out.push(
      check({
        tier: 'expectation',
        metric: 'warning present',
        status: found ? 'PASS' : 'FAIL',
        value: found ? 'present' : 'absent',
        reference: 'present',
        explanation: found
          ? 'PACE reported the expected warning'
          : 'PACE did not report the expected warning',
      }),
    );
  }
  return out.length
    ? out
    : [notTested('expectation', 'expectations', 'All expected values unknown')];
}

// ---------------------------------------------------------------------------------------------

function summarize(t: ParsedTrack, m: ActivityMetrics | null): ActivitySummary {
  const pts = points(t);
  const sensors = { heart_rate: 0, cadence: 0, power: 0 } as Record<SensorKind, number>;
  for (const s of t.sensors) sensors[s.type]++;
  return {
    sport: m?.sport ?? t.sportType,
    points: pts.length,
    segments: t.segments.length,
    pauses: t.segments.length - 1,
    laps: m ? lapCount(m) : t.lapStarts.length + 1,
    legs: t.legStarts ? t.legStarts.length + 1 : null,
    durationMinutes: round((endOf(t) - startOf(t)) / 60000, 1),
    distanceKm: m ? round(m.distanceMeters / 1000, 2) : null,
    movingMinutes: m ? round(m.movingSeconds / 60, 1) : null,
    sensors,
  };
}

/** The TCX activity overlapping the FIT the most (a TCX file can hold several). */
function bestMatch(fit: ParsedTrack, candidates: ParsedTrack[]): ParsedTrack | null {
  let best: ParsedTrack | null = null;
  let bestOverlap = 0;
  for (const c of candidates) {
    const overlap = Math.min(endOf(fit), endOf(c)) - Math.max(startOf(fit), startOf(c));
    if (overlap > bestOverlap) {
      best = c;
      bestOverlap = overlap;
    }
  }
  return best;
}

function parseCompanion(c: CompanionInput): ParsedTrack[] {
  return c.format === 'gpx' ? [parseGpxTrack(c.text)] : parseTcx(c.text);
}

/** Validates one FIT scenario. A chained FIT with several activities yields `V1#1`, `V1#2`, … */
export async function validateActivity(
  input: ActivityInput,
  secrets: Secrets,
): Promise<ScenarioResult[]> {
  const companionLabels = input.companions.map((c) => c.format.toUpperCase());
  let tracks: ParsedTrack[];
  try {
    tracks = parseFit(input.fit);
  } catch (e) {
    if (!(e instanceof FitImportError || e instanceof FitDecodeError)) throw e;
    const reason = scrub((e as Error).message, secrets);
    const checks = [
      check({
        tier: 'integrity',
        metric: 'file accepted',
        status: input.expectValid
          ? 'FAIL'
          : input.expect.outcome === 'refused'
            ? 'PASS'
            : 'WARNING',
        value: 'refused',
        explanation: `PACE refused the file: ${reason}`,
      }),
      ...expectationChecks(input.expect, 'refused', null, []),
    ];
    return [
      {
        id: input.id,
        kind: 'activity',
        status: overallStatus(checks),
        outcome: 'refused',
        companions: companionLabels,
        summary: null,
        warnings: [],
        checks,
      },
    ];
  }

  let totals: DeviceTotals | null = null;
  try {
    totals = readDeviceTotals(input.fit, secrets);
  } catch {
    totals = null;
  }
  for (const t of tracks) {
    secrets.addText(t.name);
    secrets.addText(t.description);
  }

  // Companions are read once; a companion that cannot be read is reported, not fatal.
  const companionTracks: Array<
    { label: string; tracks: ParsedTrack[] } | { label: string; error: string }
  > = input.companions.map((c) => {
    try {
      const parsed = parseCompanion(c);
      for (const t of parsed) {
        secrets.addText(t.name);
        secrets.addText(t.description);
      }
      return { label: c.format.toUpperCase(), tracks: parsed };
    } catch (e) {
      return { label: c.format.toUpperCase(), error: scrub((e as Error).message, secrets) };
    }
  });

  const results: ScenarioResult[] = [];
  for (const [i, track] of tracks.entries()) {
    const id = tracks.length > 1 ? `${input.id}#${i + 1}` : input.id;
    const checks: Check[] = [];
    const imported = await importAndMeasure(track);
    let outcome: Outcome;
    let metrics: ActivityMetrics | null = null;
    let warnings: string[];
    if (imported.ok) {
      outcome = 'imported';
      metrics = imported.metrics;
      warnings = imported.warnings;
      checks.push(...integrityChecks(track, metrics));
    } else {
      outcome = imported.code === 'sport_required' ? 'needs_sport' : 'refused';
      warnings = track.warnings;
      checks.push(...trackInvariantsCheck(track));
      checks.push(
        check({
          tier: 'integrity',
          metric: 'file accepted',
          status: input.expectValid
            ? 'FAIL'
            : input.expect.outcome === outcome
              ? 'PASS'
              : 'WARNING',
          value: outcome,
          explanation: `PACE did not import the activity: ${scrub(imported.message, secrets)}`,
        }),
      );
    }

    checks.push(
      ...(metrics && tracks.length === 1
        ? deviceChecks(metrics, totals)
        : [
            notTested(
              'device',
              'device totals',
              metrics
                ? 'Chained FIT files: device totals are not attributed to activities'
                : 'Nothing was imported',
            ),
          ]),
    );

    if (companionTracks.length === 0)
      checks.push(
        notTested(
          'format',
          'companion comparison',
          'No GPX or TCX export of this activity was supplied',
        ),
      );
    for (const c of companionTracks) {
      if ('error' in c) {
        checks.push(
          check({
            tier: 'format',
            metric: `${c.label} companion readable`,
            status: 'WARNING',
            explanation: `The ${c.label} companion could not be read: ${c.error}`,
          }),
        );
        continue;
      }
      const other = bestMatch(track, c.tracks);
      if (!other) {
        checks.push(
          check({
            tier: 'format',
            metric: `${c.label} companion overlaps`,
            status: 'WARNING',
            explanation: `No activity in the ${c.label} companion overlaps this FIT activity in time`,
          }),
        );
        continue;
      }
      checks.push(
        ...formatChecks(track, other).map((x) => ({ ...x, metric: `${x.metric} (${c.label})` })),
      );
      const otherImport = await importAndMeasure(other);
      if (metrics && otherImport.ok)
        checks.push(
          ...pipelineChecks(
            metrics,
            otherImport.metrics,
            c.label,
            track.segments.length === other.segments.length,
          ).map((x) => ({ ...x, metric: `${x.metric} (${c.label})` })),
        );
      else
        checks.push(
          notTested(
            'pipeline',
            `PACE result comparison (${c.label})`,
            otherImport.ok
              ? 'The FIT was not imported'
              : `PACE did not import the ${c.label}: ${scrub(otherImport.message, secrets)}`,
          ),
        );
      if (metrics) checks.push(await duplicateCheck(track, other, c.label));
    }

    checks.push(...expectationChecks(input.expect, outcome, metrics, warnings));
    results.push({
      id,
      kind: 'activity',
      status: overallStatus(checks),
      outcome,
      companions: companionLabels,
      summary: summarize(track, metrics),
      warnings: warnings.map((w) => scrub(w, secrets)),
      checks,
    });
  }
  return results;
}

function trackInvariantsCheck(t: ParsedTrack): Check[] {
  const problems = trackInvariants(t);
  return [
    check({
      tier: 'integrity',
      metric: 'parsed track invariants',
      status: problems.length ? 'FAIL' : 'PASS',
      explanation: problems.length
        ? `Violated: ${problems.join('; ')}`
        : 'The parsed track is well-formed',
    }),
  ];
}

/** Importing the FIT and then its companion must keep one activity (the companion is a duplicate). */
async function duplicateCheck(fit: ParsedTrack, other: ParsedTrack, label: string): Promise<Check> {
  const ctx = await memoryDatabase();
  try {
    const first = await importAndMeasure(fit, ctx);
    const second = await importAndMeasure(other, ctx);
    const count = (await ctx.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM activities WHERE deleted_at IS NULL',
    ))!.n;
    const ok = first.ok && !second.ok && second.code === 'duplicate' && count === 1;
    return check({
      tier: 'pipeline',
      metric: `duplicate detection (FIT then ${label})`,
      status: ok ? 'PASS' : 'FAIL',
      value: count,
      reference: 1,
      tolerance: 'exact',
      explanation: ok
        ? `The ${label} export of the same activity is recognised as a duplicate; one activity is kept`
        : `Importing the FIT and its ${label} export did not leave exactly one activity`,
    });
  } finally {
    ctx.close();
  }
}
