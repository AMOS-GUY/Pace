import type { LocationSample, SportType } from '@pace/domain';
import { IMPORT_LIMITS } from '@pace/validation';
import { XMLParser } from 'fast-xml-parser';
import {
  type ImportedSensorSample,
  type ParsedTrack,
  SensorCollector,
  listOf,
  plausibleTime,
} from './track';

export interface GpxExportInput {
  name: string;
  description?: string | null;
  sportType: SportType;
  startedAt: number;
  /** Track segments of raw samples (one segment per recording segment). */
  segments: ReadonlyArray<
    ReadonlyArray<Pick<LocationSample, 'latitude' | 'longitude' | 'altitudeMeters' | 'recordedAt'>>
  >;
  /** Optional per-time heart-rate samples (bpm) embedded via the Garmin TrackPointExtension. */
  heartRate?: ReadonlyArray<{ recordedAt: number; bpm: number }>;
  /** Optional cadence samples (rpm, as TrackPointExtension defines `cad`). */
  cadence?: ReadonlyArray<{ recordedAt: number; rpm: number }>;
  /**
   * Optional power samples (W), written as Garmin's PowerExtension v1 `PowerInWatts` on the
   * track point with exactly the same time. A sample is never copied to other points or
   * rounded; a sample with no track point at its time (for example while GPS had no fix) cannot
   * be represented in GPX and is left out.
   */
  power?: ReadonlyArray<{ recordedAt: number; watts: number }>;
  creator?: string;
}

const GPX_TYPE: Record<SportType, string> = {
  running: 'running',
  cycling: 'cycling',
  walking: 'walking',
  hiking: 'hiking',
  swimming: 'swimming',
  triathlon: 'triathlon',
};

export function escapeXml(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Strip characters that are illegal in XML 1.0.
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

const iso = (ms: number): string => new Date(ms).toISOString();
const coord = (n: number): string => n.toFixed(7);

/** Serialises an activity to GPX 1.1 (readable by Strava, Garmin Connect, etc.). */
export function toGpx(input: GpxExportInput): string {
  const pointTimes = input.segments.flatMap((seg) => seg.map((p) => p.recordedAt));
  const hrOn = placeOnPoints(
    pointTimes,
    (input.heartRate ?? []).map((h) => ({ at: h.recordedAt, v: h.bpm })),
  );
  const cadOn = placeOnPoints(
    pointTimes,
    (input.cadence ?? []).map((c) => ({ at: c.recordedAt, v: c.rpm })),
  );
  const powerAt = new Map<number, number>();
  for (const p of input.power ?? [])
    if (Number.isFinite(p.watts) && !powerAt.has(p.recordedAt)) powerAt.set(p.recordedAt, p.watts);
  // The power namespace is declared only when power is written, so files without power are
  // byte-for-byte what earlier versions wrote.
  const powerNs =
    powerAt.size > 0 ? 'xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1" ' : '';
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(input.creator ?? 'PACE')}" xmlns="http://www.topografix.com/GPX/1/1" ` +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" ' +
      powerNs +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    `  <metadata><name>${escapeXml(input.name)}</name><time>${iso(input.startedAt)}</time></metadata>`,
    '  <trk>',
    `    <name>${escapeXml(input.name)}</name>`,
  ];
  if (input.description) lines.push(`    <desc>${escapeXml(input.description)}</desc>`);
  lines.push(`    <type>${GPX_TYPE[input.sportType]}</type>`);
  for (const seg of input.segments) {
    if (seg.length === 0) continue;
    lines.push('    <trkseg>');
    for (const p of seg) {
      const parts = [`      <trkpt lat="${coord(p.latitude)}" lon="${coord(p.longitude)}">`];
      if (p.altitudeMeters != null && Number.isFinite(p.altitudeMeters))
        parts.push(`<ele>${p.altitudeMeters.toFixed(1)}</ele>`);
      parts.push(`<time>${iso(p.recordedAt)}</time>`);
      const bpm = hrOn.get(p.recordedAt) ?? null;
      const cad = cadOn.get(p.recordedAt) ?? null;
      const watts = powerAt.get(p.recordedAt);
      if (bpm != null || cad != null || watts != null) {
        const powerTag = watts != null ? `<gpxpx:PowerInWatts>${watts}</gpxpx:PowerInWatts>` : '';
        const hrTag = bpm != null ? `<gpxtpx:hr>${bpm}</gpxtpx:hr>` : '';
        const cadTag = cad != null ? `<gpxtpx:cad>${cad}</gpxtpx:cad>` : '';
        const tpx =
          bpm != null || cad != null
            ? `<gpxtpx:TrackPointExtension>${hrTag}${cadTag}</gpxtpx:TrackPointExtension>`
            : '';
        parts.push(`<extensions>${powerTag}${tpx}</extensions>`);
      }
      parts.push('</trkpt>');
      lines.push(parts.join(''));
    }
    lines.push('    </trkseg>');
  }
  lines.push('  </trk>', '</gpx>', '');
  return lines.join('\n');
}

