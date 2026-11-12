import { RecordingCoordinator } from '@pace/activity-engine';
import { decodePolyline } from '@pace/gps-engine';
import { FakeBridge } from '../../activity-engine/src/test-fixtures/fakes';
import { T0, straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  ActivityRepository,
  type DatabaseContext,
  GoalRepository,
  MIGRATIONS,
  PersonalRecordRepository,
  RouteRepository,
  SettingsRepository,
  SqliteRecordingStore,
  SyncOutboxRepository,
  configureConnection,
  migrate,
} from './index';
import { NodeSqliteDriver } from './test-fixtures/node-sqlite-driver';

async function setup(): Promise<{ ctx: DatabaseContext; clock: { t: number } }> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db);
  const clock = { t: T0 };
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

async function recordRun(
  ctx: DatabaseContext,
  clock: { t: number },
  bridge: FakeBridge,
  opts: { speed: number; seconds: number; startTime: number; sport?: 'running' | 'cycling' },
): Promise<string> {
  clock.t = opts.startTime;
  const c = new RecordingCoordinator({
    bridge,
    store: new SqliteRecordingStore(ctx),
    clock: { now: () => clock.t },
    newId: ctx.newId,
    timezone: () => 'UTC',
    userId: () => null,
  });
  await c.prepare(opts.sport ?? 'running');
  const { activityId } = (await c.start()) as { activityId: string };
  bridge.emit(
    straightTrack({
      speedMps: opts.speed,
      durationSeconds: opts.seconds,
      startTime: opts.startTime,
    }),
  );
  clock.t = opts.startTime + opts.seconds * 1000;
  await c.finish();
  c.dispose();
  return activityId;
}

