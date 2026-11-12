import { RecordingCoordinator } from '@pace/activity-engine';
import { FakeBridge } from '../../activity-engine/src/test-fixtures/fakes';
import { T0, straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  type DatabaseContext,
  MIGRATIONS,
  SqliteRecordingStore,
  configureConnection,
  migrate,
} from './index';
import { NodeSqliteDriver } from './test-fixtures/node-sqlite-driver';

/**
 * Migration 3 rebuilds `activities` again (to add the `imported_fit` source) with the
 * procedure proven by migration 2. These tests build a populated version-2 database — recorded
 * activities with every derived table, an imported TCX activity with laps and sensor data, a
 * triathlon with its legs, goals, devices and settings — migrate it and check that nothing was
 * lost or changed.
 */

const CHILD_TABLES = [
  'route_points',
  'recording_events',
  'processed_routes',
  'activity_splits',
  'record_candidates',
  'personal_records',
  'sync_outbox',
  'laps',
  'sensor_samples',
  'activity_segments',
] as const;
const OTHER_TABLES = ['training_goals', 'devices', 'settings'] as const;

async function v2Database(): Promise<DatabaseContext> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db, MIGRATIONS.slice(0, 2));
  const clock = { t: T0 };
  let n = 0;
  const ctx: DatabaseContext = {
    db,
    now: () => clock.t,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
  for (const [i, sport] of (['running', 'cycling'] as const).entries()) {
    const bridge = new FakeBridge();
    const start = T0 + i * 7_200_000;
    clock.t = start;
    const c = new RecordingCoordinator({
      bridge,
      store: new SqliteRecordingStore(ctx),
      clock: { now: () => clock.t },
      newId: ctx.newId,
      timezone: () => 'UTC',
      userId: () => null,
    });
    await c.prepare(sport);
    await c.start();
    bridge.emit(
      straightTrack({
        speedMps: sport === 'cycling' ? 8 : 3,
        durationSeconds: 900,
        startTime: start,
      }),
    );
    clock.t = start + 900_000;
    await c.lap();
    await c.finish();
    c.dispose();
  }
  // An imported TCX activity (allowed since v2) and a triathlon with its five legs.
  const insertActivity = (id: string, sport: string, source: string, startedAt: number) =>
    db.run(
      `INSERT INTO activities (id, sport_type, title, description, started_at, ended_at, timezone, status, source,
         elapsed_duration_ms, moving_duration_ms, distance_meters, external_id, created_at, updated_at, version)
       VALUES (?, ?, 'Imported', 'notes', ?, ?, 'Europe/Zurich', 'completed', ?, 3600000, 3500000, 10000, ?, 1, 2, 3)`,
      [id, sport, startedAt, startedAt + 3_600_000, source, `ext-${id}`],
    );
  await insertActivity('tcx-1', 'running', 'imported_tcx', T0 + 86_400_000);
  await insertActivity('tri-1', 'triathlon', 'recorded', T0 + 2 * 86_400_000);
  for (const [i, type] of ['swim', 'transition_1', 'bike', 'transition_2', 'run'].entries())
    await db.run(
      `INSERT INTO activity_segments (id, parent_activity_id, segment_type, sequence_number, started_at, ended_at,
         elapsed_duration_ms, moving_duration_ms, distance_meters, elevation_gain_meters)
       VALUES (?, 'tri-1', ?, ?, ?, ?, 600000, 590000, 1000, 5)`,
      [`seg-${i}`, type, i, T0 + i * 600_000, T0 + (i + 1) * 600_000],
    );
  for (let i = 0; i < 50; i++)
    await db.run(
      "INSERT INTO sensor_samples (id, activity_id, sensor_type, value, unit, recorded_at) VALUES (?, 'tcx-1', ?, ?, ?, ?)",
      [
        `s-${i}`,
        ['heart_rate', 'cadence', 'power'][i % 3]!,
        100 + i,
        ['bpm', 'rpm', 'W'][i % 3]!,
        T0 + i * 1000,
      ],
    );
  await db.run(
    "INSERT INTO laps (id, activity_id, sequence_number, started_at, duration_ms, distance_meters) VALUES ('l-tcx', 'tcx-1', 0, ?, 1000, 10)",
    [T0 + 86_400_000],
  );
  await db.run(
    "INSERT INTO training_goals (id, goal_type, target_value, period, created_at, updated_at) VALUES ('g1', 'distance', 50000, 'week', 1, 1)",
  );
  await db.run(
    "INSERT INTO devices (id, device_type, external_identifier) VALUES ('d1', 'heart_rate', 'strap-1')",
  );
  await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('preferences', '{}', 1)");
  return ctx;
}

