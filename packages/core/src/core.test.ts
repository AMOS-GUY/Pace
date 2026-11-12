import { RecordingCoordinator, RecordingSession, sessionConfigFor } from '@pace/activity-engine';
import {
  ActivityRepository,
  type DatabaseContext,
  GoalRepository,
  PersonalRecordRepository,
  RouteRepository,
  SqliteRecordingStore,
  configureConnection,
  migrate,
} from '@pace/database';
import { toGpx } from '@pace/formats';
import { FakeBridge } from '../../activity-engine/src/test-fixtures/fakes';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { T0, straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService, AnalyticsService, BackupService, ImportError } from './index';

async function freshDb(seed = 0): Promise<{ ctx: DatabaseContext; clock: { t: number } }> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db);
  const clock = { t: T0 };
  let n = seed;
  return {
    ctx: {
      db,
      now: () => clock.t,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    },
    clock,
  };
}

const run1 = straightTrack({ speedMps: 3.2, durationSeconds: 1200, altitude: (t) => 20 + t / 30 });
const run2 = straightTrack({
  start: { latitude: 1.3, longitude: 103.86 },
  startTime: run1[run1.length - 1]!.recordedAt + 120_000,
  speedMps: 3.2,
  durationSeconds: 600,
});
const gpx = toGpx({
  name: 'Track session',
  sportType: 'running',
  startedAt: T0,
  segments: [run1, run2],
});

describe('GPX import/export', () => {
  it('imports through the recording engine with segments as pauses', async () => {
    const { ctx } = await freshDb();
    const svc = new ActivityService(ctx);
    const { activityId } = await svc.importGpx(gpx, { timezone: 'UTC' });
    const a = (await new ActivityRepository(ctx).getById(activityId))!;
    expect(a.source).toBe('imported_gpx');
    expect(a.status).toBe('completed');
    expect(a.title).toBe('Track session');
    // The 2-minute gap between GPX segments is not moving time.
    expect(a.movingDurationMs).toBe(1_800_000);
    expect(a.elapsedDurationMs).toBe(1_920_000);
    expect(Math.abs(a.distanceMeters - 5760) / 5760).toBeLessThan(0.01);
    expect(a.elevationGainMeters).toBeGreaterThan(30);
    expect(
      (await new PersonalRecordRepository(ctx).list()).some((r) => r.metricType === 'fastest_5k'),
    ).toBe(true);
  });

  it('prevents duplicate imports and requires a sport when the file has none', async () => {
    const { ctx } = await freshDb();
    const svc = new ActivityService(ctx);
    await svc.importGpx(gpx, { timezone: 'UTC' });
    await expect(svc.importGpx(gpx, { timezone: 'UTC' })).rejects.toMatchObject({
      code: 'duplicate',
    });
    const untyped = gpx.replace('<type>running</type>', '');
    await expect(
      svc.importGpx(untyped.replace('Track session', 'x'), { timezone: 'UTC' }),
    ).rejects.toBeInstanceOf(ImportError);
  });

  it('exports valid GPX with the same segments and privacy trimming', async () => {
    const { ctx } = await freshDb();
    const svc = new ActivityService(ctx);
    const { activityId } = await svc.importGpx(gpx, { timezone: 'UTC' });
    const out = await svc.exportGpx(activityId);
    expect(out.fileName).toBe('2026-06-01-Track-session.gpx');
    expect(out.content.match(/<trkseg>/g)).toHaveLength(2);
    expect(out.content.match(/<trkpt /g)).toHaveLength(run1.length + run2.length);
    const trimmed = await svc.exportGpx(activityId, { privacyZoneMeters: 200 });
    expect(trimmed.content.match(/<trkpt /g)!.length).toBeLessThan(run1.length + run2.length);

    // Re-importing our own export into a fresh database yields the same distance.
    const other = await freshDb(100);
    const re = await new ActivityService(other.ctx).importGpx(out.content, { timezone: 'UTC' });
    const a = (await new ActivityRepository(ctx).getById(activityId))!;
    const b = (await new ActivityRepository(other.ctx).getById(re.activityId))!;
    expect(b.distanceMeters).toBeCloseTo(a.distanceMeters, 0);
  });

  it('exports a CSV summary', async () => {
    const { ctx } = await freshDb();
    const svc = new ActivityService(ctx);
    await svc.importGpx(gpx, { timezone: 'UTC' });
    expect((await svc.exportCsv()).content.split('\r\n').filter(Boolean)).toHaveLength(2);
  });
});

