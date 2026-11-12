import { SPORT_TYPES } from '@pace/domain';
import type { SqlDriver } from './driver';

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
  /**
   * Run with foreign-key enforcement off (needed to rebuild a parent table without cascading
   * deletes). The runner restores the previous setting and refuses to commit if
   * `PRAGMA foreign_key_check` reports any violation.
   */
  disableForeignKeys?: boolean;
}

const sportCheck = `CHECK (sport_type IN (${SPORT_TYPES.map((s) => `'${s}'`).join(',')}))`;

/** Every column of `activities` as created by migration 1 (copied verbatim by rebuilds). */
const ACTIVITY_COLUMNS_V1 = [
  'id',
  'user_id',
  'sport_type',
  'title',
  'description',
  'started_at',
  'ended_at',
  'timezone',
  'status',
  'source',
  'swim_mode',
  'pool_length_meters',
  'elapsed_duration_ms',
  'moving_duration_ms',
  'distance_meters',
  'elevation_gain_meters',
  'elevation_loss_meters',
  'average_speed_mps',
  'maximum_speed_mps',
  'average_pace_ms_per_km',
  'session_config',
  'has_reliable_track',
  'external_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'version',
].join(', ');

/**
 * Local schema. Rules:
 * - migrations are append-only and never lose user data (a table rebuild copies every row and
 *   column and is verified by a foreign-key check);
 * - every measurement column carries its unit in the name;
 * - timestamps are UTC epoch milliseconds (INTEGER); the activity keeps its IANA time zone.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      `CREATE TABLE activities (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT,
        sport_type TEXT NOT NULL ${sportCheck},
        title TEXT NOT NULL,
        description TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('recording','paused','interrupted','completed','discarded')),
        source TEXT NOT NULL CHECK (source IN ('recorded','imported_gpx','imported_backup','manual','healthkit')),
        swim_mode TEXT CHECK (swim_mode IS NULL OR swim_mode IN ('pool','open_water')),
        pool_length_meters REAL,
        elapsed_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_duration_ms >= 0),
        moving_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (moving_duration_ms >= 0),
        distance_meters REAL NOT NULL DEFAULT 0 CHECK (distance_meters >= 0),
        elevation_gain_meters REAL NOT NULL DEFAULT 0,
        elevation_loss_meters REAL NOT NULL DEFAULT 0,
        average_speed_mps REAL,
        maximum_speed_mps REAL,
        average_pace_ms_per_km REAL,
        session_config TEXT,
        has_reliable_track INTEGER NOT NULL DEFAULT 0,
        external_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      'CREATE INDEX idx_activities_history ON activities (deleted_at, started_at DESC)',
      'CREATE INDEX idx_activities_sport ON activities (sport_type, started_at DESC)',
      'CREATE INDEX idx_activities_status ON activities (status)',
      'CREATE UNIQUE INDEX idx_activities_external ON activities (external_id) WHERE external_id IS NOT NULL',

      // Raw samples exactly as captured. Natural key (activity_id, sequence_number) makes
      // inserts idempotent and keeps the largest table compact (WITHOUT ROWID).
      `CREATE TABLE route_points (
        activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude_meters REAL,
        horizontal_accuracy_meters REAL NOT NULL,
        vertical_accuracy_meters REAL,
        speed_mps REAL,
        course_degrees REAL,
        recorded_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (activity_id, sequence_number)
      ) WITHOUT ROWID`,

      `CREATE TABLE recording_events (
        activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        sequence_number INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        after_sample_count INTEGER NOT NULL,
        payload TEXT,
        PRIMARY KEY (activity_id, sequence_number)
      ) WITHOUT ROWID`,

      // Derived geometry, separate from raw samples. Rebuildable from raw data at any time.
      `CREATE TABLE processed_routes (
        activity_id TEXT PRIMARY KEY NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        algorithm_version INTEGER NOT NULL,
        segments_polyline TEXT NOT NULL,
        display_polyline TEXT NOT NULL,
        min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
        gaps TEXT NOT NULL,
        accepted_sample_count INTEGER NOT NULL,
        rejected_sample_count INTEGER NOT NULL
      )`,

      `CREATE TABLE laps (
        id TEXT PRIMARY KEY NOT NULL,
        activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        sequence_number INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        distance_meters REAL NOT NULL,
        average_pace_ms_per_km REAL,
        average_speed_mps REAL,
        length_count INTEGER,
        UNIQUE (activity_id, sequence_number)
      )`,

      `CREATE TABLE activity_segments (
        id TEXT PRIMARY KEY NOT NULL,
        parent_activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        segment_type TEXT NOT NULL CHECK (segment_type IN ('swim','transition_1','bike','transition_2','run')),
        sequence_number INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        elapsed_duration_ms INTEGER NOT NULL,
        moving_duration_ms INTEGER NOT NULL,
        distance_meters REAL NOT NULL,
        elevation_gain_meters REAL NOT NULL,
        UNIQUE (parent_activity_id, sequence_number)
      )`,

      `CREATE TABLE activity_splits (
        activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        split_index INTEGER NOT NULL,
        distance_meters REAL NOT NULL,
        moving_duration_ms REAL NOT NULL,
        pace_ms_per_km REAL,
        speed_mps REAL,
        elevation_gain_meters REAL NOT NULL,
        is_partial INTEGER NOT NULL,
        PRIMARY KEY (activity_id, split_index)
      ) WITHOUT ROWID`,

      `CREATE TABLE sensor_samples (
        id TEXT PRIMARY KEY NOT NULL,
        activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        sensor_type TEXT NOT NULL CHECK (sensor_type IN ('heart_rate','cadence','power')),
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        source_device_id TEXT
      )`,
      'CREATE INDEX idx_sensor_samples_activity ON sensor_samples (activity_id, recorded_at)',

      // Per-activity record candidates; personal_records are the best of these.
      `CREATE TABLE record_candidates (
        activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        sport_type TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        basis TEXT NOT NULL,
        achieved_at INTEGER NOT NULL,
        PRIMARY KEY (activity_id, metric_type)
      )`,
      'CREATE INDEX idx_record_candidates_metric ON record_candidates (sport_type, metric_type)',

      `CREATE TABLE personal_records (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT,
        sport_type TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        basis TEXT NOT NULL,
        activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
        achieved_at INTEGER NOT NULL,
        UNIQUE (sport_type, metric_type)
      )`,

      `CREATE TABLE training_goals (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT,
        sport_type TEXT,
        goal_type TEXT NOT NULL CHECK (goal_type IN ('distance','activity_count','duration')),
        target_value REAL NOT NULL CHECK (target_value > 0),
        period TEXT NOT NULL CHECK (period IN ('week','month')),
        start_date TEXT,
        end_date TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,

      `CREATE TABLE devices (
        id TEXT PRIMARY KEY NOT NULL,
        device_type TEXT NOT NULL,
        manufacturer TEXT,
        model TEXT,
        external_identifier TEXT NOT NULL UNIQUE,
        last_connected_at INTEGER
      )`,

      `CREATE TABLE sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
        entity_version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_sync_outbox_due ON sync_outbox (next_attempt_at)',

      `CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // SQLite cannot alter a CHECK constraint, so `activities` is rebuilt with the extended
    // `source` list. The runner disables foreign-key enforcement for this migration only:
    // with it on, DROP TABLE would cascade-delete every route point, lap and record. Every
    // column and row is copied, indexes are recreated, and the runner verifies
    // `PRAGMA foreign_key_check` before committing.
    version: 2,
    name: 'activity_source_imported_tcx',
    disableForeignKeys: true,
    statements: [
      `CREATE TABLE activities_v2 (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT,
        sport_type TEXT NOT NULL ${sportCheck},
        title TEXT NOT NULL,
        description TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('recording','paused','interrupted','completed','discarded')),
        source TEXT NOT NULL CHECK (source IN ('recorded','imported_gpx','imported_tcx','imported_backup','manual','healthkit')),
        swim_mode TEXT CHECK (swim_mode IS NULL OR swim_mode IN ('pool','open_water')),
        pool_length_meters REAL,
        elapsed_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_duration_ms >= 0),
        moving_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (moving_duration_ms >= 0),
        distance_meters REAL NOT NULL DEFAULT 0 CHECK (distance_meters >= 0),
        elevation_gain_meters REAL NOT NULL DEFAULT 0,
        elevation_loss_meters REAL NOT NULL DEFAULT 0,
        average_speed_mps REAL,
        maximum_speed_mps REAL,
        average_pace_ms_per_km REAL,
        session_config TEXT,
        has_reliable_track INTEGER NOT NULL DEFAULT 0,
        external_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `INSERT INTO activities_v2 (${ACTIVITY_COLUMNS_V1}) SELECT ${ACTIVITY_COLUMNS_V1} FROM activities`,
      'DROP TABLE activities',
      'ALTER TABLE activities_v2 RENAME TO activities',
      'CREATE INDEX idx_activities_history ON activities (deleted_at, started_at DESC)',
      'CREATE INDEX idx_activities_sport ON activities (sport_type, started_at DESC)',
      'CREATE INDEX idx_activities_status ON activities (status)',
      'CREATE UNIQUE INDEX idx_activities_external ON activities (external_id) WHERE external_id IS NOT NULL',
    ],
  },
];

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

/**
 * Applies pending migrations, each in its own transaction, recording them in schema_migrations.
 * Refuses to run against a database created by a newer app version (downgrade protection).
 */
