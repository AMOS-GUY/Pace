/**
 * The scenario manifest: a JSON file kept OUTSIDE the repository, next to the athlete's own
 * exports, saying which file is which scenario and what is expected of it. It lets expected
 * properties be checked without ever storing the recordings (or their names) in Git.
 *
 * Every expectation is optional. A missing value, `null` or `"unknown"` means "not known" and is
 * reported as NOT TESTED — never as a pass.
 */

/** An expected number: exact, approximate, a range, or unknown. */
export type NumberExpectation =
  | number
  | { equals: number }
  | { approx: number; tolerance: number }
  | { min?: number; max?: number }
  | 'unknown'
  | null;

/** For a sensor: whether samples exist. */
export type PresenceExpectation = 'present' | 'absent' | 'unknown' | null;

export type SensorKind = 'heart_rate' | 'cadence' | 'power';
export const SENSOR_KINDS: readonly SensorKind[] = ['heart_rate', 'cadence', 'power'];

export interface ActivityExpectations {
  /** What PACE should do with the file. */
  outcome?: 'imported' | 'refused' | 'needs_sport' | 'unknown' | null;
  sport?: string | null;
  points?: NumberExpectation;
  pauses?: NumberExpectation;
  /** Total time paused, in seconds. */
  pauseSeconds?: NumberExpectation;
  laps?: NumberExpectation;
  /** Distance of every lap except the last (e.g. 1000 ± 30 for 1 km auto-laps). */
  lapDistanceMeters?: NumberExpectation;
  /** Triathlon legs including transitions (5). */
  legs?: NumberExpectation;
  distanceMeters?: NumberExpectation;
  movingTimeSeconds?: NumberExpectation;
  elapsedTimeSeconds?: NumberExpectation;
  /** Whether each sensor has samples, or a number expectation for the sample count. */
  sensors?: Partial<Record<SensorKind, PresenceExpectation | NumberExpectation>>;
  /** Whether exact zero values exist (e.g. 0 rpm while coasting, 0 W with no pedalling). */
  zeroValues?: Partial<Record<SensorKind, PresenceExpectation>>;
  /** Whether there is a gap of at least `gapSeconds` (default 10) in a sensor (dropouts). */
  sensorGaps?: Partial<Record<SensorKind, PresenceExpectation>>;
  gapSeconds?: number;
  /** Substrings expected in PACE's import warnings (case-insensitive), e.g. "virtual". */
  warningsInclude?: string[];
}

export interface ArchiveExpectations {
  imported?: NumberExpectation;
  duplicates?: NumberExpectation;
  needsSport?: NumberExpectation;
  failed?: NumberExpectation;
  skipped?: NumberExpectation;
  /** Archive-level errors (damaged archive, global limit). */
  sourceErrors?: NumberExpectation;
}

export interface ActivityScenario {
  kind: 'activity';
  id: string;
  /** FIT file (or .fit.gz), relative to the manifest. */
  file: string;
  /** GPX/TCX exports of the same activity, relative to the manifest. */
  companions: string[];
  expect: ActivityExpectations;
}

export interface ArchiveScenario {
  kind: 'archive';
  id: string;
  /** ZIP (or single activity file), relative to the manifest. */
  archive: string;
  expect: ArchiveExpectations;
}

export type Scenario = ActivityScenario | ArchiveScenario;

export interface Manifest {
  version: 1;
  scenarios: Scenario[];
}

/** Scenario IDs are anonymous labels; they cannot carry names or dates. */
export const SCENARIO_ID = /^[A-Z]{1,3}\d{1,3}[a-z]?$/;

export class ManifestError extends Error {}