describe('backup and restore', () => {
  it('restores the full history into a new device, rebuilding derived data by replay', async () => {
    const src = await freshDb();
    const svc = new ActivityService(src.ctx);
    const imported = await svc.importGpx(gpx, { timezone: 'UTC' });
    await new ActivityRepository(src.ctx).updateDetails(imported.activityId, {
      title: 'Renamed',
      description: 'Notes',
    });

    // A recorded pool swim (no GPS) and a live-recorded ride.
    const store = new SqliteRecordingStore(src.ctx);
    const swimCfg = sessionConfigFor(src.ctx.newId(), 'swimming', {
      swimMode: 'pool',
      poolLengthMeters: 25,
    });
    const swim = new RecordingSession(swimCfg);
    await store.createRecording({
      activity: {
        id: swimCfg.activityId,
        userId: null,
        sportType: 'swimming',
        title: 'Pool',
        startedAt: T0,
        timezone: 'UTC',
        swimMode: 'pool',
        poolLengthMeters: 25,
      },
      config: swimCfg,
    });
    const evs = [
      ...swim.start(T0),
      ...swim.lap(T0 + 300_000, 8),
      ...swim.lap(T0 + 600_000, 8),
      ...swim.finish(T0 + 610_000),
    ];
    await store.appendRecording(swimCfg.activityId, {
      samples: [],
      events: evs,
      status: 'recording',
      metrics: {
        elapsedDurationMs: 0,
        movingDurationMs: 0,
        distanceMeters: 0,
        elevationGainMeters: 0,
        elevationLossMeters: 0,
        averageSpeedMps: null,
        maximumSpeedMps: null,
        averagePaceMsPerKm: null,
      },
    });
    await store.completeRecording(swimCfg.activityId, swim.summary());

    const bridge = new FakeBridge();
    src.clock.t = T0 + 86_400_000;
    const coord = new RecordingCoordinator({
      bridge,
      store,
      clock: { now: () => src.clock.t },
      newId: src.ctx.newId,
      timezone: () => 'UTC',
      userId: () => null,
    });
    await coord.prepare('cycling');
    await coord.start();
    bridge.emit(straightTrack({ speedMps: 8, durationSeconds: 900, startTime: src.clock.t }));
    src.clock.t += 900_000;
    await coord.finish();
    await new GoalRepository(src.ctx).create({
      sportType: null,
      goalType: 'activity_count',
      targetValue: 3,
      period: 'week',
    });

    const backup = new BackupService(src.ctx, '0.1.0');
    const { bytes } = await backup.createBackup({
      kind: 'passphrase',
      passphrase: 'a long backup passphrase',
    });

    const dst = await freshDb(500);
    const restoreSvc = new BackupService(dst.ctx, '0.1.0');
    const doc = restoreSvc.open(bytes, {
      kind: 'passphrase',
      passphrase: 'a long backup passphrase',
    });
    const report = await restoreSvc.restore(doc);
    expect(report).toEqual({ restored: 3, skippedExisting: 0, failed: [], goalsRestored: 1 });

    const srcList = (await new ActivityRepository(src.ctx).list()).items;
    const dstList = (await new ActivityRepository(dst.ctx).list()).items;
    expect(
      dstList.map((a) => [
        a.id,
        a.title,
        a.sportType,
        Math.round(a.distanceMeters),
        a.movingDurationMs,
      ]),
    ).toEqual(
      srcList.map((a) => [
        a.id,
        a.title,
        a.sportType,
        Math.round(a.distanceMeters),
        a.movingDurationMs,
      ]),
    );
    const restoredSwim = dstList.find((a) => a.sportType === 'swimming')!;
    expect(restoredSwim.distanceMeters).toBe(400);
    expect(await new ActivityRepository(dst.ctx).laps(restoredSwim.id)).toHaveLength(2);
    expect(await new RouteRepository(dst.ctx).rawCount(imported.activityId)).toBe(
      run1.length + run2.length,
    );
    expect((await new PersonalRecordRepository(dst.ctx).list()).length).toBe(
      (await new PersonalRecordRepository(src.ctx).list()).length,
    );

    // Restoring again is a no-op: local data is never overwritten.
    expect(await restoreSvc.restore(doc)).toMatchObject({ restored: 0, skippedExisting: 3 });
  });

  it('refuses an encrypted backup without the right key', async () => {
    const { ctx } = await freshDb();
    const svc = new BackupService(ctx, '0.1.0');
    const { bytes } = await svc.createBackup({
      kind: 'passphrase',
      passphrase: 'a long backup passphrase',
    });
    expect(() => svc.open(bytes, null)).toThrow('encrypted');
    expect(() =>
      svc.open(bytes, { kind: 'passphrase', passphrase: 'not the right passphrase' }),
    ).toThrow('Wrong key');
  });
});

