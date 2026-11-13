import type { LocationSample, SportType } from '@pace/domain';
import { IMPORT_LIMITS } from '@pace/validation';
import {
  FIT_MIN_UTC_TIMESTAMP,
  FitDecodeError,
  type FitFileInfo,
  type FitMessage,
  type FitValue,
  decodeFit,
  fitTimeToMs,
} from './fit-decoder';
import {
  type ImportedSensorSample,
  type ParsedTrack,
  SensorCollector,
  importedSample,
  listOf,
  validCoordinate,
} from './track';

export class FitImportError extends Error {}

/*
 * The few FIT message and field numbers PACE interprets, written by hand from the public FIT
 * profile documentation (no generated profile tables; see docs/DECISIONS.md D22). Anything not
 * listed here is skipped and reported.
 */
const MSG = {
  fileId: 0,
  sport: 12,
  session: 18,
  lap: 19,
  record: 20,
  event: 21,
  activity: 34,
  fileCreator: 49,
  fieldDescription: 206,
  developerDataId: 207,
} as const;
const WANTED = new Set<number>([
  MSG.fileId,
  MSG.sport,
  MSG.session,
  MSG.lap,
  MSG.record,
  MSG.event,
  MSG.fieldDescription,
]);

const REC = {
  lat: 0,
  lon: 1,
  altitude: 2,
  heartRate: 3,
  cadence: 4,
  distance: 5,
  power: 7,
  fractionalCadence: 53,
  enhancedAltitude: 78,
} as const;
const IMPORTED_RECORD_FIELDS = new Set<number>([253, 0, 1, 2, 3, 4, 7, 53, 78]);

/** Record fields PACE does not import, by name, so the report can say what was left out. */
const RECORD_FIELD_NAMES: Record<number, string> = {
  6: 'device speed',
  73: 'device speed',
  9: 'grade',
  13: 'temperature',
  29: 'accumulated power',
  30: 'left/right power balance',
  31: 'GPS accuracy',
  32: 'vertical speed',
  33: 'calories',
  39: 'vertical oscillation',
  40: 'ground contact time percentage',
  41: 'ground contact time',
  83: 'vertical ratio',
  84: 'ground contact time balance',
  85: 'step length',
};

/** Messages PACE does not import, by name. */
const MESSAGE_NAMES: Record<number, string> = {
  2: 'device settings',
  3: 'user profile',
  7: 'training zone settings',
  8: 'heart-rate zones',
  9: 'power zones',
  23: 'device and sensor details',
  26: 'workout',
  27: 'workout steps',
  31: 'course',
  32: 'course points',
  78: 'heart-rate variability (HRV)',
  101: 'pool swim lengths',
  132: 'heart rate stored by a chest strap while swimming (HRM-Swim/HRM-Tri)',
};
/** Structural messages that carry no training data. */
const STRUCTURAL = new Set<number>([MSG.activity, MSG.fileCreator, MSG.developerDataId]);

const SPORTS: Record<number, SportType> = {
  1: 'running',
  2: 'cycling',
  5: 'swimming',
  11: 'walking',
  17: 'hiking',
};
const SPORT_NAMES: Record<number, string> = {
  1: 'run',
  2: 'bike',
  3: 'transition',
  4: 'fitness equipment',
  5: 'swim',
  10: 'training',
  11: 'walk',
  12: 'cross-country skiing',
  13: 'alpine skiing',
  15: 'rowing',
  17: 'hike',
};
const TRANSITION = 3;
const MULTISPORT = 18;
const SUB_LAP_SWIMMING = 17;
const SUB_VIRTUAL = 58;
/** Swim, T1, bike, T2, run: the only multisport sequence PACE records. */
const TRIATHLON = [5, TRANSITION, 2, TRANSITION, 1];

const FILE_TYPES: Record<number, string> = {
  2: 'device settings',
  5: 'a workout',
  6: 'a course (a planned route)',
  9: 'weight data',
  15: 'daily activity monitoring data',
  28: 'daily activity monitoring data',
  32: 'daily activity monitoring data',
  34: 'a segment',
};
const ACTIVITY_FILE = 4;

const TIMER_EVENT = 0;
const TIMER_START = 0;
const TIMER_STOPS = new Set([1, 4, 8, 9]);

const num = (v: FitValue | undefined): number | null => (typeof v === 'number' ? v : null);
const degrees = (semicircles: number): number => (semicircles * 180) / 2 ** 31;