const ARCHIVE_KEYS = new Set([
  'imported',
  'duplicates',
  'needsSport',
  'failed',
  'skipped',
  'sourceErrors',
]);
const ACTIVITY_NUMBER_KEYS = new Set([
  'points',
  'pauses',
  'pauseSeconds',
  'laps',
  'lapDistanceMeters',
  'legs',
  'distanceMeters',
  'movingTimeSeconds',
  'elapsedTimeSeconds',
]);
const ACTIVITY_KEYS = new Set([
  ...ACTIVITY_NUMBER_KEYS,
  'outcome',
  'sport',
  'sensors',
  'zeroValues',
  'sensorGaps',
  'gapSeconds',
  'warningsInclude',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkNumber(v: unknown, where: string): void {
  if (v == null || v === 'unknown') return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (isObject(v)) {
    const keys = Object.keys(v).sort().join(',');
    const finite = Object.values(v).every((x) => typeof x === 'number' && Number.isFinite(x));
    if (finite && ['equals', 'approx,tolerance', 'min', 'max', 'max,min'].includes(keys)) {
      if (keys === 'approx,tolerance' && (v.tolerance as number) < 0)
        throw new ManifestError(`${where}: tolerance must not be negative`);
      return;
    }
  }
  throw new ManifestError(
    `${where}: expected a number, {"equals"}, {"approx","tolerance"}, {"min"/"max"}, "unknown" or null`,
  );
}

function checkPresence(v: unknown, where: string, allowNumber: boolean): void {
  if (v == null || v === 'present' || v === 'absent' || v === 'unknown') return;
  if (allowNumber) return checkNumber(v, where);
  throw new ManifestError(`${where}: expected "present", "absent", "unknown" or null`);
}

function relativePath(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new ManifestError(`${where}: expected a path`);
  if (/^([a-zA-Z]:)?[\\/]/.test(v) || v.split(/[\\/]+/).includes('..'))
    throw new ManifestError(`${where}: paths must be relative and stay inside the manifest folder`);
  return v;
}

function checkActivityExpectations(id: string, expect: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(expect)) {
    const where = `${id}.expect.${k}`;
    if (!ACTIVITY_KEYS.has(k)) throw new ManifestError(`${id}: unknown expectation "${k}"`);
    if (ACTIVITY_NUMBER_KEYS.has(k)) checkNumber(v, where);
    else if (k === 'outcome') {
      if (v != null && !['imported', 'refused', 'needs_sport', 'unknown'].includes(v as string))
        throw new ManifestError(`${where}: expected imported, refused, needs_sport or unknown`);
    } else if (k === 'sport') {
      if (v != null && typeof v !== 'string') throw new ManifestError(`${where}: expected a sport`);
    } else if (k === 'gapSeconds') {
      if (typeof v !== 'number' || !(v > 0))
        throw new ManifestError(`${where}: expected seconds > 0`);
    } else if (k === 'warningsInclude') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
        throw new ManifestError(`${where}: expected a list of strings`);
    } else {
      if (!isObject(v)) throw new ManifestError(`${where}: expected an object of sensors`);
      for (const [sensor, e] of Object.entries(v)) {
        if (!SENSOR_KINDS.includes(sensor as SensorKind))
          throw new ManifestError(`${where}: unknown sensor "${sensor}"`);
        checkPresence(e, `${where}.${sensor}`, k === 'sensors');
      }
    }
  }
}

/**
 * Parses and validates a manifest. Error messages name the scenario ID and the key, never the
 * file paths in the manifest.
 */
export function parseManifest(json: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ManifestError('The manifest is not valid JSON');
  }
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.scenarios))
    throw new ManifestError('The manifest needs "version": 1 and a "scenarios" array');
  const ids = new Set<string>();
  const scenarios = raw.scenarios.map((s: unknown, i: number): Scenario => {
    if (!isObject(s)) throw new ManifestError(`scenarios[${i}]: expected an object`);
    const id = s.id;
    if (typeof id !== 'string' || !SCENARIO_ID.test(id))
      throw new ManifestError(
        `scenarios[${i}]: "id" must be an anonymous label such as V1, V4b or A2`,
      );
    if (ids.has(id)) throw new ManifestError(`${id}: duplicate scenario ID`);
    ids.add(id);
    const expect = s.expect ?? {};
    if (!isObject(expect)) throw new ManifestError(`${id}: "expect" must be an object`);
    if (('file' in s ? 1 : 0) + ('archive' in s ? 1 : 0) !== 1)
      throw new ManifestError(`${id}: give exactly one of "file" or "archive"`);

    if ('archive' in s) {
      if ('companion' in s)
        throw new ManifestError(`${id}: archive scenarios do not take a "companion"`);
      for (const [k, v] of Object.entries(expect)) {
        if (!ARCHIVE_KEYS.has(k))
          throw new ManifestError(`${id}: unknown archive expectation "${k}"`);
        checkNumber(v, `${id}.expect.${k}`);
      }
      return {
        kind: 'archive',
        id,
        archive: relativePath(s.archive, `${id}.archive`),
        expect: expect as ArchiveExpectations,
      };
    }

    checkActivityExpectations(id, expect);
    const companions =
      s.companion == null
        ? []
        : (Array.isArray(s.companion) ? s.companion : [s.companion]).map((c: unknown, j: number) =>
            relativePath(c, `${id}.companion[${j}]`),
          );
    return {
      kind: 'activity',
      id,
      file: relativePath(s.file, `${id}.file`),
      companions,
      expect: expect as ActivityExpectations,
    };
  });
  return { version: 1, scenarios };
}
