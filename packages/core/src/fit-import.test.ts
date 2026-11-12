import {
  ActivityRepository,
  type DatabaseContext,
  configureConnection,
  migrate,
} from '@pace/database';
import type { LocationSample } from '@pace/domain';
import { bytesSource } from '@pace/formats';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { garminTcx, stravaGpx, withSensors } from '../../formats/src/test-fixtures/device-files';
import {
  SPORT,
  SUB_SPORT,
  fitActivity,
  fitPoints,
} from '../../formats/src/test-fixtures/fit-encoder';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  ActivityService,
  BulkImportService,
  type ImportError,
  type ImportSourceFile,
} from './index';

const T = Date.UTC(2026, 9, 11, 7, 0);
const DAY = 86_400_000;

async function freshDb(): Promise<DatabaseContext> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db);
  let n = 0;
  return {
    db,
    now: () => T,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

const count = async (ctx: DatabaseContext, sql: string, params: Array<string | number> = []) =>
  (await ctx.db.get<{ n: number }>(sql, params))!.n;

const after = (s: LocationSample[]) => ({
  latitude: s[s.length - 1]!.latitude,
  longitude: s[s.length - 1]!.longitude,
});

const lap1 = straightTrack({
  speedMps: 3.2,
  durationSeconds: 300,
  startTime: T,
  altitude: (t) => 10 + t / 30,
});
const lap2 = straightTrack({
  speedMps: 3.4,
  durationSeconds: 400,
  startTime: T + 301_000,
  start: after(lap1),
  altitude: (t) => 20 - t / 40,
});

const fitRun = fitActivity({
  sessions: [
    {
      sport: SPORT.running,
      laps: [
        [fitPoints(lap1, { hr: true, cadence: 86 })],
        [fitPoints(lap2, { hr: true, cadence: 90 })],
      ],
    },
  ],
});
const tcxRun = garminTcx({
  sport: 'Running',
  laps: [
    { tracks: [withSensors(lap1, { hr: true, cadence: 86 })] },
    { tracks: [withSensors(lap2, { hr: true, cadence: 90 })] },
  ],
});
const gpxRun = stravaGpx({ name: 'Run', type: 'running', points: withSensors([...lap1, ...lap2]) });

const one = async (svc: ActivityService, bytes: Uint8Array) => {
  const [r] = await svc.importFit(bytes, { timezone: 'Europe/Zurich' });
  if (!r!.ok) throw r!.error;
  return r.result;
};

const METRICS = [
  'distanceMeters',
  'movingDurationMs',
  'elapsedDurationMs',
  'elevationGainMeters',
  'elevationLossMeters',
  'averagePaceMsPerKm',
  'maximumSpeedMps',
] as const;

describe('FIT import through the shared pipeline', () => {
  it('stores a FIT run with source, laps and sensors', async () => {
    const ctx = await freshDb();
    const r = await one(new ActivityService(ctx), fitRun);
    const repo = new ActivityRepository(ctx);
    const a = (await repo.getById(r.activityId))!;
    expect(a).toMatchObject({
      source: 'imported_fit',
      sportType: 'running',
      status: 'completed',
      startedAt: T,
    });
    const laps = await repo.laps(r.activityId);
    expect(laps.map((l) => l.startedAt)).toEqual([T, lap2[0]!.recordedAt]);
    const n = lap1.length + lap2.length;
    expect(
      await count(ctx, 'SELECT COUNT(*) AS n FROM route_points WHERE activity_id = ?', [
        r.activityId,
      ]),
    ).toBe(n);
    const sensors = await ctx.db.all<{ sensor_type: string; unit: string; n: number }>(
      'SELECT sensor_type, unit, COUNT(*) AS n FROM sensor_samples WHERE activity_id = ? GROUP BY sensor_type, unit ORDER BY sensor_type',
      [r.activityId],
    );
    expect(sensors).toEqual([
      { sensor_type: 'cadence', unit: 'rpm', n },
      { sensor_type: 'heart_rate', unit: 'bpm', n },
    ]);
    expect(r.warnings.join(' ')).toContain('device name');
  });

  it('computes the same metrics as the same session imported from TCX and GPX', async () => {
    const results = [];
    for (const kind of ['fit', 'tcx', 'gpx'] as const) {
      const ctx = await freshDb();
      const svc = new ActivityService(ctx);
      let id: string;
      if (kind === 'fit') id = (await one(svc, fitRun)).activityId;
      else if (kind === 'tcx') {
        const [r] = await svc.importTcx(tcxRun, { timezone: 'UTC' });
        if (!r!.ok) throw r!.error;
        id = r.result.activityId;
      } else
        id = (await svc.importGpx(gpxRun, { timezone: 'UTC', sportType: 'running' })).activityId;
      results.push((await new ActivityRepository(ctx).getById(id))!);
    }
    const [fit, tcx, gpx] = results;
    for (const k of METRICS) {
      // Distance and pace may differ by the sub-centimetre rounding of FIT semicircles.
      expect(fit![k]).toBeCloseTo(tcx![k] as number, k === 'distanceMeters' ? 1 : 0);
      expect(tcx![k]).toBeCloseTo(gpx![k] as number, 6);
    }
    expect(fit!.movingDurationMs).toBe(tcx!.movingDurationMs);
    expect(fit!.elapsedDurationMs).toBe(tcx!.elapsedDurationMs);
  });

  it('refuses the same session again as FIT, TCX or GPX', async () => {
    const ctx = await freshDb();
    const svc = new ActivityService(ctx);
    const first = await one(svc, fitRun);
    const [again] = await svc.importFit(fitRun, { timezone: 'UTC' });
    expect(again!.ok).toBe(false);
    expect((again as { error: ImportError }).error).toMatchObject({
      code: 'duplicate',
      existingActivityId: first.activityId,
    });
    const [asTcx] = await svc.importTcx(tcxRun, { timezone: 'UTC' });
    expect((asTcx as { error: ImportError }).error.code).toBe('duplicate');
    await expect(
      svc.importGpx(gpxRun, { timezone: 'UTC', sportType: 'running' }),
    ).rejects.toMatchObject({
      code: 'duplicate',
    });
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM activities')).toBe(1);
  });

  it('refuses a damaged FIT file as a whole and stores nothing from it', async () => {
    const ctx = await freshDb();
    const svc = new ActivityService(ctx);
    const damaged = fitRun.slice();
    damaged[2000] = damaged[2000]! ^ 0xff;
    await expect(svc.importFit(damaged, { timezone: 'UTC' })).rejects.toMatchObject({
      code: 'invalid_file',
      message: expect.stringMatching(/checksum/),
    });
    await expect(
      svc.importFit(fitRun.subarray(0, 5000), { timezone: 'UTC' }),
    ).rejects.toMatchObject({
      code: 'invalid_file',
      message: expect.stringMatching(/incomplete/),
    });
    for (const table of ['activities', 'route_points', 'sensor_samples', 'recording_events'])
      expect(await count(ctx, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
  });
});

describe('FIT triathlon import', () => {
  const swim = straightTrack({
    speedMps: 1.1,
    durationSeconds: 900,
    startTime: T,
    intervalMs: 3000,
  });
  const t1 = straightTrack({
    speedMps: 1.5,
    durationSeconds: 90,
    startTime: T + 903_000,
    start: after(swim),
  });
  const bike = straightTrack({
    speedMps: 9,
    durationSeconds: 1800,
    startTime: T + 994_000,
    start: after(t1),
  });
  const t2 = straightTrack({
    speedMps: 1.5,
    durationSeconds: 60,
    startTime: T + 2_795_000,
    start: after(bike),
  });
  const run1 = straightTrack({
    speedMps: 3.5,
    durationSeconds: 600,
    startTime: T + 2_856_000,
    start: after(t2),
  });
  // The athlete stops the timer for 2 minutes during the run, then continues.
  const run2 = straightTrack({
    speedMps: 3.5,
    durationSeconds: 600,
    startTime: T + 3_577_000,
    start: after(run1),
  });
  const triathlon = fitActivity({
    sportMessage: { sport: SPORT.multisport },
    sessions: [
      {
        sport: SPORT.swimming,
        subSport: SUB_SPORT.openWater,
        laps: [[fitPoints(swim, { hr: true })]],
      },
      { sport: SPORT.transition, laps: [[fitPoints(t1)]] },
      { sport: SPORT.cycling, laps: [[fitPoints(bike, { hr: true, watts: 220 })]] },
      { sport: SPORT.transition, laps: [[fitPoints(t2)]] },
      {
        sport: SPORT.running,
        laps: [[fitPoints(run1, { hr: true }), fitPoints(run2, { hr: true })]],
      },
    ],
  });

  it('keeps each leg with its own figures and the pause inside the run', async () => {
    const ctx = await freshDb();
    const r = await one(new ActivityService(ctx), triathlon);
    const repo = new ActivityRepository(ctx);
    const a = (await repo.getById(r.activityId))!;
    expect(a.sportType).toBe('triathlon');
    expect(a.source).toBe('imported_fit');
    const legs = await repo.segments(r.activityId);
    expect(legs.map((l) => l.segmentType)).toEqual([
      'swim',
      'transition_1',
      'bike',
      'transition_2',
      'run',
    ]);
    expect(legs.map((l) => l.startedAt)).toEqual([
      T,
      t1[0]!.recordedAt,
      bike[0]!.recordedAt,
      t2[0]!.recordedAt,
      run1[0]!.recordedAt,
    ]);
    const [s, , b, , run] = legs;
    expect(s!.distanceMeters).toBeGreaterThan(900);
    expect(s!.distanceMeters).toBeLessThan(1100);
    expect(b!.distanceMeters).toBeGreaterThan(15_500);
    expect(b!.distanceMeters).toBeLessThan(16_500);
    expect(run!.distanceMeters).toBeGreaterThan(4000);
    expect(run!.distanceMeters).toBeLessThan(4300);
    // Moving time leaves out the 2-minute timer stop; elapsed time includes it.
    expect(run!.elapsedDurationMs - run!.movingDurationMs).toBeGreaterThanOrEqual(115_000);
    expect(a.elapsedDurationMs - a.movingDurationMs).toBeGreaterThanOrEqual(115_000);
    expect(
      await count(ctx, "SELECT COUNT(*) AS n FROM sensor_samples WHERE sensor_type = 'power'"),
    ).toBe(bike.length);
  });

  it('still refuses a triathlon from files that have no legs', async () => {
    const ctx = await freshDb();
    const svc = new ActivityService(ctx);
    await expect(
      svc.importGpx(gpxRun, { timezone: 'UTC', sportType: 'triathlon' }),
    ).rejects.toMatchObject({
      code: 'unsupported_sport',
      message: expect.stringMatching(/without their swim, transition, bike and run legs/),
    });
  });
});

describe('FIT in bulk import', () => {
  const file = (name: string, bytes: Uint8Array): ImportSourceFile => ({
    name,
    size: bytes.length,
    open: () => bytesSource(bytes, 4096),
  });
  const day = (d: number) =>
    fitActivity({
      sessions: [
        {
          sport: SPORT.cycling,
          laps: [
            [
              fitPoints(
                straightTrack({ speedMps: 8, durationSeconds: 600, startTime: T + d * DAY }),
                { watts: 200 },
              ),
            ],
          ],
        },
      ],
    });

  it('imports FIT files from an archive, each on its own, and a bad one changes nothing else', async () => {
    const ctx = await freshDb();
    const bulk = new BulkImportService(ctx);
    const first = await bulk.importFiles([file('ride.fit', day(1))], { timezone: 'UTC' });
    expect(first.imported).toBe(1);
    const snapshot = async () => ({
      activities: await ctx.db.all('SELECT * FROM activities ORDER BY id'),
      points: await count(ctx, 'SELECT COUNT(*) AS n FROM route_points'),
      sensors: await count(ctx, 'SELECT COUNT(*) AS n FROM sensor_samples'),
      events: await count(ctx, 'SELECT COUNT(*) AS n FROM recording_events'),
    });
    const before = await snapshot();

    const damaged = day(3).slice();
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    const archive = zipSync({
      'export/activities/1.fit': day(1), // already imported
      'export/activities/2.fit.gz': gzipSync(day(2)),
      'export/activities/3.fit': damaged,
      'export/activities/4.fit': day(4).subarray(0, 3000),
      'export/activities/5.fit': strToU8('not fit at all'),
      'export/activities/6.fit.gz': day(6),
    });
    const report = await bulk.importFiles([file('export.zip', archive)], { timezone: 'UTC' });
    const by = Object.fromEntries(report.outcomes.map((o) => [o.entry, [o.status, o.message]]));
    expect(by['export/activities/1.fit']![0]).toBe('duplicate');
    expect(by['export/activities/2.fit.gz']).toEqual(['imported', null]);
    expect(by['export/activities/3.fit']).toEqual(['failed', expect.stringMatching(/checksum/)]);
    expect(by['export/activities/4.fit']).toEqual(['failed', expect.stringMatching(/incomplete/)]);
    expect(by['export/activities/5.fit']).toEqual([
      'failed',
      expect.stringMatching(/not a FIT file/),
    ]);
    expect(by['export/activities/6.fit.gz']![0]).toBe('failed');
    expect([report.imported, report.duplicates, report.failed]).toEqual([1, 1, 4]);

    // The activity imported earlier is untouched; exactly one new activity was added.
    const after = await snapshot();
    expect(after.activities.slice(0, 1)).toEqual(before.activities);
    expect(after.activities).toHaveLength(2);
    expect(after.points).toBeGreaterThan(before.points);
  });
});