/** How far (ms) a heart-rate or cadence sample may move to reach a track point. */
export const GPX_SENSOR_MAX_SHIFT_MS = 2000;

/**
 * Places the samples of one sensor on track points for GPX, which can hold a value only on a
 * point (R6, docs/EXPORT_FORMATS.md).
 *
 * Each sample goes on at most one point: the closest one in time, within
 * GPX_SENSOR_MAX_SHIFT_MS. Each point carries at most one sample. Exact-time matches are placed
 * first, then closer before farther, then earlier before later, so the result is deterministic.
 * A sample with no free point in range is left out. Nothing is copied onto other points or
 * invented. Values are rounded because TrackPointExtension `hr` and `cad` hold whole numbers.
 *
 * Earlier versions gave every point the last sample of the preceding 5 s, which copied a sparse
 * sample onto up to five points and filled short dropouts with invented values.
 */
function placeOnPoints(
  pointTimes: readonly number[],
  values: ReadonlyArray<{ at: number; v: number }>,
): Map<number, number> {
  const times = [...new Set(pointTimes)].sort((a, b) => a - b);
  const samples = values
    .filter((s) => Number.isFinite(s.v) && Number.isFinite(s.at))
    .sort((a, b) => a.at - b.at);
  const edges: Array<{ sample: number; point: number; dist: number }> = [];
  samples.forEach((s, i) => {
    // The points just before and after the sample (binary search).
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < s.at) lo = mid + 1;
      else hi = mid;
    }
    for (const k of [lo - 1, lo]) {
      const t = times[k];
      if (t == null) continue;
      const dist = Math.abs(t - s.at);
      if (dist <= GPX_SENSOR_MAX_SHIFT_MS) edges.push({ sample: i, point: t, dist });
    }
  });
  edges.sort((a, b) => a.dist - b.dist || a.sample - b.sample || a.point - b.point);
  const placed = new Map<number, number>();
  const used = new Set<number>();
  for (const e of edges) {
    if (used.has(e.sample) || placed.has(e.point)) continue;
    used.add(e.sample);
    placed.set(e.point, Math.round(samples[e.sample]!.v));
  }
  return placed;
}

export interface GpxImportResult {
  name: string | null;
  description: string | null;
  sportType: SportType | null;
  segments: LocationSample[][];
  heartRate: Array<{ recordedAt: number; bpm: number }>;
  /** Heart rate, cadence and power read from the file. */
  sensors: ImportedSensorSample[];
  warnings: string[];
}

/** Extension elements PACE reads; anything else in <extensions> is reported as not imported. */
const KNOWN_POINT_EXTENSIONS = new Set(['TrackPointExtension', 'power', 'PowerInWatts']);
const KNOWN_TPX = new Set(['hr', 'cad']);

export class GpxImportError extends Error {}

const TYPE_MAP: Record<string, SportType> = {
  running: 'running',
  run: 'running',
  '9': 'running',
  trail_running: 'running',
  cycling: 'cycling',
  biking: 'cycling',
  ride: 'cycling',
  '1': 'cycling',
  road_biking: 'cycling',
  mountain_biking: 'cycling',
  walking: 'walking',
  walk: 'walking',
  '10': 'walking',
  hiking: 'hiking',
  hike: 'hiking',
  '4': 'hiking',
  swimming: 'swimming',
  swim: 'swimming',
  open_water_swimming: 'swimming',
};

/** GPX `<type>` values that mean a multisport activity (PACE writes `triathlon`). */
const MULTISPORT_TYPES = new Set(['triathlon', 'multisport', 'multi_sport', 'duathlon']);

const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Parses GPX 1.0/1.1 tracks (and routes without time are rejected — an activity needs timestamps).
 * Defensive: enforces size and point limits, rejects DOCTYPE/entities, validates every point.
 */
