import { RecordingCoordinator } from '@pace/activity-engine';
import {
  ActivityRepository,
  type DatabaseContext,
  SqliteRecordingStore,
  configureConnection,
  migrate,
} from '@pace/database';
import { toGpx } from '@pace/formats';
import { FakeBridge } from '../../activity-engine/src/test-fixtures/fakes';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { garminTcx, stravaGpx, withSensors } from '../../formats/src/test-fixtures/device-files';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService, type ImportError } from './index';

const T = Date.UTC(2026, 9, 4, 6, 30);

async function freshDb(): Promise<{ ctx: DatabaseContext; clock: { t: number } }> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db);
  const clock = { t: T };
  let n = 0;
  return {
    ctx: {
      db,
      now: () => clock.t,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    },
    clock,
  };
}

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
  start: { latitude: lap1[lap1.length - 1]!.latitude, longitude: lap1[lap1.length - 1]!.longitude },
  altitude: (t) => 20 - t / 40,
});
const allPoints = [...lap1, ...lap2];

const tcx = garminTcx({
  sport: 'Running',
  notes: 'Progression run',
  laps: [
    { tracks: [withSensors(lap1, { hr: true, cadence: 86 })] },
    { tracks: [withSensors(lap2, { hr: true, cadence: 90 })] },
  ],
});
const gpxSamePoints = stravaGpx({
  name: 'Morning Run',
  type: 'running',
  points: withSensors(allPoints),
});

async function count(
  ctx: DatabaseContext,
  sql: string,
  params: Array<string | number> = [],
): Promise<number> {
  return (await ctx.db.get<{ n: number }>(sql, params))!.n;
}

