/**
 * TEST FIXTURES ONLY. Builders for activity files shaped like real exports from other platforms:
 * Garmin Connect TCX (TrainingCenterDatabase v2, ActivityExtension v2 `TPX`, laps with calories
 * and device summaries, `Creator` device block) and Strava/Garmin GPX (TrackPointExtension v1
 * with hr/cad/atemp, power extension, waypoints). Coordinates come from the deterministic
 * synthetic tracks used across the test suite; they never reach user-visible data.
 */
import type { LocationSample } from '@pace/domain';

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

export interface DeviceTrackPoint {
  sample: LocationSample;
  hr?: number;
  cadence?: number;
  watts?: number;
  /** Omit the position (as an indoor/paused device does) while keeping time and sensors. */
  noPosition?: boolean;
}

export interface TcxLapInput {
  /** Each inner array is one <Track> (a gap between tracks is a device pause). */
  tracks: DeviceTrackPoint[][];
}

export function garminTcx(options: {
  sport: 'Running' | 'Biking' | 'Other';
  laps: TcxLapInput[];
  notes?: string;
  /** Additional <Activity> elements (each a list of laps) in the same file. */
  extraActivities?: Array<{ sport: 'Running' | 'Biking' | 'Other'; laps: TcxLapInput[] }>;
  runCadence?: boolean;
}): string {
  const activity = (sport: string, laps: TcxLapInput[], notes?: string): string => {
    const first = laps[0]!.tracks[0]![0]!.sample.recordedAt;
    const lapXml = laps
      .map((lap) => {
        const pts = lap.tracks.flat();
        const start = pts[0]!.sample.recordedAt;
        const end = pts[pts.length - 1]!.sample.recordedAt;
        const tracks = lap.tracks
          .map(
            (t) =>
              `<Track>${t
                .map((p, i) => {
                  const pos = p.noPosition
                    ? ''
                    : `<Position><LatitudeDegrees>${p.sample.latitude.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p.sample.longitude.toFixed(7)}</LongitudeDegrees></Position>`;
                  const alt =
                    p.sample.altitudeMeters != null
                      ? `<AltitudeMeters>${p.sample.altitudeMeters.toFixed(1)}</AltitudeMeters>`
                      : '';
                  const hr =
                    p.hr != null ? `<HeartRateBpm><Value>${p.hr}</Value></HeartRateBpm>` : '';
                  const cad =
                    p.cadence != null && !options.runCadence
                      ? `<Cadence>${p.cadence}</Cadence>`
                      : '';
                  const tpx =
                    p.watts != null || (p.cadence != null && options.runCadence)
                      ? `<Extensions><ns3:TPX><ns3:Speed>3.1</ns3:Speed>${options.runCadence && p.cadence != null ? `<ns3:RunCadence>${p.cadence}</ns3:RunCadence>` : ''}${p.watts != null ? `<ns3:Watts>${p.watts}</ns3:Watts>` : ''}</ns3:TPX></Extensions>`
                      : '';
                  return `<Trackpoint><Time>${iso(p.sample.recordedAt)}</Time>${pos}${alt}<DistanceMeters>${(i * 3).toFixed(1)}</DistanceMeters>${hr}${cad}${tpx}</Trackpoint>`;
                })
                .join('')}</Track>`,
          )
          .join('');
        return `<Lap StartTime="${iso(start)}"><TotalTimeSeconds>${((end - start) / 1000).toFixed(1)}</TotalTimeSeconds><DistanceMeters>1000.0</DistanceMeters><MaximumSpeed>4.2</MaximumSpeed><Calories>87</Calories><AverageHeartRateBpm><Value>148</Value></AverageHeartRateBpm><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>${tracks}</Lap>`;
      })
      .join('');
    return `<Activity Sport="${sport}"><Id>${iso(first)}</Id>${lapXml}${notes ? `<Notes>${notes}</Notes>` : ''}<Creator xsi:type="Device_t"><Name>Forerunner 965</Name><UnitId>3456789012</UnitId><ProductID>4315</ProductID></Creator></Activity>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd" xmlns:ns5="http://www.garmin.com/xmlschemas/ActivityGoals/v1" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:ns2="http://www.garmin.com/xmlschemas/UserProfile/v2" xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Activities>${activity(options.sport, options.laps, options.notes)}${(options.extraActivities ?? []).map((a) => activity(a.sport, a.laps)).join('')}</Activities>
  <Author xsi:type="Application_t"><Name>Connect Api</Name></Author>
</TrainingCenterDatabase>
`;
}

export function stravaGpx(options: {
  name: string;
  type: string;
  points: DeviceTrackPoint[];
  waypoints?: number;
  temperature?: boolean;
}): string {
  const wpts = Array.from(
    { length: options.waypoints ?? 0 },
    (_, i) => `<wpt lat="1.29" lon="103.85"><name>Water ${i + 1}</name></wpt>`,
  ).join('');
  const pts = options.points
    .map((p) => {
      const tpx =
        p.hr != null || p.cadence != null || options.temperature
          ? `<gpxtpx:TrackPointExtension>${options.temperature ? '<gpxtpx:atemp>27</gpxtpx:atemp>' : ''}${p.hr != null ? `<gpxtpx:hr>${p.hr}</gpxtpx:hr>` : ''}${p.cadence != null ? `<gpxtpx:cad>${p.cadence}</gpxtpx:cad>` : ''}</gpxtpx:TrackPointExtension>`
          : '';
      const power = p.watts != null ? `<power>${p.watts}</power>` : '';
      const ext = tpx || power ? `<extensions>${power}${tpx}</extensions>` : '';
      const ele =
        p.sample.altitudeMeters != null ? `<ele>${p.sample.altitudeMeters.toFixed(1)}</ele>` : '';
      return `<trkpt lat="${p.sample.latitude.toFixed(7)}" lon="${p.sample.longitude.toFixed(7)}">${ele}<time>${iso(p.sample.recordedAt)}</time>${ext}</trkpt>`;
    })
    .join('\n   ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <metadata><time>${iso(options.points[0]!.sample.recordedAt)}</time></metadata>${wpts}
 <trk>
  <name>${options.name}</name>
  <type>${options.type}</type>
  <trkseg>
   ${pts}
  </trkseg>
 </trk>
</gpx>
`;
}

/** Attach plausible, deterministic sensor values to samples. */
export function withSensors(
  samples: readonly LocationSample[],
  o: { hr?: boolean; cadence?: number; watts?: number } = {},
): DeviceTrackPoint[] {
  return samples.map((sample, i) => ({
    sample,
    ...(o.hr ? { hr: 130 + (i % 20) } : {}),
    ...(o.cadence != null ? { cadence: o.cadence } : {}),
    ...(o.watts != null ? { watts: o.watts + (i % 10) } : {}),
  }));
}
