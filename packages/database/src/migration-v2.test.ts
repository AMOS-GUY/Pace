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
 * Migration 2 rebuilds `activities` (SQLite cannot alter its CHECK constraint). These tests
 * build a populated version-1 database the way a real device has it, migrate it and check that
 * nothing was lost — in particular that no child row was cascade-deleted by DROP TABLE.
 */

const CHILD_TABLES = [
  'route_points',
  'recording_events',
  'processed_routes',
  'activity_splits',
  'record_candidates',
  'personal_records',
  'sync_outbox',
] as const;

async function v1DatabaseWithActivities(): Promise<DatabaseContext> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db, MIGRATIONS.slice(0, 1));
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
    await c.finish();
    c.dispose();
  }
  await db.run(
    "INSERT INTO sensor_samples (id, activity_id, sensor_type, value, unit, recorded_at) SELECT 's1', id, 'heart_rate', 150, 'bpm', started_at FROM activities LIMIT 1",
  );
  await db.run(
    "INSERT INTO laps (id, activity_id, sequence_number, started_at, duration_ms, distance_meters) SELECT 'l1', id, 0, started_at, 1000, 10 FROM activities LIMIT 1",
  );
  return ctx;
}

async function snapshot(ctx: DatabaseContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    activities: await ctx.db.all('SELECT * FROM activities ORDER BY id'),
    laps: await ctx.db.all('SELECT * FROM laps ORDER BY id'),
    sensor_samples: await ctx.db.all('SELECT * FROM sensor_samples ORDER BY id'),
  };
  for (const t of CHILD_TABLES)
    out[t] = (await ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
  return out;
}

describe('migration 2 (activity source imported_tcx)', () => {
  it('keeps every activity, column and child row of a populated v1 database', async () => {
    const ctx = await v1DatabaseWithActivities();
    const before = await snapshot(ctx);
    for (const t of CHILD_TABLES) expect(before[t]).toBeGreaterThan(0);

    const r = await migrate(ctx.db, MIGRATIONS.slice(0, 2));
    expect(r).toEqual({ fromVersion: 1, toVersion: 2, applied: [2] });
    expect(await snapshot(ctx)).toEqual(before);
    expect(await ctx.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('restores foreign-key enforcement and recreates the indexes', async () => {
    const ctx = await v1DatabaseWithActivities();
    await migrate(ctx.db, MIGRATIONS.slice(0, 2));
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
    // Deleting an activity still cascades to its children.
    const id = (await ctx.db.get<{ id: string }>('SELECT id FROM activities LIMIT 1'))!.id;
    await ctx.db.run('DELETE FROM activities WHERE id = ?', [id]);
    expect(
      (await ctx.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM route_points WHERE activity_id = ?',
        [id],
      ))!.n,
    ).toBe(0);
  });

  it('accepts the new source value and still rejects unknown ones', async () => {
    const ctx = await v1DatabaseWithActivities();
    const insert = (id: string, source: string) =>
      ctx.db.run(
        `INSERT INTO activities (id, sport_type, title, started_at, timezone, status, source, created_at, updated_at)
         VALUES (?, 'running', 't', 0, 'UTC', 'completed', ?, 0, 0)`,
        [id, source],
      );
    await expect(insert('before', 'imported_tcx')).rejects.toThrow(/CHECK/);
    await migrate(ctx.db, MIGRATIONS.slice(0, 2));
    await insert('after', 'imported_tcx');
    await expect(insert('bad', 'imported_fit')).rejects.toThrow(/CHECK/);
  });

  it('rolls back and keeps v1 intact if the rebuild would break foreign keys', async () => {
    const ctx = await v1DatabaseWithActivities();
    const before = await snapshot(ctx);
    // A copy that silently loses a row must be refused by the foreign-key check.
    const lossy = [
      MIGRATIONS[0]!,
      {
        ...MIGRATIONS[1]!,
        statements: MIGRATIONS[1]!.statements.map((s) =>
          s.startsWith('INSERT INTO activities_v2') ? `${s} WHERE sport_type = 'running'` : s,
        ),
      },
    ];
    await expect(migrate(ctx.db, lossy)).rejects.toThrow(/foreign-key violation/);
    expect(await snapshot(ctx)).toEqual(before);
    expect(
      (await ctx.db.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations'))!.v,
    ).toBe(1);
    expect((await ctx.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))!.foreign_keys).toBe(
      1,
    );
  });
});
