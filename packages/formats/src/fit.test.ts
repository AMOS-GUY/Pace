import type { LocationSample } from '@pace/domain';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { FitImportError, type ParsedTrack, parseFit, parseTcx } from './index';
import { garminTcx, withSensors } from './test-fixtures/device-files';
import {
  BT,
  FitWriter,
  SPORT,
  SUB_SPORT,
  concatBytes,
  fitActivity,
  fitFile,
  fitPoints,
  fitSeconds,
  semicircles,
} from './test-fixtures/fit-encoder';

const T = Date.UTC(2026, 9, 4, 6, 30);
const lap1 = straightTrack({
  speedMps: 3.2,
  durationSeconds: 300,
  startTime: T,
  altitude: (t) => 12 + t / 60,
});
const after = (s: LocationSample[]) => ({
  latitude: s[s.length - 1]!.latitude,
  longitude: s[s.length - 1]!.longitude,
});
const lap2 = straightTrack({
  speedMps: 3.4,
  durationSeconds: 300,
  startTime: T + 301_000,
  start: after(lap1),
});
// Second lap continues after a 60 s timer pause.
const lap2b = straightTrack({
  speedMps: 3.4,
  durationSeconds: 120,
  startTime: T + 662_000,
  start: after(lap2),
});

const run = (): Uint8Array =>
  fitActivity({
    sessions: [
      {
        sport: SPORT.running,
        laps: [
          [fitPoints(lap1, { hr: true, cadence: 88, watts: 250 })],
          [
            fitPoints(lap2, { hr: true, cadence: 90, watts: 260 }),
            fitPoints(lap2b, { hr: true, cadence: 91 }),
          ],
        ],
      },
    ],
  });

const only = (bytes: Uint8Array): ParsedTrack => {
  const tracks = parseFit(bytes);
  expect(tracks).toHaveLength(1);
  return tracks[0]!;
};

