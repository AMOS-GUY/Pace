import type { LocationSample, SportType } from '@pace/domain';
import { IMPORT_LIMITS } from '@pace/validation';
import { XMLParser } from 'fast-xml-parser';
import {
  type ParsedTrack,
  SensorCollector,
  type XmlNode,
  asArray,
  importedSample,
  listOf,
  text,
  validCoordinate,
} from './track';

export class TcxImportError extends Error {}

const SPORTS: Record<string, SportType> = { running: 'running', biking: 'cycling' };

/**
 * Parses a Garmin Training Center (TCX v2) file. Every <Activity> becomes one ParsedTrack.
 *
 * Imported: sport (Running/Biking), notes, lap boundaries, tracks (gaps between <Track>
 * elements become pauses), position, altitude, time, heart rate, cadence (bike `Cadence`, run
 * `RunCadence`) and power (`Watts`). Everything else in the file — calories, device lap
 * summaries, device distance/speed, intensity, creator/device — is reported in `warnings`.
 * Distance and speed are always recomputed from GPS by the PACE engine.
 *
 * Defensive like the GPX parser: size and point limits, no DTDs/entities, every point validated.
 */
export function parseTcx(xml: string): ParsedTrack[] {
  if (xml.length > IMPORT_LIMITS.maxTcxBytes) throw new TcxImportError('TCX file is too large');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new TcxImportError('TCX files with DOCTYPE/ENTITY declarations are not supported');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: true, // safe: DTDs are refused above
    htmlEntities: false,
    parseTagValue: false,
    trimValues: true,
  });
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch {
    throw new TcxImportError('File is not valid XML');
  }
  const root = doc['TrainingCenterDatabase'] as XmlNode | undefined;
  if (!root) throw new TcxImportError('Not a TCX document');
  const activities = asArray(
    (root['Activities'] as XmlNode | undefined)?.['Activity'] as XmlNode | XmlNode[] | undefined,
  );
  if (activities.length === 0) {
    const other = ['Courses', 'Workouts'].filter((k) => root[k] != null);
    throw new TcxImportError(
      other.length
        ? `TCX contains ${listOf(other.map((o) => o.toLowerCase()))} but no recorded activities`
        : 'TCX contains no activities',
    );
  }
  let budget = IMPORT_LIMITS.maxGpxPoints;
  const out: ParsedTrack[] = [];
  for (const activity of activities) {
    const parsed = parseActivity(activity, budget);
    budget -= parsed.pointCount;
    out.push(parsed.track);
  }
  return out;
}