export async function migrate(
  db: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => number = Date.now,
): Promise<MigrationResult> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const row = await db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  const current = row?.v ?? 0;
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(
        `Migrations must be contiguous from 1; found ${m.version} at position ${i + 1}`,
      );
  });
  const latest = sorted[sorted.length - 1]?.version ?? 0;
  if (current > latest) {
    throw new Error(
      `Database schema v${current} is newer than this app supports (v${latest}). Update the app.`,
    );
  }
  const applied: number[] = [];
  for (const m of sorted) {
    if (m.version <= current) continue;
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it.
    const fkWasOn = m.disableForeignKeys
      ? ((await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys ?? 0) === 1
      : false;
    if (m.disableForeignKeys) await db.exec('PRAGMA foreign_keys = OFF');
    try {
      await db.transaction(async (tx) => {
        for (const s of m.statements) await tx.exec(s);
        if (m.disableForeignKeys) {
          const violations = await tx.all('PRAGMA foreign_key_check');
          if (violations.length > 0)
            throw new Error(
              `Migration ${m.version} (${m.name}) would leave ${violations.length} foreign-key violation(s); rolled back`,
            );
        }
        await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          m.version,
          m.name,
          now(),
        ]);
      });
    } finally {
      if (m.disableForeignKeys && fkWasOn) await db.exec('PRAGMA foreign_keys = ON');
    }
    applied.push(m.version);
  }
  return { fromVersion: current, toVersion: Math.max(current, latest), applied };
}

/** Per-connection pragmas. Must run outside a transaction, before migrations. */
export async function configureConnection(db: SqlDriver): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON');
  await db.exec('PRAGMA journal_mode = WAL');
  // FULL: a committed GPS batch survives power loss, not just an app crash.
  await db.exec('PRAGMA synchronous = FULL');
}