export function parseGpx(xml: string): GpxImportResult {
  if (xml.length > IMPORT_LIMITS.maxGpxBytes) throw new GpxImportError('GPX file is too large');
  // Entity expansion attacks ("billion laughs") are prevented by refusing DTDs outright.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new GpxImportError('GPX files with DOCTYPE/ENTITY declarations are not supported');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    // Safe because DTDs are refused above: only the five predefined XML entities and
    // numeric character references can be decoded.
    processEntities: true,
    htmlEntities: false,
    parseTagValue: false,
    trimValues: true,
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new GpxImportError('File is not valid XML');
  }
  const gpx = doc['gpx'] as Record<string, unknown> | undefined;
  if (!gpx) throw new GpxImportError('Not a GPX document');

  const warnings: string[] = [];
  const trks = asArray(
    gpx['trk'] as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  if (trks.length === 0) throw new GpxImportError('GPX contains no tracks');
  if (trks.length > 1) warnings.push('Only the first track was imported.');
  const trk = trks[0]!;
  const segments: LocationSample[][] = [];
  const heartRate: Array<{ recordedAt: number; bpm: number }> = [];
  const sensors = new SensorCollector();
  const ignored = new Set<string>();
  let total = 0;
  let invalid = 0;
  let lastTime = -Infinity;
  let outOfOrder = 0;

  for (const seg of asArray(
    trk['trkseg'] as Record<string, unknown> | Record<string, unknown>[] | undefined,
  )) {
    const out: LocationSample[] = [];
    for (const pt of asArray(
      seg['trkpt'] as Record<string, unknown> | Record<string, unknown>[] | undefined,
    )) {
      if (++total > IMPORT_LIMITS.maxGpxPoints) throw new GpxImportError('GPX has too many points');
      const lat = Number(pt['@_lat']);
      const lon = Number(pt['@_lon']);
      const time = Date.parse(String(pt['time'] ?? ''));
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180 ||
        !plausibleTime(time)
      ) {
        invalid++;
        continue;
      }
      if (time <= lastTime) {
        outOfOrder++;
        continue;
      }
      lastTime = time;
      const eleRaw = pt['ele'];
      const ele = eleRaw == null ? null : Number(eleRaw);
      out.push({
        latitude: lat,
        longitude: lon,
        altitudeMeters: ele != null && Number.isFinite(ele) ? ele : null,
        // GPX carries no accuracy; treat imported fixes as good-quality to avoid rejecting them.
        horizontalAccuracyMeters: 5,
        verticalAccuracyMeters: null,
        speedMps: null,
        courseDegrees: null,
        recordedAt: time,
        source: 'import',
      });
      const ext = pt['extensions'] as Record<string, unknown> | undefined;
      const tpx = ext?.['TrackPointExtension'] as Record<string, unknown> | undefined;
      const hr = Number(tpx?.['hr']);
      if (Number.isFinite(hr) && hr > 20 && hr < 260) heartRate.push({ recordedAt: time, bpm: hr });
      sensors.add('heart_rate', tpx?.['hr'], time, 'bpm');
      sensors.add('cadence', tpx?.['cad'], time, 'rpm');
      sensors.add('power', ext?.['power'] ?? ext?.['PowerInWatts'], time, 'W');
      if (ext && typeof ext === 'object') {
        for (const k of Object.keys(ext)) if (!KNOWN_POINT_EXTENSIONS.has(k)) ignored.add(k);
        if (tpx && typeof tpx === 'object')
          for (const k of Object.keys(tpx))
            if (!KNOWN_TPX.has(k)) ignored.add(k === 'atemp' ? 'temperature' : k);
      }
    }
    if (out.length > 0) segments.push(out);
  }
  if (invalid > 0)
    warnings.push(`${invalid} point(s) without valid coordinates or time were skipped.`);
  if (outOfOrder > 0) warnings.push(`${outOfOrder} out-of-order point(s) were skipped.`);
  if (segments.reduce((s, x) => s + x.length, 0) < 2)
    throw new GpxImportError('GPX track has fewer than two timed points');
  warnings.push(...sensors.warnings());
  const wpt = asArray(gpx['wpt'] as unknown[] | undefined).length;
  const rte = asArray(gpx['rte'] as unknown[] | undefined).length;
  if (wpt > 0) warnings.push(`Not imported: ${wpt} waypoint(s).`);
  if (rte > 0) warnings.push(`Not imported: ${rte} planned route(s).`);
  if (ignored.size > 0) warnings.push(`Not imported: point data ${listOf([...ignored].sort())}.`);

  const typeRaw = String(trk['type'] ?? '')
    .trim()
    .toLowerCase();
  const text = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 4000) : null;
  // GPX has no way to hold multisport legs (R3). Say so, rather than letting a triathlon (for
  // example PACE's own GPX export of one) look like a complete single-sport file.
  if (MULTISPORT_TYPES.has(typeRaw))
    warnings.push(
      "This file is marked as a triathlon or multisport activity. GPX cannot hold the swim, transition, bike and run legs, so it can only be imported as a single sport. PACE's portable export (data.json) keeps the legs.",
    );
  return {
    name:
      text(trk['name']) ?? text((gpx['metadata'] as Record<string, unknown> | undefined)?.['name']),
    description: text(trk['desc']),
    sportType: TYPE_MAP[typeRaw] ?? null,
    segments,
    heartRate,
    sensors: sensors.samples,
    warnings,
  };
}

/** GPX parsed into the format-neutral shape used by the importer. */
export function parseGpxTrack(xml: string): ParsedTrack {
  const r = parseGpx(xml);
  return {
    format: 'gpx',
    name: r.name,
    description: r.description,
    sportType: r.sportType,
    segments: r.segments,
    sensors: r.sensors,
    lapStarts: [],
    warnings: r.warnings,
  };
}