function parseActivity(
  activity: XmlNode,
  pointBudget: number,
): { track: ParsedTrack; pointCount: number } {
  const warnings: string[] = [];
  const ignored = new Set<string>();
  const sensors = new SensorCollector();
  const segments: LocationSample[][] = [];
  const lapStarts: number[] = [];
  let total = 0;
  let invalid = 0;
  let withoutPosition = 0;
  let outOfOrder = 0;
  let deviceDistance = false;
  let lastTime = -Infinity;

  const laps = asArray(activity['Lap'] as XmlNode | XmlNode[] | undefined);
  laps.forEach((lap, i) => {
    const start = Date.parse(String(lap['@_StartTime'] ?? ''));
    if (i > 0 && Number.isFinite(start)) lapStarts.push(start);
    if (lap['Calories'] != null) ignored.add('calories');
    if (
      lap['AverageHeartRateBpm'] != null ||
      lap['MaximumHeartRateBpm'] != null ||
      lap['MaximumSpeed'] != null ||
      lap['TotalTimeSeconds'] != null ||
      lap['Cadence'] != null
    )
      ignored.add('device lap summaries (lap figures are recalculated from the track)');
    if (lap['Intensity'] != null && String(lap['Intensity']) !== 'Active')
      ignored.add('lap intensity (rest/active)');
    if (lap['Notes'] != null) ignored.add('lap notes');
    if (lap['Extensions'] != null) ignored.add('lap extension data');

    // Garmin opens a new <Track> for every lap, so a lap boundary is NOT a pause: the lap's first
    // track continues the current segment. Only a further <Track> within a lap is a pause.
    asArray(lap['Track'] as XmlNode | XmlNode[] | undefined).forEach((trackNode, trackIndex) => {
      const continues = trackIndex === 0 && segments.length > 0;
      const seg: LocationSample[] = continues ? segments[segments.length - 1]! : [];
      for (const tp of asArray(trackNode['Trackpoint'] as XmlNode | XmlNode[] | undefined)) {
        if (++total > pointBudget) throw new TcxImportError('TCX has too many points');
        const time = Date.parse(String(tp['Time'] ?? ''));
        if (!Number.isFinite(time)) {
          invalid++;
          continue;
        }
        if (time <= lastTime) {
          outOfOrder++;
          continue;
        }
        lastTime = time;
        // Sensor data is kept for every timed point, including ones without a position.
        sensors.add(
          'heart_rate',
          (tp['HeartRateBpm'] as XmlNode | undefined)?.['Value'],
          time,
          'bpm',
        );
        sensors.add('cadence', tp['Cadence'], time, 'rpm');
        const tpx = (tp['Extensions'] as XmlNode | undefined)?.['TPX'] as XmlNode | undefined;
        if (tpx) {
          sensors.add('cadence', tpx['RunCadence'], time, 'rpm');
          sensors.add('power', tpx['Watts'], time, 'W');
          if (tpx['Speed'] != null) ignored.add('device speed');
        }
        if (tp['DistanceMeters'] != null) deviceDistance = true;
        if (tp['SensorState'] != null) ignored.add('sensor state');
        const pos = tp['Position'] as XmlNode | undefined;
        if (!pos) {
          withoutPosition++;
          continue;
        }
        const lat = Number(pos['LatitudeDegrees']);
        const lon = Number(pos['LongitudeDegrees']);
        if (!validCoordinate(lat, lon)) {
          invalid++;
          continue;
        }
        const altRaw = tp['AltitudeMeters'];
        const alt = altRaw == null ? null : Number(altRaw);
        seg.push(importedSample(lat, lon, alt != null && Number.isFinite(alt) ? alt : null, time));
      }
      if (!continues && seg.length > 0) segments.push(seg);
    });
  });

  const points = segments.reduce((n, s) => n + s.length, 0);
  if (points < 2) {
    throw new TcxImportError(
      withoutPosition > 0
        ? 'This TCX activity has no GPS positions (for example an indoor or treadmill session). Activities without a GPS track cannot be imported yet.'
        : 'TCX activity has fewer than two timed GPS points',
    );
  }
  if (invalid > 0)
    warnings.push(`${invalid} point(s) without valid coordinates or time were skipped.`);
  if (outOfOrder > 0) warnings.push(`${outOfOrder} out-of-order point(s) were skipped.`);
  if (withoutPosition > 0)
    warnings.push(
      `${withoutPosition} point(s) had no GPS position; their heart rate, cadence and power were kept.`,
    );
  warnings.push(...sensors.warnings());
  if (deviceDistance)
    warnings.push(
      'Distance recorded by the device was not used; PACE calculates distance from GPS.',
    );
  if (activity['Creator'] != null) ignored.add('device name');
  if (activity['Training'] != null) ignored.add('training plan data');
  if (activity['Extensions'] != null) ignored.add('activity extension data');
  if (ignored.size > 0) warnings.push(`Not imported: ${listOf([...ignored])}.`);

  const sportRaw = String(activity['@_Sport'] ?? '')
    .trim()
    .toLowerCase();
  const sportType = SPORTS[sportRaw] ?? null;
  const firstTime = segments[0]![0]!.recordedAt;
  return {
    pointCount: total,
    track: {
      format: 'tcx',
      name: null,
      description: text(activity['Notes']),
      sportType,
      segments,
      sensors: sensors.samples,
      lapStarts: lapStarts.filter((t) => t > firstTime).sort((a, b) => a - b),
      warnings,
    },
  };
}