describe('FIT import: activity structure', () => {
  it('reads sport, laps and pauses; a lap boundary is not a pause', () => {
    const t = only(run());
    expect(t.format).toBe('fit');
    expect(t.sportType).toBe('running');
    expect(t.segments.map((s) => s.length)).toEqual([lap1.length + lap2.length, lap2b.length]);
    expect(t.lapStarts).toEqual([lap2[0]!.recordedAt]);
    expect(t.legStarts).toBeUndefined();
    const p = t.segments[0]![0]!;
    expect(p.recordedAt).toBe(T);
    expect(p.latitude).toBeCloseTo(lap1[0]!.latitude, 6);
    expect(p.longitude).toBeCloseTo(lap1[0]!.longitude, 6);
    expect(p.altitudeMeters).toBeCloseTo(12, 1);
    expect(p.source).toBe('import');
  });

  it('gives the same track, laps and sensor data as the equivalent TCX file', () => {
    const tcx = garminTcx({
      sport: 'Running',
      runCadence: true,
      laps: [
        { tracks: [withSensors(lap1, { hr: true, cadence: 88, watts: 250 })] },
        {
          tracks: [
            withSensors(lap2, { hr: true, cadence: 90, watts: 260 }),
            withSensors(lap2b, { hr: true, cadence: 91 }),
          ],
        },
      ],
    });
    const fromTcx = parseTcx(tcx)[0]!;
    const fromFit = only(run());
    expect(fromFit.segments.map((s) => s.map((p) => p.recordedAt))).toEqual(
      fromTcx.segments.map((s) => s.map((p) => p.recordedAt)),
    );
    fromFit.segments.flat().forEach((p, i) => {
      const q = fromTcx.segments.flat()[i]!;
      // Semicircles resolve ~1 cm, TCX here 7 decimals: both far below GPS precision.
      expect(Math.abs(p.latitude - q.latitude)).toBeLessThan(2e-7);
      expect(Math.abs(p.longitude - q.longitude)).toBeLessThan(2e-7);
      expect(Math.abs(p.altitudeMeters! - q.altitudeMeters!)).toBeLessThanOrEqual(0.16);
    });
    expect(fromFit.lapStarts).toEqual(fromTcx.lapStarts);
    const key = (t: ParsedTrack) =>
      t.sensors.map((s) => `${s.type}|${s.recordedAt}|${s.value}|${s.unit}`).sort();
    expect(key(fromFit)).toEqual(key(fromTcx));
    expect(fromFit.sportType).toBe(fromTcx.sportType);
  });

  it('decodes compressed timestamps, big-endian messages and 12-byte headers identically', () => {
    const plain = only(run());
    const sessions = [
      {
        sport: SPORT.running,
        laps: [
          [fitPoints(lap1, { hr: true, cadence: 88, watts: 250 })],
          [
            fitPoints(lap2, { hr: true, cadence: 90, watts: 260 }),
            fitPoints(lap2b, { hr: true, cadence: 91 }),
          ],
        ],
      },
    ];
    for (const variant of [
      { compressTimestamps: true },
      { bigEndian: true },
      { headerSize: 12 as const, compressTimestamps: true, bigEndian: true },
    ]) {
      const t = only(fitActivity({ sessions, ...variant }));
      expect(t.segments).toEqual(plain.segments);
      expect(t.sensors).toEqual(plain.sensors);
      expect(t.lapStarts).toEqual(plain.lapStarts);
    }
  });

  it('imports every activity of chained FIT files and reports other chained files', () => {
    const second = straightTrack({ speedMps: 8, durationSeconds: 200, startTime: T + 3_600_000 });
    const ride = fitActivity({ sessions: [{ sport: SPORT.cycling, laps: [[fitPoints(second)]] }] });
    const tracks = parseFit(concatBytes(run(), ride));
    expect(tracks.map((t) => t.sportType)).toEqual(['running', 'cycling']);
    expect(tracks[1]!.segments[0]![0]!.recordedAt).toBe(T + 3_600_000);

    const course = fitFile(
      new FitWriter()
        .define(0, 0, [[0, BT.enum]])
        .data(0, [6])
        .bytes(),
    );
    const withCourse = parseFit(concatBytes(run(), course));
    expect(withCourse).toHaveLength(1);
    expect(withCourse[0]!.warnings.join(' ')).toMatch(/1 other FIT file.*a course/);
  });

  it('maps sports and falls back to the sport message; unknown sports need a choice', () => {
    const pts = [fitPoints(lap1)];
    const sport = (s: number, extra = {}) =>
      only(fitActivity({ sessions: [{ sport: s, laps: [pts] }], ...extra }));
    expect(sport(SPORT.cycling).sportType).toBe('cycling');
    expect(sport(SPORT.walking).sportType).toBe('walking');
    expect(sport(SPORT.hiking).sportType).toBe('hiking');
    expect(sport(SPORT.generic).sportType).toBeNull();
    const rowing = sport(SPORT.rowing);
    expect(rowing.sportType).toBeNull();
    expect(rowing.warnings.join(' ')).toMatch(/sport \(rowing\) is not one PACE records/);
    const fromMessage = only(
      fitActivity({
        sessions: [{ sport: SPORT.generic, laps: [pts] }],
        omitSessions: true,
        sportMessage: { sport: SPORT.hiking },
      }),
    );
    expect(fromMessage.sportType).toBe('hiking');
    const openWater = only(
      fitActivity({
        sessions: [{ sport: SPORT.swimming, subSport: SUB_SPORT.openWater, laps: [pts] }],
      }),
    );
    expect(openWater.sportType).toBe('swimming');
  });
});