/** Developer field names come from the file: shown to the athlete, so keep them plain. */
function cleanName(v: FitValue | undefined): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, 40) : null;
}

interface Point {
  t: number;
  sample: LocationSample;
}

interface Session {
  start: number | null;
  sport: number | null;
  subSport: number | null;
}

/** Collects the messages of one (chained) FIT file and turns them into a ParsedTrack. */
class FileBuilder {
  fileType: number | null = null;
  device = false;
  readonly points: Point[] = [];
  readonly timers: Array<{ t: number; running: boolean }> = [];
  readonly lapStarts: number[] = [];
  readonly sessions: Session[] = [];
  sportMessage: Session | null = null;
  readonly sensors = new SensorCollector();
  readonly ignored = new Set<string>();
  readonly otherRecordFields = new Set<number>();
  readonly developerNames = new Map<string, string>();
  readonly developerSeen = new Set<string>();
  records = 0;
  invalid = 0;
  withoutPosition = 0;
  outOfOrder = 0;
  sameTime = 0;
  /** Records sharing a time with the previous record that added a missing position or value. */
  merged = 0;
  /** Values at a repeated time that differ from the first record's (the first is kept). */
  conflicting = 0;
  private readonly sensorsAtLastTime = new Map<ImportedSensorSample['type'], number>();
  private pointAtLastTime = false;
  relativeTime = 0;
  noTime = 0;
  deviceDistance = false;
  private lastTime = -Infinity;
  private lastLapEnd: number | null = null;

  constructor(private readonly budget: { points: number }) {}

  add(m: FitMessage): void {
    const f = m.fields;
    switch (m.global) {
      case MSG.fileId:
        this.fileType = num(f.get(0));
        if (f.has(1) || f.has(2) || f.has(8)) this.device = true;
        break;
      case MSG.sport:
        this.sportMessage = { start: null, sport: num(f.get(0)), subSport: num(f.get(1)) };
        break;
      case MSG.session: {
        const start = num(f.get(2));
        this.sessions.push({
          start: start != null && start >= FIT_MIN_UTC_TIMESTAMP ? fitTimeToMs(start) : null,
          sport: num(f.get(5)),
          subSport: num(f.get(6)),
        });
        if (f.has(11)) this.ignored.add('calories');
        this.ignored.add(
          'device lap and session summaries (figures are recalculated from the track)',
        );
        break;
      }
      case MSG.lap: {
        const start = num(f.get(2));
        const end = m.timestamp;
        const s =
          start != null && start >= FIT_MIN_UTC_TIMESTAMP ? fitTimeToMs(start) : this.lastLapEnd;
        if (s != null) this.lapStarts.push(s);
        if (end != null && end >= FIT_MIN_UTC_TIMESTAMP) this.lastLapEnd = fitTimeToMs(end);
        if (f.has(11)) this.ignored.add('calories');
        this.ignored.add(
          'device lap and session summaries (figures are recalculated from the track)',
        );
        break;
      }
      case MSG.event: {
        if (num(f.get(0)) !== TIMER_EVENT || m.timestamp == null) break;
        if (m.timestamp < FIT_MIN_UTC_TIMESTAMP) break;
        const type = num(f.get(1));
        if (type === TIMER_START) this.timers.push({ t: fitTimeToMs(m.timestamp), running: true });
        else if (type != null && TIMER_STOPS.has(type))
          this.timers.push({ t: fitTimeToMs(m.timestamp), running: false });
        break;
      }
      case MSG.fieldDescription: {
        const idx = num(f.get(0));
        const field = num(f.get(1));
        const name = cleanName(f.get(3));
        if (idx != null && field != null && name) this.developerNames.set(`${idx}:${field}`, name);
        break;
      }
      case MSG.record:
        this.record(m);
        break;
    }
  }

  private record(m: FitMessage): void {
    const f = m.fields;
    this.records++;
    for (const d of m.developerFields)
      this.developerSeen.add(`${d.developerDataIndex}:${d.fieldNumber}`);
    for (const k of f.keys()) {
      if (IMPORTED_RECORD_FIELDS.has(k)) continue;
      if (k === REC.distance) this.deviceDistance = true;
      else this.otherRecordFields.add(k);
    }
    const ts = m.timestamp;
    if (ts == null) {
      this.noTime++;
      return;
    }
    if (ts < FIT_MIN_UTC_TIMESTAMP) {
      this.relativeTime++;
      return;
    }
    const t = fitTimeToMs(ts);
    if (t < this.lastTime) {
      this.outOfOrder++;
      return;
    }
    // A record repeating the previous record's time is merged into it (R4): it adds only what is
    // still missing at that time (a position, or a sensor without a value yet) and never replaces
    // or duplicates a value. A repeat that adds nothing is reported as skipped, as before.
    const repeat = t === this.lastTime;
    if (!repeat) {
      this.lastTime = t;
      this.sensorsAtLastTime.clear();
      this.pointAtLastTime = false;
    }
    let added = false;