describe('migrations', () => {
  it('applies the schema once and is idempotent', async () => {
    const db = new NodeSqliteDriver();
    const first = await migrate(db);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.toVersion).toBe(MIGRATIONS.length);
  });

  it('preserves existing data when a later migration is applied', async () => {
    const { ctx } = await setup();
    await new SettingsRepository(ctx).set('units', 'imperial');
    const next = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: 'add_test_column',
        statements: ['ALTER TABLE settings ADD COLUMN note TEXT'],
      },
    ];
    const r = await migrate(ctx.db, next);
    expect(r.applied).toEqual([MIGRATIONS.length + 1]);
    expect(await new SettingsRepository(ctx).get('units')).toBe('imperial');
  });

  it('refuses to open a database from a newer app version', async () => {
    const { ctx } = await setup();
    await ctx.db.run("INSERT INTO schema_migrations VALUES (99, 'future', 0)");
    await expect(migrate(ctx.db)).rejects.toThrow('newer than this app supports');
  });

  it('rolls back a failing migration atomically', async () => {
    const db = new NodeSqliteDriver();
    const broken = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: 'broken',
        statements: ['CREATE TABLE ok_table (x)', 'NOT VALID SQL'],
      },
    ];
    await expect(migrate(db, broken)).rejects.toThrow();
    expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'ok_table'")).toBeNull();
    expect((await migrate(db)).toVersion).toBe(MIGRATIONS.length);
  });

  it('enforces foreign keys', async () => {
    const { ctx } = await setup();
    await expect(
      ctx.db.run(
        "INSERT INTO route_points (activity_id, sequence_number, latitude, longitude, horizontal_accuracy_meters, recorded_at, source) VALUES ('missing', 0, 1, 1, 5, 1, 'replay')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('recording persistence (end to end through SQLite)', () => {
  it('stores raw samples incrementally and derived data on completion', async () => {
    const { ctx, clock } = await setup();
    const bridge = new FakeBridge();
    const id = await recordRun(ctx, clock, bridge, { speed: 3.5, seconds: 1500, startTime: T0 });
    const activities = new ActivityRepository(ctx);
    const a = (await activities.getById(id))!;
    expect(a.status).toBe('completed');
    expect(a.distanceMeters).toBeGreaterThan(5200);
    expect(a.movingDurationMs).toBe(1_500_000);
    expect(await new RouteRepository(ctx).rawCount(id)).toBe(1501);
    expect((await activities.splits(id)).length).toBe(6);

    const route = (await new RouteRepository(ctx).processed(id))!;
    expect(route.segments).toHaveLength(1);
    expect(decodePolyline(route.segments[0]!, 6).length).toBeGreaterThan(100);
    expect(route.bounds).not.toBeNull();

    const prs = await new PersonalRecordRepository(ctx).list();
    expect(prs.map((p) => p.metricType).sort()).toEqual([
      'fastest_1k',
      'fastest_5k',
      'longest_distance',
    ]);
    expect(prs.find((p) => p.metricType === 'fastest_5k')!.basis).toBe('estimated_segment');
    expect(await new SyncOutboxRepository(ctx).pendingCount()).toBe(1);
  });

  it('recovers an interrupted recording from SQLite after a crash', async () => {
    const { ctx, clock } = await setup();
    const bridge = new FakeBridge();
    const store = new SqliteRecordingStore(ctx);
    const c1 = new RecordingCoordinator({
      bridge,
      store,
      clock: { now: () => clock.t },
      newId: ctx.newId,
      timezone: () => 'UTC',
      userId: () => null,
    });
    await c1.prepare('running');
    const { activityId } = (await c1.start()) as { activityId: string };
    const t = straightTrack({ speedMps: 3, durationSeconds: 300 });
    bridge.emit(t.slice(0, 150));
    await (c1 as unknown as { queue: Promise<unknown> }).queue;
    clock.t = T0 + 150_000;
    await c1.pause();
    c1.dispose(); // process killed

    clock.t = T0 + 400_000;
    const c2 = new RecordingCoordinator({
      bridge,
      store,
      clock: { now: () => clock.t },
      newId: ctx.newId,
      timezone: () => 'UTC',
      userId: () => null,
    });
    expect(await c2.recover()).toEqual({ recovered: true, activityId, status: 'PAUSED' });
    expect(c2.snapshot()!.movingMs).toBe(150_000);
    await c2.resume();
    bridge.emit(t.slice(150).map((s) => ({ ...s, recordedAt: s.recordedAt + 250_000 })));
    clock.t = T0 + 550_000;
    const summary = await c2.finish();
    expect(summary.metrics.movingDurationMs).toBe(300_000);
    expect(await new RouteRepository(ctx).rawCount(activityId)).toBe(301);
  });
});

describe('activity history', () => {
  it('lists, filters, searches, edits and soft-deletes', async () => {
    const { ctx, clock } = await setup();
    const bridge = new FakeBridge();
    const run1 = await recordRun(ctx, clock, bridge, { speed: 3, seconds: 400, startTime: T0 });
    const ride = await recordRun(ctx, clock, bridge, {
      speed: 8,
      seconds: 400,
      startTime: T0 + 86_400_000,
      sport: 'cycling',
    });
    const run2 = await recordRun(ctx, clock, bridge, {
      speed: 3.3,
      seconds: 400,
      startTime: T0 + 2 * 86_400_000,
    });
    const repo = new ActivityRepository(ctx);

    expect((await repo.list()).items.map((a) => a.id)).toEqual([run2, ride, run1]);
    expect((await repo.list({ sort: 'oldest', limit: 1 })).items[0]!.id).toBe(run1);
    expect((await repo.list({ sportTypes: ['cycling'] })).total).toBe(1);
    expect((await repo.list({ from: T0 + 86_400_000 })).total).toBe(2);

    const edited = await repo.updateDetails(run1, {
      title: 'Track 100%_session',
      description: 'Intervals',
    });
    expect(edited.version).toBeGreaterThan(1);
    expect((await repo.list({ search: '100%_' })).items.map((a) => a.id)).toEqual([run1]);
    expect((await repo.list({ search: '%' })).total).toBe(1);
    expect((await repo.list({ search: 'intervals' })).total).toBe(1);

    const prsBefore = await new PersonalRecordRepository(ctx).list();
    expect(
      prsBefore.find((p) => p.metricType === 'fastest_1k' && p.sportType === 'running')!.activityId,
    ).toBe(run2);
    await repo.softDelete(run2);
    expect((await repo.list()).total).toBe(2);
    expect(await new RouteRepository(ctx).rawCount(run2)).toBe(0);
    const prsAfter = await new PersonalRecordRepository(ctx).list();
    expect(
      prsAfter.find((p) => p.metricType === 'fastest_1k' && p.sportType === 'running')!.activityId,
    ).toBe(run1);
    const outbox = await new SyncOutboxRepository(ctx).due(100);
    expect(outbox.some((e) => e.entityId === run2 && e.operation === 'delete')).toBe(true);
  });
});

describe('goals and settings', () => {
  it('creates, updates and removes goals', async () => {
    const { ctx } = await setup();
    const goals = new GoalRepository(ctx);
    const g = await goals.create({
      sportType: 'running',
      goalType: 'distance',
      targetValue: 30_000,
      period: 'week',
    });
    await goals.update(g.id, { targetValue: 40_000 });
    expect((await goals.list())[0]!.targetValue).toBe(40_000);
    await goals.remove(g.id);
    expect(await goals.list()).toHaveLength(0);
  });
});