describe('analytics service', () => {
  it('builds the dashboard and progress views from stored activities', async () => {
    const { ctx } = await freshDb();
    await new ActivityService(ctx).importGpx(gpx, { timezone: 'UTC' });
    await new GoalRepository(ctx).create({
      sportType: 'running',
      goalType: 'distance',
      targetValue: 10_000,
      period: 'week',
    });
    const svc = new AnalyticsService(ctx);
    const d = await svc.dashboard(T0 + 86_400_000, 'UTC');
    expect(d.thisWeek.activityCount).toBe(1);
    expect(d.recent).toHaveLength(1);
    expect(d.goals[0]!.progress.ratio).toBeGreaterThan(0.5);
    const p = await svc.progress({ period: 'month', count: 6, now: T0, timeZone: 'UTC' });
    expect(p.buckets).toHaveLength(6);
    expect(p.bySport[0]!.sportType).toBe('running');
    expect(p.records.length).toBeGreaterThan(0);
  });

  it('gives a new athlete an empty dashboard with no invented comparisons', async () => {
    const { ctx } = await freshDb();
    const d = await new AnalyticsService(ctx).dashboard(T0, 'UTC');
    expect(d.totalActivityCount).toBe(0);
    expect(d.recent).toEqual([]);
    expect(d.thisWeekBySport).toEqual([]);
    expect(d.comparison).toEqual({ distanceChange: null, movingTimeChange: null });
    expect(d.trailingAverage).toBeNull();
    expect(d.days).toHaveLength(7);
    expect(d.days.every((x) => x.activityCount === 0)).toBe(true);
    expect(d.consistency).toEqual({
      windowWeeks: 8,
      activeWeeks: 0,
      currentStreakWeeks: 0,
      activeDaysThisWeek: 0,
    });
  });

  it('derives weekly sport totals, active days and consistency from stored activities', async () => {
    const { ctx } = await freshDb();
    const { activityId } = await new ActivityService(ctx).importGpx(gpx, { timezone: 'UTC' });
    const stored = (await new ActivityRepository(ctx).getById(activityId))!;
    const d = await new AnalyticsService(ctx).dashboard(T0 + 3_600_000, 'UTC');
    expect(d.totalActivityCount).toBe(1);
    expect(d.thisWeekBySport.map((s) => s.sportType)).toEqual(['running']);
    expect(d.thisWeekBySport[0]!.distanceMeters).toBe(stored.distanceMeters);
    expect(d.thisWeek.distanceMeters).toBe(stored.distanceMeters);
    expect(d.days.reduce((n, x) => n + x.activityCount, 0)).toBe(1);
    expect(d.consistency.activeWeeks).toBe(1);
    expect(d.consistency.currentStreakWeeks).toBe(1);
    // Last week is empty: no percentage change is reported.
    expect(d.comparison.distanceChange).toBeNull();
    // History is shorter than the 4-week comparison window.
    expect(d.trailingAverage).toBeNull();
  });
});
