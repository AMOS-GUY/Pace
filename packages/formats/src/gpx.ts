import type { LocationSample, SportType } from '@pace/domain';
import { IMPORT_LIMITS } from '@pace/validation';
import { XMLParser } from 'fast-xml-parser';
import { type ImportedSensorSample, type ParsedTrack, SensorCollector, listOf } from './track';

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
  const hrAt = nearest((input.heartRate ?? []).map((h) => ({ at: h.recordedAt, v: h.bpm })));
  const cadAt = nearest((input.cadence ?? []).map((c) => ({ at: c.recordedAt, v: c.rpm })));
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(input.creator ?? 'PACE')}" xmlns="http://www.topografix.com/GPX/1/1" ` +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" ' +
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
      const bpm = hrAt(p.recordedAt);
      const cad = cadAt(p.recordedAt);
      if (bpm != null || cad != null) {
        const hrTag = bpm != null ? `<gpxtpx:hr>${bpm}</gpxtpx:hr>` : '';
        const cadTag = cad != null ? `<gpxtpx:cad>${cad}</gpxtpx:cad>` : '';
        parts.push(
          `<extensions><gpxtpx:TrackPointExtension>${hrTag}${cadTag}</gpxtpx:TrackPointExtension></extensions>`,
        );
      }
      parts.push('</trkpt>');
      lines.push(parts.join(''));
    }
    lines.push('    </trkseg>');
  }
  lines.push('  </trk>', '</gpx>', '');
  return lines.join('\n');
}

/** Sensor readings apply to track points up to 5 s after them (monotonic queries). */
function nearest(values: ReadonlyArray<{ at: number; v: number }>): (t: number) => number | null {
  const sorted = [...values].sort((a, b) => a.at - b.at);
  let i = 0;
  return (t) => {
    if (sorted.length === 0) return null;
    while (i + 1 < sorted.length && sorted[i + 1]!.at <= t) i++;
    const h = sorted[i]!;
    return Math.abs(h.at - t) <= 5000 ? Math.round(h.v) : null;
  };
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
        !Number.isFinite(time)
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