async function snapshot(ctx: DatabaseContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    activities: await ctx.db.all('SELECT * FROM activities ORDER BY id'),
  };
  for (const t of [...CHILD_TABLES, ...OTHER_TABLES])
    out[t] = await ctx.db.all(`SELECT * FROM ${t} ORDER BY 1, 2`);
  return out;
}

describe('migration 3 (activity source imported_fit)', () => {
  it('keeps every activity, column and child row of a populated v2 database', async () => {
    const ctx = await v2Database();
    const before = await snapshot(ctx);
    for (const t of [...CHILD_TABLES, ...OTHER_TABLES])
      expect((before[t] as unknown[]).length).toBeGreaterThan(0);
    expect((before.activities as unknown[]).length).toBe(4);

    const r = await migrate(ctx.db);
    expect(r).toEqual({ fromVersion: 2, toVersion: 3, applied: [3] });
    expect(await snapshot(ctx)).toEqual(before);
    expect(await ctx.db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(await ctx.db.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it('migrates a v1 database through 2 and 3 in one go', async () => {
    const db = new NodeSqliteDriver();
    await configureConnection(db);
    await migrate(db, MIGRATIONS.slice(0, 1));
    expect(await migrate(db)).toEqual({ fromVersion: 1, toVersion: 3, applied: [2, 3] });
  });

  it('restores foreign-key enforcement, keeps cascades and recreates the indexes', async () => {
    const ctx = await v2Database();
    await migrate(ctx.db);
    expect((await ctx.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))!.foreign_keys).toBe(
      1,
    );
    await expect(
      ctx.db.run(
        "INSERT INTO laps (id, activity_id, sequence_number, started_at, duration_ms, distance_meters) VALUES ('x', 'missing', 0, 0, 0, 0)",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    const indexes = (
      await ctx.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activities' AND name LIKE 'idx_%' ORDER BY name",
      )
    ).map((i) => i.name);
    expect(indexes).toEqual([
      'idx_activities_external',
      'idx_activities_history',
      'idx_activities_sport',
      'idx_activities_status',
    ]);
    await expect(
      ctx.db.run(
        `INSERT INTO activities (id, sport_type, title, started_at, timezone, status, source, external_id, created_at, updated_at)
         VALUES ('dup', 'running', 't', 0, 'UTC', 'completed', 'imported_fit', 'ext-tcx-1', 0, 0)`,
      ),
    ).rejects.toThrow(/UNIQUE/);
    await ctx.db.run("DELETE FROM activities WHERE id = 'tri-1'");
    expect(
      (await ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM activity_segments WHERE parent_activity_id = 'tri-1'",
      ))!.n,
    ).toBe(0);
  });

  it('accepts imported_fit and still rejects unknown sources', async () => {
    const ctx = await v2Database();
    const insert = (id: string, source: string) =>
      ctx.db.run(
        `INSERT INTO activities (id, sport_type, title, started_at, timezone, status, source, created_at, updated_at)
         VALUES (?, 'running', 't', 0, 'UTC', 'completed', ?, 0, 0)`,
        [id, source],
      );
    await expect(insert('before', 'imported_fit')).rejects.toThrow(/CHECK/);
    await migrate(ctx.db);
    await insert('after', 'imported_fit');
    for (const s of [
      'recorded',
      'imported_gpx',
      'imported_tcx',
      'imported_backup',
      'manual',
      'healthkit',
    ])
      await insert(`ok-${s}`, s);
    await expect(insert('bad', 'imported_zwift')).rejects.toThrow(/CHECK/);
  });

  it('rolls back and keeps v2 intact if the rebuild would lose rows', async () => {
    const ctx = await v2Database();
    const before = await snapshot(ctx);
    const lossy = [
      ...MIGRATIONS.slice(0, 2),
      {
        ...MIGRATIONS[2]!,
        statements: MIGRATIONS[2]!.statements.map((s) =>
          s.startsWith('INSERT INTO activities_v3') ? `${s} WHERE sport_type <> 'triathlon'` : s,
        ),
      },
    ];
    await expect(migrate(ctx.db, lossy)).rejects.toThrow(/foreign-key violation/);
    expect(await snapshot(ctx)).toEqual(before);
    expect(
      (await ctx.db.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations'))!.v,
    ).toBe(2);
    expect((await ctx.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))!.foreign_keys).toBe(
      1,
    );
  });
});