    // Sensor values are kept exactly as recorded, for every timed record, and never filled in.
    added = this.addSensor('heart_rate', num(f.get(REC.heartRate)), t, 'bpm', repeat) || added;
    const cadence = num(f.get(REC.cadence));
    if (cadence != null) {
      const frac = num(f.get(REC.fractionalCadence));
      added =
        this.addSensor(
          'cadence',
          frac != null ? cadence + frac / 128 : cadence,
          t,
          'rpm',
          repeat,
        ) || added;
    }
    added = this.addSensor('power', num(f.get(REC.power)), t, 'W', repeat) || added;

    const position = (): boolean => {
      const latRaw = num(f.get(REC.lat));
      const lonRaw = num(f.get(REC.lon));
      if (latRaw == null || lonRaw == null) {
        if (!repeat) this.withoutPosition++;
        return false;
      }
      if (this.pointAtLastTime) return false; // the first position at this time is kept
      const lat = degrees(latRaw);
      const lon = degrees(lonRaw);
      if (!validCoordinate(lat, lon)) {
        this.invalid++;
        return false;
      }
      if (--this.budget.points < 0) throw new FitImportError('FIT file has too many points');
      const altRaw = num(f.get(REC.enhancedAltitude)) ?? num(f.get(REC.altitude));
      const alt = altRaw == null ? null : altRaw / 5 - 500;
      this.points.push({ t, sample: importedSample(lat, lon, alt, t) });
      this.pointAtLastTime = true;
      return true;
    };
    added = position() || added;
    if (repeat) {
      if (added) this.merged++;
      else this.sameTime++;
    }
  }

  /**
   * Adds one sensor value. For a record repeating the previous time, only a sensor that has no
   * value at that time yet is added; a different value for one that has is counted as a
   * conflict and left out (the first value wins). Returns whether a value was added.
   */
  private addSensor(
    type: ImportedSensorSample['type'],
    raw: number | null,
    t: number,
    unit: ImportedSensorSample['unit'],
    repeat: boolean,
  ): boolean {
    if (raw == null) return false;
    if (repeat && this.sensorsAtLastTime.has(type)) {
      if (this.sensorsAtLastTime.get(type) !== raw) this.conflicting++;
      return false;
    }
    const before = this.sensors.samples.length;
    this.sensors.add(type, raw, t, unit);
    if (this.sensors.samples.length === before) return false;
    this.sensorsAtLastTime.set(type, raw);
    return true;
  }

  /** Recording intervals from timer events; without any, the whole file is one interval. */
  private intervals(): Array<[number, number]> {
    if (this.timers.length === 0) return [[-Infinity, Infinity]];
    const out: Array<[number, number]> = [];
    let open: number | null = null;
    this.timers.forEach((e, i) => {
      if (e.running) open ??= e.t;
      else if (open != null) {
        out.push([open, e.t]);
        open = null;
      } else if (i === 0) out.push([-Infinity, e.t]); // stop without a start: running from the beginning
    });
    if (open != null) out.push([open, Infinity]);
    return out;
  }

