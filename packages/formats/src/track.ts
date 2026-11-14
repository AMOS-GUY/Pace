import type { LocationSample, SportType } from '@pace/domain';
import { MAX_EPOCH_MS, MIN_EPOCH_MS } from '@pace/validation';

/**
 * Format-neutral result of parsing one activity from a file (GPX, TCX or FIT). Importers turn this
 * into an activity through the same session/GPS pipeline as live recordings.
 */
export type ImportedSensorType = 'heart_rate' | 'cadence' | 'power';

export interface ImportedSensorSample {
  type: ImportedSensorType;
  recordedAt: number;
  value: number;
  /**
   * Unit exactly as defined by the source format: `bpm`, `rpm` (cadence: revolutions — or, for
   * running, strides of one leg — per minute, as GPX TrackPointExtension, TCX and FIT define
   * it; FIT fractional cadence is kept, e.g. 85.5) or `W`.
   */
  unit: 'bpm' | 'rpm' | 'W';
}

export interface ParsedTrack {
  format: 'gpx' | 'tcx' | 'fit';
  name: string | null;
  description: string | null;
  /** Null when the file does not say which sport it is. */
  sportType: SportType | null;
  /** Timed, positioned points; each inner array is a recording segment (breaks = pauses). */
  segments: LocationSample[][];
  sensors: ImportedSensorSample[];
  /** Start times of laps after the first (TCX, FIT); applied as lap events during import. */
  lapStarts: number[];
  /**
   * Triathlon only (sportType 'triathlon', FIT multisport files): start times of T1, bike, T2
   * and run, in order. Leg changes are not pauses; they become leg events during import.
   */
  legStarts?: number[];
  /**
   * Human-readable notes: skipped points and every kind of information in the file that PACE
   * did not import. Nothing is dropped without a note here.
   */
  warnings: string[];
}

/** Heart rate, cadence and power plausibility bounds; values outside are skipped and counted. */
export const SENSOR_BOUNDS: Record<ImportedSensorType, { min: number; max: number }> = {
  heart_rate: { min: 20, max: 260 },
  cadence: { min: 0, max: 300 },
  power: { min: 0, max: 3000 },
};

export const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export type XmlNode = Record<string, unknown>;

export function text(v: unknown, max = 4000): string | null {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Imported fixes carry no accuracy; treat them as good-quality so the engine keeps them. */
export function importedSample(
  latitude: number,
  longitude: number,
  altitude: number | null,
  recordedAt: number,
): LocationSample {
  return {
    latitude,
    longitude,
    altitudeMeters: altitude,
    horizontalAccuracyMeters: 5,
    verticalAccuracyMeters: null,
    speedMps: null,
    courseDegrees: null,
    recordedAt,
    source: 'import',
  };
}

/**
 * A time PACE can store: finite and within 2000–2100, the range every stored activity time and
 * backup must satisfy (epochMsSchema). Anything else is an invalid time, skipped like a
 * missing one. One far-future point would otherwise drop every later point as out of order, and
 * make backups unrestorable.
 */
export function plausibleTime(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS;
}

export function validCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** Collects sensor values, counting implausible ones so they can be reported. */
export class SensorCollector {
  readonly samples: ImportedSensorSample[] = [];
  private readonly rejected: Record<ImportedSensorType, number> = {
    heart_rate: 0,
    cadence: 0,
    power: 0,
  };

  add(
    type: ImportedSensorType,
    raw: unknown,
    recordedAt: number,
    unit: ImportedSensorSample['unit'],
  ): void {
    if (raw == null || raw === '') return;
    const value = Number(raw);
    const b = SENSOR_BOUNDS[type];
    if (!Number.isFinite(value) || value < b.min || value > b.max) {
      this.rejected[type]++;
      return;
    }
    this.samples.push({ type, recordedAt, value, unit });
  }

  warnings(): string[] {
    const label = { heart_rate: 'heart-rate', cadence: 'cadence', power: 'power' } as const;
    return (Object.keys(this.rejected) as ImportedSensorType[])
      .filter((k) => this.rejected[k] > 0)
      .map((k) => `${this.rejected[k]} implausible ${label[k]} value(s) were skipped.`);
  }
}

/** "a, b and c" for warning messages. */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