describe('TCX import', () => {
  it('stores a TCX run with laps, sensors and source through the shared pipeline', async () => {
    const { ctx } = await freshDb();
    const [r] = await new ActivityService(ctx).importTcx(tcx, { timezone: 'Asia/Singapore' });
    if (!r!.ok) throw r!.error;
    const id = r.result.activityId;
    const a = (await new ActivityRepository(ctx).getById(id))!;
    expect(a.source).toBe('imported_tcx');
    expect(a.sportType).toBe('running');
    expect(a.status).toBe('completed');
    expect(a.title).toBe('Imported activity');
    expect(a.description).toBe('Progression run');
    expect(a.timezone).toBe('Asia/Singapore');
    expect(a.startedAt).toBe(T);
    // The file's lap boundary becomes a lap event; the engine derives both laps from the track.
    const laps = await new ActivityRepository(ctx).laps(id);
    expect(laps).toHaveLength(2);
    expect(laps[1]!.startedAt).toBe(lap2[0]!.recordedAt);
    expect(laps[0]!.distanceMeters + laps[1]!.distanceMeters).toBeCloseTo(a.distanceMeters, 0);
    expect(laps[0]!.distanceMeters).toBeGreaterThan(900);
    expect(laps[0]!.distanceMeters).toBeLessThan(1000);
    expect(
      await count(
        ctx,
        "SELECT COUNT(*) AS n FROM sensor_samples WHERE activity_id = ? AND sensor_type = 'heart_rate'",
        [id],
      ),
    ).toBe(allPoints.length);
    expect(
      await count(
        ctx,
        "SELECT COUNT(*) AS n FROM sensor_samples WHERE activity_id = ? AND sensor_type = 'cadence' AND unit = 'rpm'",
        [id],
      ),
    ).toBe(allPoints.length);
    expect(
      await count(ctx, 'SELECT COUNT(*) AS n FROM route_points WHERE activity_id = ?', [id]),
    ).toBe(allPoints.length);
    expect(r.result.warnings.join(' ')).toContain('calories');
  });

  it('computes the same metrics for the same track whether it arrives as GPX or TCX', async () => {
    const a = await freshDb();
    const b = await freshDb();
    const [t] = await new ActivityService(a.ctx).importTcx(tcx, { timezone: 'UTC' });
    if (!t!.ok) throw t!.error;
    const g = await new ActivityService(b.ctx).importGpx(gpxSamePoints, { timezone: 'UTC' });
    const fromTcx = (await new ActivityRepository(a.ctx).getById(t.result.activityId))!;
    const fromGpx = (await new ActivityRepository(b.ctx).getById(g.activityId))!;
    for (const k of [
      'distanceMeters',
      'movingDurationMs',
      'elapsedDurationMs',
      'elevationGainMeters',
      'elevationLossMeters',
      'averagePaceMsPerKm',
      'maximumSpeedMps',
    ] as const)
      expect(fromTcx[k]).toBeCloseTo(fromGpx[k] as number, 6);
  });

  it('refuses the same activity again, in either format, and names the existing one', async () => {
    const { ctx } = await freshDb();
    const svc = new ActivityService(ctx);
    const [first] = await svc.importTcx(tcx, { timezone: 'UTC' });
    if (!first!.ok) throw first!.error;
    const [again] = await svc.importTcx(tcx, { timezone: 'UTC' });
    expect(again!.ok).toBe(false);
    const err = (again as { error: ImportError }).error;
    expect(err.code).toBe('duplicate');
    expect(err.existingActivityId).toBe(first.result.activityId);
    await expect(svc.importGpx(gpxSamePoints, { timezone: 'UTC' })).rejects.toMatchObject({
      code: 'duplicate',
      existingActivityId: first.result.activityId,
    });
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM activities')).toBe(1);
  });

  it('treats a differently sampled copy of the same session as a duplicate, but not back-to-back sessions', async () => {
    const { ctx } = await freshDb();
    const svc = new ActivityService(ctx);
    await svc.importGpx(gpxSamePoints, { timezone: 'UTC' });
    // Same session recorded by another device: every other point, slightly offset.
    const otherDevice = allPoints
      .filter((_, i) => i % 2 === 0)
      .map((p) => ({ ...p, latitude: p.latitude + 0.00001 }));
    await expect(
      svc.importGpx(
        stravaGpx({ name: 'Copy', type: 'running', points: withSensors(otherDevice) }),
        { timezone: 'UTC' },
      ),
    ).rejects.toMatchObject({ code: 'duplicate' });
    // A cool-down starting right after the run is a separate activity.
    const coolDown = straightTrack({
      speedMps: 1.5,
      durationSeconds: 600,
      startTime: allPoints[allPoints.length - 1]!.recordedAt + 60_000,
    });
    await svc.importGpx(
      stravaGpx({ name: 'Cool-down', type: 'walking', points: withSensors(coolDown) }),
      {
        timezone: 'UTC',
      },
    );
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM activities')).toBe(2);
  });

  it("recognises PACE's own GPX export of a recorded activity as already present", async () => {
    const { ctx, clock } = await freshDb();
    const bridge = new FakeBridge();
    const coord = new RecordingCoordinator({
      bridge,
      store: new SqliteRecordingStore(ctx),
      clock: { now: () => clock.t },
      newId: ctx.newId,
      timezone: () => 'UTC',
      userId: () => null,
    });
    await coord.prepare('cycling');
    const { activityId } = (await coord.start()) as { activityId: string };
    bridge.emit(straightTrack({ speedMps: 8, durationSeconds: 900, startTime: clock.t }));
    clock.t += 900_000;
    await coord.finish();
    coord.dispose();
    const svc = new ActivityService(ctx);
    const { content } = await svc.exportGpx(activityId, { privacyZoneMeters: 200 });
    await expect(svc.importGpx(content, { timezone: 'UTC' })).rejects.toMatchObject({
      code: 'duplicate',
      existingActivityId: activityId,
    });
  });

  it('imports each activity of a multi-activity TCX on its own', async () => {
    const { ctx } = await freshDb();
    const later = straightTrack({ speedMps: 1.4, durationSeconds: 600, startTime: T + 86_400_000 });
    const file = garminTcx({
      sport: 'Running',
      laps: [{ tracks: [withSensors(lap1)] }],
      extraActivities: [{ sport: 'Other', laps: [{ tracks: [withSensors(later)] }] }],
    });
    const results = await new ActivityService(ctx).importTcx(file, { timezone: 'UTC' });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect((results[1] as { error: ImportError }).error.code).toBe('sport_required');
    const withSport = await new ActivityService(ctx).importTcx(file, {
      timezone: 'UTC',
      sportType: 'walking',
    });
    // The first one is now a duplicate; the second imports with the chosen sport.
    expect(withSport.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual(['duplicate', 'ok']);
  });

  it('stores cycling power and rejects files that are not activities', async () => {
    const { ctx } = await freshDb();
    const ride = straightTrack({ speedMps: 8, durationSeconds: 300, startTime: T });
    const [r] = await new ActivityService(ctx).importTcx(
      garminTcx({
        sport: 'Biking',
        laps: [{ tracks: [withSensors(ride, { cadence: 88, watts: 220 })] }],
      }),
      { timezone: 'UTC' },
    );
    if (!r!.ok) throw r!.error;
    expect(
      await count(
        ctx,
        "SELECT COUNT(*) AS n FROM sensor_samples WHERE sensor_type = 'power' AND unit = 'W'",
      ),
    ).toBe(ride.length);
    await expect(
      new ActivityService(ctx).importTcx('<gpx/>', { timezone: 'UTC' }),
    ).rejects.toMatchObject({
      code: 'invalid_file',
    });
  });

  it('keeps a GPX imported before this change exportable with its heart rate', async () => {
    const { ctx } = await freshDb();
    const svc = new ActivityService(ctx);
    const xml = toGpx({
      name: 'HR run',
      sportType: 'running',
      startedAt: T,
      segments: [lap1],
      heartRate: lap1.map((s) => ({ recordedAt: s.recordedAt, bpm: 140 })),
    });
    const r = await svc.importGpx(xml, { timezone: 'UTC' });
    const { content } = await svc.exportGpx(r.activityId);
    expect(content.match(/<gpxtpx:hr>140<\/gpxtpx:hr>/g)).toHaveLength(lap1.length);
  });
});
