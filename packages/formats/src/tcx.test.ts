import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { TcxImportError, parseGpx, parseGpxTrack, parseTcx, toGpx } from './index';
import { garminTcx, stravaGpx, withSensors } from './test-fixtures/device-files';

const T = Date.UTC(2026, 9, 4, 6, 30);
const lap1 = straightTrack({
  speedMps: 3.2,
  durationSeconds: 300,
  startTime: T,
  altitude: (t) => 12 + t / 60,
});
const lap2 = straightTrack({
  speedMps: 3.4,
  durationSeconds: 300,
  startTime: T + 301_000,
  start: { latitude: lap1[lap1.length - 1]!.latitude, longitude: lap1[lap1.length - 1]!.longitude },
});
// Second lap continues after a 60 s device pause (a new <Track> in the same lap).
const lap2b = straightTrack({
  speedMps: 3.4,
  durationSeconds: 120,
  startTime: T + 662_000,
  start: { latitude: lap2[lap2.length - 1]!.latitude, longitude: lap2[lap2.length - 1]!.longitude },
});

describe('TCX import', () => {
  const xml = garminTcx({
    sport: 'Running',
    notes: 'Tempo &amp; strides',
    runCadence: true,
    laps: [
      { tracks: [withSensors(lap1, { hr: true, cadence: 88 })] },
      {
        tracks: [
          withSensors(lap2, { hr: true, cadence: 90 }),
          withSensors(lap2b, { hr: true, cadence: 91 }),
        ],
      },
    ],
  });

  it('reads sport, notes, tracks, laps and every sensor channel', () => {
    const [t, ...rest] = parseTcx(xml);
    expect(rest).toHaveLength(0);
    expect(t!.format).toBe('tcx');
    expect(t!.sportType).toBe('running');
    expect(t!.description).toBe('Tempo & strides');
    // A lap boundary is not a pause (Garmin opens a <Track> per lap), but the second <Track>
    // inside lap 2 is: two recording segments.
    expect(t!.segments.map((s) => s.length)).toEqual([lap1.length + lap2.length, lap2b.length]);
    expect(t!.lapStarts).toEqual([lap2[0]!.recordedAt]);
    const p = t!.segments[0]![0]!;
    expect(p.latitude).toBeCloseTo(lap1[0]!.latitude, 6);
    expect(p.altitudeMeters).toBeCloseTo(12, 1);
    expect(p.recordedAt).toBe(T);
    const count = (type: string) => t!.sensors.filter((s) => s.type === type).length;
    const points = lap1.length + lap2.length + lap2b.length;
    expect(count('heart_rate')).toBe(points);
    expect(count('cadence')).toBe(points);
    expect(t!.sensors.find((s) => s.type === 'cadence')).toEqual({
      type: 'cadence',
      recordedAt: T,
      value: 88,
      unit: 'rpm',
    });
  });

  it('reports everything it did not import instead of dropping it silently', () => {
    const [t] = parseTcx(xml);
    const all = t!.warnings.join(' ');
    expect(all).toContain('Distance recorded by the device was not used');
    expect(all).toContain('calories');
    expect(all).toContain('device lap summaries');
    expect(all).toContain('device speed');
    expect(all).toContain('device name');
  });

  it('reads cycling cadence and power', () => {
    const ride = straightTrack({ speedMps: 8, durationSeconds: 120, startTime: T });
    const [t] = parseTcx(
      garminTcx({
        sport: 'Biking',
        laps: [{ tracks: [withSensors(ride, { cadence: 85, watts: 210 })] }],
      }),
    );
    expect(t!.sportType).toBe('cycling');
    expect(t!.sensors.filter((s) => s.type === 'power')).toHaveLength(ride.length);
    expect(t!.sensors.find((s) => s.type === 'power')!.unit).toBe('W');
    expect(t!.sensors.find((s) => s.type === 'cadence')!.value).toBe(85);
  });

  it('returns one track per activity and leaves the sport open for "Other"', () => {
    const other = straightTrack({ speedMps: 1.4, durationSeconds: 60, startTime: T + 86_400_000 });
    const tracks = parseTcx(
      garminTcx({
        sport: 'Running',
        laps: [{ tracks: [withSensors(lap1)] }],
        extraActivities: [{ sport: 'Other', laps: [{ tracks: [withSensors(other)] }] }],
      }),
    );
    expect(tracks.map((t) => t.sportType)).toEqual(['running', null]);
  });

  it('keeps sensor data of points without a position and explains indoor files', () => {
    const pts = withSensors(lap1, { hr: true }).map((p, i) =>
      i % 10 === 5 ? { ...p, noPosition: true } : p,
    );
    const [t] = parseTcx(garminTcx({ sport: 'Running', laps: [{ tracks: [pts] }] }));
    const missing = pts.filter((p) => p.noPosition).length;
    expect(t!.segments[0]).toHaveLength(lap1.length - missing);
    expect(t!.sensors.filter((s) => s.type === 'heart_rate')).toHaveLength(lap1.length);
    expect(t!.warnings.join(' ')).toContain(`${missing} point(s) had no GPS position`);

    const indoor = withSensors(lap1, { hr: true }).map((p) => ({ ...p, noPosition: true }));
    expect(() => parseTcx(garminTcx({ sport: 'Running', laps: [{ tracks: [indoor] }] }))).toThrow(
      /no GPS positions/,
    );
  });

  it('skips implausible sensor values and counts them', () => {
    const pts = withSensors(lap1.slice(0, 20), { hr: true });
    pts[3] = { ...pts[3]!, hr: 400 };
    const [t] = parseTcx(garminTcx({ sport: 'Running', laps: [{ tracks: [pts] }] }));
    expect(t!.sensors.filter((s) => s.type === 'heart_rate')).toHaveLength(19);
    expect(t!.warnings).toContain('1 implausible heart-rate value(s) were skipped.');
  });

  it('rejects unsafe, empty and non-activity files', () => {
    expect(() => parseTcx('<!DOCTYPE x [<!ENTITY a "a">]><TrainingCenterDatabase/>')).toThrow(
      TcxImportError,
    );
    expect(() => parseTcx('<gpx></gpx>')).toThrow('Not a TCX document');
    expect(() => parseTcx('not xml <')).toThrow(TcxImportError);
    expect(() =>
      parseTcx('<TrainingCenterDatabase><Courses><Course/></Courses></TrainingCenterDatabase>'),
    ).toThrow('courses but no recorded activities');
    expect(() =>
      parseTcx('<TrainingCenterDatabase><Activities></Activities></TrainingCenterDatabase>'),
    ).toThrow('no activities');
  });
});

