/**
 * Runs the real PACE import pipeline (ActivityService.importTrack → RecordingSession →
 * writeCompletedActivity) against a fresh in-memory database and reads back what PACE stored.
 * Nothing touches the app's data or the disk.
 */
import { ActivityService, ImportError } from '@pace/core';
import { type DatabaseContext, configureConnection, migrate } from '@pace/database';
import type { ImportedSensorSample, ParsedTrack } from '@pace/formats';
import { MemorySqliteDriver } from './sqlite';

export interface StoredLap {
  startedAt: number;
  durationSeconds: number;
  distanceMeters: number;
}

export interface StoredPause {
  pausedAt: number;
  resumedAt: number;
}

/** PACE's final imported activity, as stored. */
export interface ActivityMetrics {
  sport: string;
  startedAt: number;
  endedAt: number | null;
  elapsedSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  laps: StoredLap[];
  pauses: StoredPause[];
  legs: Array<{ type: string; startedAt: number }>;
  pointTimes: number[];
  sensors: Array<Pick<ImportedSensorSample, 'type' | 'value' | 'recordedAt' | 'unit'>>;
}

export type PipelineResult =
  | { ok: true; activityId: string; metrics: ActivityMetrics; warnings: string[] }
  | { ok: false; code: ImportError['code']; message: string };

export async function memoryDatabase(): Promise<DatabaseContext & { close(): void }> {
  const db = new MemorySqliteDriver();
  await configureConnection(db);
  await migrate(db);
  let n = 0;
  return {
    db,
    now: () => Date.now(),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    close: () => db.close(),
  };
}

export async function readMetrics(ctx: DatabaseContext, id: string): Promise<ActivityMetrics> {
  const a = await ctx.db.get<{
    sport_type: string;
    started_at: number;
    ended_at: number | null;
    elapsed_duration_ms: number;
    moving_duration_ms: number;
    distance_meters: number;
  }>(
    'SELECT sport_type, started_at, ended_at, elapsed_duration_ms, moving_duration_ms, distance_meters FROM activities WHERE id = ?',
    [id],
  );
  if (!a) throw new Error('The imported activity was not stored');
  const laps = await ctx.db.all<{
    started_at: number;
    duration_ms: number;
    distance_meters: number;
  }>(
    'SELECT started_at, duration_ms, distance_meters FROM laps WHERE activity_id = ? ORDER BY sequence_number',
    [id],
  );
  const events = await ctx.db.all<{ event_type: string; occurred_at: number }>(
    'SELECT event_type, occurred_at FROM recording_events WHERE activity_id = ? ORDER BY sequence_number',
    [id],
  );
  const pauses: StoredPause[] = [];
  let pausedAt: number | null = null;
  for (const e of events) {
    if (e.event_type === 'paused' || e.event_type === 'auto_paused') pausedAt ??= e.occurred_at;
    else if ((e.event_type === 'resumed' || e.event_type === 'auto_resumed') && pausedAt != null) {
      pauses.push({ pausedAt, resumedAt: e.occurred_at });
      pausedAt = null;
    }
  }
  const legs = await ctx.db.all<{ segment_type: string; started_at: number }>(
    'SELECT segment_type, started_at FROM activity_segments WHERE parent_activity_id = ? ORDER BY sequence_number',
    [id],
  );
  const points = await ctx.db.all<{ recorded_at: number }>(
    'SELECT recorded_at FROM route_points WHERE activity_id = ? ORDER BY sequence_number',
    [id],
  );
  const sensors = await ctx.db.all<{
    sensor_type: ImportedSensorSample['type'];
    value: number;
    unit: ImportedSensorSample['unit'];
    recorded_at: number;
  }>(
    'SELECT sensor_type, value, unit, recorded_at FROM sensor_samples WHERE activity_id = ? ORDER BY recorded_at, sensor_type',
    [id],
  );
  return {
    sport: a.sport_type,
    startedAt: a.started_at,
    endedAt: a.ended_at,
    elapsedSeconds: a.elapsed_duration_ms / 1000,
    movingSeconds: a.moving_duration_ms / 1000,
    distanceMeters: a.distance_meters,
    laps: laps.map((l) => ({
      startedAt: l.started_at,
      durationSeconds: l.duration_ms / 1000,
      distanceMeters: l.distance_meters,
    })),
    pauses,
    legs: legs.map((l) => ({ type: l.segment_type, startedAt: l.started_at })),
    pointTimes: points.map((p) => p.recorded_at),
    sensors: sensors.map((s) => ({
      type: s.sensor_type,
      value: s.value,
      unit: s.unit,
      recordedAt: s.recorded_at,
    })),
  };
}

/**
 * Imports one parsed track into `ctx` (a fresh database when omitted) and reads it back.
 *
 * `sportForUnknown` is used only when the file itself names no sport. It is exactly what the
 * app does after the athlete chooses a sport for such a file (`ImportOptions.sportType`, as in
 * bulk import's fallback sport), so the import logic is unchanged. A file that names its own
 * sport is never overridden.
 */
export async function importAndMeasure(
  track: ParsedTrack,
  ctx?: DatabaseContext,
  sportForUnknown?: ParsedTrack['sportType'],
): Promise<PipelineResult> {
  const own = ctx ? null : await memoryDatabase();
  const db = ctx ?? own!;
  try {
    const r = await new ActivityService(db).importTrack(track, {
      timezone: 'UTC',
      userId: null,
      ...(track.sportType == null && sportForUnknown ? { sportType: sportForUnknown } : {}),
    });
    return {
      ok: true,
      activityId: r.activityId,
      metrics: await readMetrics(db, r.activityId),
      warnings: r.warnings,
    };
  } catch (e) {
    if (e instanceof ImportError) return { ok: false, code: e.code, message: e.message };
    throw e;
  } finally {
    own?.close();
  }
}