describe('FIT import: triathlon', () => {
  const swim = straightTrack({ speedMps: 1, durationSeconds: 600, startTime: T, intervalMs: 5000 });
  const t1 = straightTrack({
    speedMps: 1,
    durationSeconds: 60,
    startTime: T + 605_000,
    start: after(swim),
  });
  const bike = straightTrack({
    speedMps: 9,
    durationSeconds: 900,
    startTime: T + 666_000,
    start: after(t1),
  });
  const bike2 = straightTrack({
    speedMps: 9,
    durationSeconds: 300,
    startTime: T + 1_600_000,
    start: after(bike),
  });
  const t2 = straightTrack({
    speedMps: 1,
    durationSeconds: 40,
    startTime: T + 1_901_000,
    start: after(bike2),
  });
  const runLeg = straightTrack({
    speedMps: 3.5,
    durationSeconds: 600,
    startTime: T + 1_942_000,
    start: after(t2),
  });

  const tri = (o: { swimSub?: number; sports?: number[] } = {}) => {
    const sports = o.sports ?? [
      SPORT.swimming,
      SPORT.transition,
      SPORT.cycling,
      SPORT.transition,
      SPORT.running,
    ];
    const legs = [
      [[fitPoints(swim)]],
      [[fitPoints(t1)]],
      // Two bike laps, back to back.
      [[fitPoints(bike, { hr: true, watts: 210 })], [fitPoints(bike2, { hr: true, watts: 220 })]],
      [[fitPoints(t2)]],
      [[fitPoints(runLeg, { hr: true, cadence: 86.5 })]],
    ];
    return fitActivity({
      sportMessage: { sport: SPORT.multisport },
      sessions: sports.map((sport, i) => ({
        sport,
        subSport: i === 0 ? (o.swimSub ?? SUB_SPORT.openWater) : 0,
        laps: legs[i]!,
      })),
    });
  };

  it('keeps swim, T1, bike, T2 and run legs; leg changes are neither laps nor pauses', () => {
    const t = only(tri());
    expect(t.sportType).toBe('triathlon');
    expect(t.legStarts).toEqual([
      t1[0]!.recordedAt,
      bike[0]!.recordedAt,
      t2[0]!.recordedAt,
      runLeg[0]!.recordedAt,
    ]);
    // The only lap change inside a leg is the second bike lap.
    expect(t.lapStarts).toEqual([bike2[0]!.recordedAt]);
    // One continuous segment: no timer pause in this race (the bike laps are back to back).
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]).toHaveLength(
      swim.length + t1.length + bike.length + bike2.length + t2.length + runLeg.length,
    );
    const cadence = t.sensors.filter((s) => s.type === 'cadence');
    expect(cadence).toHaveLength(runLeg.length);
    expect(cadence.every((c) => c.value === 86.5 && c.unit === 'rpm')).toBe(true);
    expect(t.sensors.filter((s) => s.type === 'power').map((s) => s.recordedAt)).toEqual(
      [...bike, ...bike2].map((s) => s.recordedAt),
    );
  });

  it('refuses multisport files PACE cannot represent, saying why', () => {
    expect(() => parseFit(tri({ sports: [1, 3, 2, 3, 1] }))).toThrow(
      /other than a swim–bike–run triathlon.*\(this file: run, transition, bike, transition, run\)/,
    );
    expect(() => parseFit(tri({ swimSub: SUB_SPORT.lapSwimming }))).toThrow(/pool swim/);
  });
});

describe('FIT import: sensors', () => {
  it('keeps values exactly as recorded, with their own times, and never fills gaps', () => {
    const pts = fitPoints(lap1).map((p, i) => ({
      ...p,
      ...(i % 5 === 0 ? { hr: 140 + (i % 7) } : {}),
      ...(i % 3 === 0 ? { cadence: 80 + 0.5 * (i % 2) } : {}),
      ...(i === 7 ? { hr: 10 } : {}), // implausible
    }));
    const t = only(fitActivity({ sessions: [{ sport: SPORT.running, laps: [[pts]] }] }));
    const hr = t.sensors.filter((s) => s.type === 'heart_rate');
    const expected = pts.filter((p, i) => i % 5 === 0 && i !== 7);
    expect(hr.map((s) => [s.recordedAt, s.value])).toEqual(
      expected.map((p) => [p.sample.recordedAt, p.hr]),
    );
    expect(hr.every((s) => s.unit === 'bpm')).toBe(true);
    const cad = t.sensors.filter((s) => s.type === 'cadence');
    expect(cad.map((s) => s.value)).toEqual(
      pts.filter((_, i) => i % 3 === 0).map((p) => p.cadence),
    );
    expect(t.sensors.some((s) => s.type === 'power')).toBe(false);
    expect(t.warnings).toContain('1 implausible heart-rate value(s) were skipped.');
  });

  it('keeps sensor data of records without a GPS position', () => {
    const pts = fitPoints(lap1, { hr: true }).map((p, i) =>
      i >= 100 && i < 110 ? { ...p, noPosition: true } : p,
    );
    const t = only(fitActivity({ sessions: [{ sport: SPORT.running, laps: [[pts]] }] }));
    expect(t.segments.flat()).toHaveLength(lap1.length - 10);
    expect(t.sensors.filter((s) => s.type === 'heart_rate')).toHaveLength(lap1.length);
    expect(t.warnings.join(' ')).toMatch(
      /10 record\(s\) had no GPS position; their heart rate, cadence and power were kept/,
    );
  });
});