  build(info: FitFileInfo): ParsedTrack {
    const warnings: string[] = [];

    // GPS points into recording segments: a gap between timer intervals is a pause. Laps and
    // multisport leg changes do not split segments.
    const intervals = this.intervals();
    const segments: LocationSample[][] = intervals.map(() => []);
    let whileStopped = 0;
    let k = 0;
    for (const p of this.points) {
      while (k < intervals.length && p.t > intervals[k]![1]) k++;
      if (k < intervals.length && p.t >= intervals[k]![0]) segments[k]!.push(p.sample);
      else whileStopped++;
    }
    const kept = segments.filter((s) => s.length > 0);
    const pointCount = kept.reduce((n, s) => n + s.length, 0);
    if (pointCount < 2) {
      if (this.relativeTime > 0 && this.points.length === 0)
        throw new FitImportError(
          "This FIT file has no real date and time (the device's clock was not set), so it cannot be placed in your history.",
        );
      throw new FitImportError(
        this.withoutPosition > 0
          ? 'This FIT activity has no GPS positions (for example an indoor, treadmill, trainer or pool session). Activities without a GPS track cannot be imported yet.'
          : 'FIT activity has fewer than two timed GPS points',
      );
    }
    const first = kept[0]![0]!.recordedAt;

    // Sport, and triathlon legs for multisport files.
    const sessions = [...this.sessions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    let sportType: SportType | null = null;
    let legStarts: number[] | undefined;
    const boundaries: number[] = [];
    const sessionSports = sessions.map((s) => s.sport);
    const multisport =
      sessions.length > 1 &&
      (new Set(sessionSports).size > 1 || this.sportMessage?.sport === MULTISPORT);
    if (multisport) {
      const names = sessionSports.map((s) =>
        s == null ? 'unknown' : (SPORT_NAMES[s] ?? `sport ${s}`),
      );
      if (
        sessionSports.length !== TRIATHLON.length ||
        sessionSports.some((s, i) => s !== TRIATHLON[i])
      )
        throw new FitImportError(
          `Multisport activities other than a swim–bike–run triathlon with two transitions cannot be imported yet (this file: ${names.join(', ')}).`,
        );
      if (sessions[0]!.subSport === SUB_LAP_SWIMMING)
        throw new FitImportError(
          'Triathlons with a pool swim cannot be imported yet: the swim has no GPS track.',
        );
      const starts = sessions.slice(1).map((s) => s.start);
      if (starts.some((s, i) => s == null || (i > 0 && s <= starts[i - 1]!)))
        throw new FitImportError(
          'The triathlon legs in this FIT file have missing or out-of-order start times.',
        );
      legStarts = starts as number[];
      boundaries.push(...legStarts);
      sportType = 'triathlon';
    } else {
      const s = sessions[0] ?? this.sportMessage;
      const sport = s?.sport ?? this.sportMessage?.sport ?? null;
      const sub = s?.subSport ?? this.sportMessage?.subSport ?? null;
      sportType = sport != null ? (SPORTS[sport] ?? null) : null;
      if (sport != null && sportType == null && sport !== 0 && sport !== MULTISPORT)
        warnings.push(
          `The file's sport (${SPORT_NAMES[sport] ?? `FIT sport ${sport}`}) is not one PACE records; choose a sport to import it.`,
        );
      if (sub === SUB_VIRTUAL)
        warnings.push(
          'This is a virtual activity (for example an indoor app ride); its GPS positions are virtual, not where you were.',
        );
      // Further sessions of the same sport (a device split) start new laps, not pauses.
      boundaries.push(...sessions.slice(1).flatMap((x) => (x.start != null ? [x.start] : [])));
    }

    // Laps: the first lap of the activity and of each leg is not a lap change.
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1000;
    const lapStarts = [
      ...new Set(
        [...this.lapStarts, ...(legStarts ? [] : boundaries)].filter(
          (t) => t > first && !(legStarts ?? []).some((b) => near(t, b)) && !near(t, first),
        ),
      ),
    ].sort((a, b) => a - b);

    if (this.invalid > 0)
      warnings.push(`${this.invalid} point(s) with invalid coordinates were skipped.`);
    if (this.noTime > 0) warnings.push(`${this.noTime} record(s) without a time were skipped.`);
    if (this.relativeTime > 0)
      warnings.push(
        `${this.relativeTime} record(s) with device-relative time (clock not set) were skipped.`,
      );
    if (this.outOfOrder > 0)
      warnings.push(`${this.outOfOrder} out-of-order record(s) were skipped.`);
    if (this.merged > 0)
      warnings.push(
        `${this.merged} record(s) sharing a time with the previous record were merged into it: only values missing at that time were added.`,
      );
    if (this.conflicting > 0)
      warnings.push(
        `${this.conflicting} value(s) conflicting with the first record at the same time were not imported (the first value is kept).`,
      );
    if (this.sameTime > 0)
      warnings.push(
        `${this.sameTime} record(s) repeating the previous record's time were skipped.`,
      );
    if (this.withoutPosition > 0)
      warnings.push(
        `${this.withoutPosition} record(s) had no GPS position; their heart rate, cadence and power were kept.`,
      );
    if (whileStopped > 0)
      warnings.push(
        `${whileStopped} GPS point(s) recorded while the timer was stopped are not counted in distance or time.`,
      );
    warnings.push(...this.sensors.warnings());
    if (this.deviceDistance)
      warnings.push(
        'Distance recorded by the device was not used; PACE calculates distance from GPS.',
      );

    const ignored = new Set(this.ignored);
    if (this.device) ignored.add('device name');
    let otherFields = 0;
    for (const n of [...this.otherRecordFields].sort((a, b) => a - b)) {
      const name = RECORD_FIELD_NAMES[n];
      if (name) ignored.add(name);
      else otherFields++;
    }
    if (otherFields > 0) ignored.add(`${otherFields} other kind(s) of per-second device data`);
    let otherMessages = 0;
    for (const g of [...info.messageCounts.keys()].sort((a, b) => a - b)) {
      if (WANTED.has(g) || STRUCTURAL.has(g)) continue;
      const name = MESSAGE_NAMES[g];
      if (name) ignored.add(name);
      else otherMessages++;
    }
    if (otherMessages > 0) ignored.add(`${otherMessages} other kind(s) of device data`);
    if (this.developerSeen.size > 0) {
      const names = [...this.developerSeen]
        .sort()
        .map((key) => this.developerNames.get(key) ?? `unnamed field ${key.split(':')[1]}`);
      const shown = names.slice(0, 8);
      if (names.length > shown.length) shown.push(`${names.length - shown.length} more`);
      ignored.add(`data from apps or sensors on the device (developer fields: ${listOf(shown)})`);
    }
    if (ignored.size > 0) warnings.push(`Not imported: ${listOf([...ignored])}.`);
    if (info.uninterpretableFields > 0)
      warnings.push(
        `${info.uninterpretableFields} field value(s) could not be interpreted and were skipped.`,
      );

    return {
      format: 'fit',
      name: null,
      description: null,
      sportType,
      segments: kept,
      sensors: this.sensors.samples,
      lapStarts,
      ...(legStarts ? { legStarts } : {}),
      warnings,
    };
  }
}

/**
 * Parses a FIT file into one ParsedTrack per recorded activity (several when FIT files are
 * chained). Imported: GPS position, altitude, time, heart rate, cadence (with fractional
 * cadence), power, timer pauses, laps, sport, and swim–T1–bike–T2–run triathlon legs. Everything
 * else is listed in `warnings`. Distance and speed are always recomputed from GPS.
 *
 * A damaged, truncated or malformed file is refused as a whole; nothing from it is imported.
 */
export function parseFit(bytes: Uint8Array): ParsedTrack[] {
  if (bytes.length > IMPORT_LIMITS.maxFitBytes) throw new FitImportError('FIT file is too large');
  const budget = { points: IMPORT_LIMITS.maxGpxPoints };
  const builders: FileBuilder[] = [];
  let infos: FitFileInfo[];
  try {
    infos = decodeFit(bytes, {
      wants: (g) => WANTED.has(g),
      onMessage: (m) => (builders[m.fileIndex] ??= new FileBuilder(budget)).add(m),
      limits: { maxBytes: IMPORT_LIMITS.maxFitBytes, maxMessages: IMPORT_LIMITS.maxFitMessages },
    });
  } catch (e) {
    if (e instanceof FitDecodeError) throw new FitImportError(e.message);
    throw e;
  }
  const tracks: ParsedTrack[] = [];
  const notActivities: string[] = [];
  infos.forEach((info, i) => {
    const b = builders[i] ?? new FileBuilder(budget);
    // Files without a file_id are accepted when they contain records.
    if (b.fileType != null && b.fileType !== ACTIVITY_FILE) {
      notActivities.push(FILE_TYPES[b.fileType] ?? 'not a recorded activity');
      return;
    }
    if (b.fileType == null && b.records === 0) {
      notActivities.push('not a recorded activity');
      return;
    }
    tracks.push(b.build(info));
  });
  if (tracks.length === 0) {
    const kinds = [...new Set(notActivities)].filter((k) => k !== 'not a recorded activity');
    throw new FitImportError(
      kinds.length > 0
        ? `This FIT file contains ${listOf(kinds)}, not a recorded activity.`
        : 'This FIT file is not a recorded activity.',
    );
  }
  if (notActivities.length > 0)
    tracks[0]!.warnings.push(
      `${notActivities.length} other FIT file(s) in the same file (${listOf([...new Set(notActivities)])}) were not imported.`,
    );
  return tracks;
}