describe('GPX sensors and unsupported data', () => {
  it('reads cadence and power and lists what was not imported', () => {
    const ride = straightTrack({ speedMps: 8, durationSeconds: 60, startTime: T });
    const r = parseGpx(
      stravaGpx({
        name: 'Lunch Ride',
        type: 'cycling',
        points: withSensors(ride, { hr: true, cadence: 88, watts: 230 }),
        waypoints: 2,
        temperature: true,
      }),
    );
    const n = (type: string) => r.sensors.filter((s) => s.type === type).length;
    expect([n('heart_rate'), n('cadence'), n('power')]).toEqual([
      ride.length,
      ride.length,
      ride.length,
    ]);
    expect(r.heartRate).toHaveLength(ride.length);
    expect(r.warnings).toEqual([
      'Not imported: 2 waypoint(s).',
      'Not imported: point data temperature.',
    ]);
  });

  it('round-trips cadence through PACE GPX export', () => {
    const run = straightTrack({ speedMps: 3, durationSeconds: 30, startTime: T });
    const xml = toGpx({
      name: 'Run',
      sportType: 'running',
      startedAt: T,
      segments: [run],
      cadence: run.map((s) => ({ recordedAt: s.recordedAt, rpm: 86 })),
    });
    expect(xml).toContain('<gpxtpx:cad>86</gpxtpx:cad>');
    const t = parseGpxTrack(xml);
    expect(t.sensors.filter((s) => s.type === 'cadence')).toHaveLength(run.length);
    expect(t.warnings).toEqual([]);
  });
});