describe('FIT import: reporting what is not imported', () => {
  it('lists developer fields, device measurements and other data by name', () => {
    const pts = fitPoints(lap1, { hr: true }).map((p, i) => ({
      ...p,
      distance: i * 3.2,
      temperature: 21,
      developer: [i % 256, 0] as [number, number],
    }));
    const t = only(
      fitActivity({
        sessions: [{ sport: SPORT.running, laps: [[pts]] }],
        developerField: { name: 'Form Power', units: 'W' },
        extraMessages: [23, 78, 132, 999],
        calories: true,
      }),
    );
    const text = t.warnings.join(' ');
    expect(text).toMatch(/Distance recorded by the device was not used/);
    const notImported = t.warnings.find((w) => w.startsWith('Not imported:'))!;
    for (const part of [
      'calories',
      'device lap and session summaries',
      'device name',
      'temperature',
      'device and sensor details',
      'heart-rate variability (HRV)',
      'heart rate stored by a chest strap while swimming',
      '1 other kind(s) of device data',
      'developer fields: Form Power',
    ])
      expect(notImported).toContain(part);
    // Developer values are never turned into PACE sensor data.
    expect(t.sensors.every((s) => s.type === 'heart_rate')).toBe(true);
  });
});

describe('FIT import: timing edge cases', () => {
  const recordFile = (build: (w: FitWriter) => void): Uint8Array => {
    const w = new FitWriter();
    w.define(0, 0, [[0, BT.enum]]).data(0, [4]);
    w.define(1, 20, [
      [253, BT.uint32],
      [0, BT.sint32],
      [1, BT.sint32],
      [3, BT.uint8],
    ]);
    w.define(2, 21, [
      [253, BT.uint32],
      [0, BT.enum],
      [1, BT.enum],
    ]);
    build(w);
    return fitFile(w.bytes());
  };
  const rec = (w: FitWriter, s: LocationSample, ts = fitSeconds(s.recordedAt)) =>
    w.data(1, [ts, semicircles(s.latitude), semicircles(s.longitude), 150]);

  it('counts GPS points recorded while the timer was stopped separately', () => {
    const t = only(
      recordFile((w) => {
        w.data(2, [fitSeconds(lap1[0]!.recordedAt), 0, 0]);
        lap1.slice(0, 5).forEach((s) => rec(w, s));
        w.data(2, [fitSeconds(lap1[4]!.recordedAt), 0, 4]);
        lap1.slice(5, 8).forEach((s) => rec(w, s));
        w.data(2, [fitSeconds(lap1[8]!.recordedAt), 0, 0]);
        lap1.slice(8, 13).forEach((s) => rec(w, s));
      }),
    );
    expect(t.segments.map((s) => s.length)).toEqual([5, 5]);
    expect(t.warnings.join(' ')).toMatch(/3 GPS point\(s\) recorded while the timer was stopped/);
    expect(t.sensors).toHaveLength(13);
  });

  it('skips repeated and out-of-order times and refuses files without a real clock', () => {
    const t = only(
      recordFile((w) => {
        lap1.slice(0, 5).forEach((s) => rec(w, s));
        rec(w, lap1[4]!);
        rec(w, lap1[2]!);
        lap1.slice(5, 8).forEach((s) => rec(w, s));
      }),
    );
    expect(t.segments.flat()).toHaveLength(8);
    expect(t.warnings).toEqual(
      expect.arrayContaining([
        "1 record(s) repeating the previous record's time were skipped.",
        '1 out-of-order record(s) were skipped.',
      ]),
    );
    expect(() =>
      parseFit(recordFile((w) => lap1.slice(0, 5).forEach((s, i) => rec(w, s, 1000 + i)))),
    ).toThrow(/clock was not set/);
  });
});

describe('FIT import: refusals', () => {
  it('refuses indoor activities, non-activity files and damaged files as a whole', () => {
    const indoor = fitPoints(lap1, { hr: true }).map((p) => ({ ...p, noPosition: true }));
    expect(() =>
      parseFit(
        fitActivity({
          sessions: [{ sport: SPORT.running, subSport: SUB_SPORT.treadmill, laps: [[indoor]] }],
        }),
      ),
    ).toThrow(/no GPS positions/);
    const course = fitFile(
      new FitWriter()
        .define(0, 0, [[0, BT.enum]])
        .data(0, [6])
        .bytes(),
    );
    expect(() => parseFit(course)).toThrow(
      /contains a course \(a planned route\), not a recorded activity/,
    );
    const ok = run();
    expect(() => parseFit(ok.subarray(0, ok.length - 100))).toThrow(FitImportError);
    expect(() => parseFit(ok.subarray(0, ok.length - 100))).toThrow(/incomplete/);
    const flipped = ok.slice();
    flipped[500] = flipped[500]! ^ 0x40;
    expect(() => parseFit(flipped)).toThrow(/checksum/);
    expect(() => parseFit(new Uint8Array(30))).toThrow(/not a FIT file/);
  });
});
