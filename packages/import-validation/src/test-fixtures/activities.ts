/**
 * TEST FIXTURES ONLY. Synthetic activities for the validation harness's own regression tests,
 * built with the shared hand-written FIT encoder and device-style TCX/GPX builders. No real
 * recordings are used anywhere.
 */
import type { LocationSample } from '@pace/domain';
import { garminTcx, stravaGpx, withSensors } from '../../../formats/src/test-fixtures/device-files';
import {
  type FitPoint,
  SPORT,
  SUB_SPORT,
  fitActivity,
  fitPoints,
} from '../../../formats/src/test-fixtures/fit-encoder';
import { straightTrack } from '../../../gps-engine/src/test-fixtures/synthetic-track';

export const T = Date.UTC(2026, 9, 4, 6, 30);

const after = (s: LocationSample[]) => ({
  latitude: s[s.length - 1]!.latitude,
  longitude: s[s.length - 1]!.longitude,
});

/** V1-like: a run with two laps, heart rate and cadence. */
export const runLap1 = straightTrack({ speedMps: 3.2, durationSeconds: 300, startTime: T });
export const runLap2 = straightTrack({
  speedMps: 3.3,
  durationSeconds: 300,
  startTime: T + 301_000,
  start: after(runLap1),
});

export function runFit(o: { deviceDistance?: number; serialSafe?: boolean } = {}): Uint8Array {
  return fitActivity({
    sessions: [
      {
        sport: SPORT.running,
        laps: [
          [fitPoints(runLap1, { hr: true, cadence: 86 })],
          [fitPoints(runLap2, { hr: true, cadence: 88 })],
        ],
      },
    ],
    ...(o.deviceDistance != null
      ? {
          sessionTotals: () => ({
            timerSeconds: 600,
            distanceMeters: o.deviceDistance!,
            numLaps: 2,
          }),
        }
      : {}),
  });
}

export function runTcx(o: { hrOffset?: number; shiftDegrees?: number } = {}): string {
  const shift = (s: LocationSample[]) =>
    s.map((x) => ({ ...x, latitude: x.latitude + (o.shiftDegrees ?? 0) }));
  const hr = (pts: ReturnType<typeof withSensors>) =>
    pts.map((p) => ({ ...p, ...(p.hr != null ? { hr: p.hr + (o.hrOffset ?? 0) } : {}) }));
  return garminTcx({
    sport: 'Running',
    laps: [
      { tracks: [hr(withSensors(shift(runLap1), { hr: true, cadence: 86 }))] },
      { tracks: [hr(withSensors(shift(runLap2), { hr: true, cadence: 88 }))] },
    ],
  });
}

export function runGpx(): string {
  return stravaGpx({
    name: 'Morning run with Jane Doe',
    type: 'running',
    points: [
      ...withSensors(runLap1, { hr: true, cadence: 86 }),
      ...withSensors(runLap2, { hr: true, cadence: 88 }),
    ],
  });
}

/** V2-like: a run with one manual pause inside the first lap. */
export const pausedA = straightTrack({ speedMps: 3, durationSeconds: 200, startTime: T });
export const pausedB = straightTrack({
  speedMps: 3,
  durationSeconds: 200,
  startTime: T + 260_000,
  start: after(pausedA),
});
export const pausedC = straightTrack({
  speedMps: 3,
  durationSeconds: 200,
  startTime: T + 461_000,
  start: after(pausedB),
});

export function pausedFit(): Uint8Array {
  return fitActivity({
    sessions: [
      {
        sport: SPORT.running,
        laps: [
          [fitPoints(pausedA, { hr: true }), fitPoints(pausedB, { hr: true })],
          [fitPoints(pausedC, { hr: true })],
        ],
      },
    ],
  });
}

export function pausedTcx(): string {
  return garminTcx({
    sport: 'Running',
    laps: [
      { tracks: [withSensors(pausedA, { hr: true }), withSensors(pausedB, { hr: true })] },
      { tracks: [withSensors(pausedC, { hr: true })] },
    ],
  });
}

/** V5-like: a ride with power dropouts and zero cadence while coasting. */
export const ride = straightTrack({ speedMps: 8, durationSeconds: 600, startTime: T });

export function rideWithDropoutsFit(): Uint8Array {
  const pts: FitPoint[] = ride.map((sample, i) => {
    const coasting = i >= 300 && i < 330;
    const powerDropout = i >= 100 && i < 140;
    return {
      sample,
      hr: 140,
      cadence: coasting ? 0 : 90,
      ...(powerDropout ? {} : { watts: coasting ? 0 : 200 + (i % 7) }),
    };
  });
  return fitActivity({ sessions: [{ sport: SPORT.cycling, laps: [[pts]] }] });
}

/** V8-like: swim, T1, bike, T2, run. */
export function triathlonFit(): Uint8Array {
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
  const t2 = straightTrack({
    speedMps: 1,
    durationSeconds: 40,
    startTime: T + 1_567_000,
    start: after(bike),
  });
  const run = straightTrack({
    speedMps: 3.5,
    durationSeconds: 600,
    startTime: T + 1_608_000,
    start: after(t2),
  });
  const legs = [swim, t1, bike, t2, run];
  const sports = [SPORT.swimming, SPORT.transition, SPORT.cycling, SPORT.transition, SPORT.running];
  return fitActivity({
    sportMessage: { sport: SPORT.multisport },
    sessions: sports.map((sport, i) => ({
      sport,
      subSport: i === 0 ? SUB_SPORT.openWater : 0,
      laps: [[fitPoints(legs[i]!, { hr: i > 1 })]],
    })),
  });
}

/** V11-like: an indoor treadmill run without GPS positions. */
export function indoorFit(): Uint8Array {
  const pts = straightTrack({ speedMps: 3, durationSeconds: 120, startTime: T });
  return fitActivity({
    sessions: [
      {
        sport: SPORT.running,
        subSport: SUB_SPORT.treadmill,
        laps: [[pts.map((sample) => ({ sample, hr: 130, noPosition: true }))]],
      },
    ],
  });
}

/** Another run on a different day, for archives. */
export function otherRunGpx(dayOffset: number): string {
  const pts = straightTrack({
    speedMps: 3,
    durationSeconds: 240,
    startTime: T + dayOffset * 86_400_000,
  });
  return stravaGpx({ name: 'Run', type: 'running', points: withSensors(pts, { hr: true }) });
}

/** The serial number the shared FIT encoder writes into file_id. */
export const FIXTURE_SERIAL = '3999000111';
