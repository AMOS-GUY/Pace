import type {
  NewRecording,
  RecordedEvent,
  RecordingBatch,
  RecordingStore,
  SessionConfig,
  SessionEvent,
  SessionSummary,
} from '@pace/activity-engine';
import type { LocationSample, SportType } from '@pace/domain';
import { computeBounds, encodePolyline, simplifyRoute } from '@pace/gps-engine';
import { recordCandidatesForActivity } from '@pace/metrics-engine';
import { getSport } from '@pace/sports';
import { type SqlDriver, insertMany } from './driver';
import { ROUTE_POINT_COLUMNS, type RoutePointRow, sampleValues, toSample } from './mappers';
import { type DatabaseContext, enqueueOutbox, recomputePersonalRecords } from './repositories';

/** Bump when RouteProcessor output changes so processed routes can be rebuilt from raw data. */
export const ROUTE_ALGORITHM_VERSION = 1;

/** SQLite implementation of the activity-engine RecordingStore port. */
export class SqliteRecordingStore implements RecordingStore {
  constructor(private readonly ctx: DatabaseContext) {}

  async createRecording(input: NewRecording): Promise<void> {
    const now = this.ctx.now();
    const a = input.activity;
    await this.ctx.db.run(
      `INSERT INTO activities (id, user_id, sport_type, title, description, started_at, ended_at, timezone, status, source,
         swim_mode, pool_length_meters, session_config, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 'recording', 'recorded', ?, ?, ?, ?, ?, 1)`,
      [
        a.id,
        a.userId,
        a.sportType,
        a.title,
        a.startedAt,
        a.timezone,
        a.swimMode,
        a.poolLengthMeters,
        JSON.stringify(input.config),
        now,
        now,
      ],
    );
  }

  async appendRecording(activityId: string, batch: RecordingBatch): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      await insertMany(
        tx,
        'route_points',
        ROUTE_POINT_COLUMNS,
        batch.samples.map((s) => sampleValues(activityId, s.sequenceNumber, s.sample)),
        { onConflict: 'ignore' },
      );
      if (batch.events.length > 0) {
        const next =
          (
            await tx.get<{ n: number }>(
              'SELECT COUNT(*) AS n FROM recording_events WHERE activity_id = ?',
              [activityId],
            )
          )?.n ?? 0;
        await insertMany(
          tx,
          'recording_events',
          [
            'activity_id',
            'sequence_number',
            'event_type',
            'occurred_at',
            'after_sample_count',
            'payload',
          ],
          batch.events.map((e, i) => [
            activityId,
            next + i,
            e.event.type,
            e.event.at,
            e.afterSampleCount,
            eventPayload(e.event),
          ]),
        );
      }
      const m = batch.metrics;
      await tx.run(
        `UPDATE activities SET status = ?, elapsed_duration_ms = ?, moving_duration_ms = ?, distance_meters = ?,
           elevation_gain_meters = ?, average_speed_mps = ?, maximum_speed_mps = ?, average_pace_ms_per_km = ?, updated_at = ?
         WHERE id = ? AND status IN ('recording','paused','interrupted')`,
        [
          batch.status,
          Math.round(m.elapsedDurationMs),
          Math.round(m.movingDurationMs),
          m.distanceMeters,
          m.elevationGainMeters,
          m.averageSpeedMps,
          m.maximumSpeedMps,
          m.averagePaceMsPerKm,
          this.ctx.now(),
          activityId,
        ],
      );
    });
  }

  async loadRecording(
    activityId: string,
  ): Promise<{ config: SessionConfig; samples: LocationSample[]; events: RecordedEvent[] } | null> {
    const row = await this.ctx.db.get<{ session_config: string | null }>(
      'SELECT session_config FROM activities WHERE id = ?',
      [activityId],
    );
    if (!row?.session_config) return null;
    const samples = (
      await this.ctx.db.all<RoutePointRow>(
        'SELECT * FROM route_points WHERE activity_id = ? ORDER BY sequence_number',
        [activityId],
      )
    ).map(toSample);
    const events = (
      await this.ctx.db.all<{
        event_type: SessionEvent['type'];
        occurred_at: number;
        after_sample_count: number;
        payload: string | null;
      }>(
        'SELECT event_type, occurred_at, after_sample_count, payload FROM recording_events WHERE activity_id = ? ORDER BY sequence_number',
        [activityId],
      )
    ).map((r) => ({
      event: parseEvent(r.event_type, r.occurred_at, r.payload),
      afterSampleCount: r.after_sample_count,
    }));
    return { config: JSON.parse(row.session_config) as SessionConfig, samples, events };
  }

  async findIncompleteRecordingId(): Promise<string | null> {
    const r = await this.ctx.db.get<{ id: string }>(
      `SELECT id FROM activities WHERE status IN ('recording','paused','interrupted') AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    );
    return r?.id ?? null;
  }

  async completeRecording(activityId: string, summary: SessionSummary): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      const a = await tx.get<{ sport_type: SportType }>(
        'SELECT sport_type FROM activities WHERE id = ?',
        [activityId],
      );
      if (!a) throw new Error('Activity not found');
      await writeCompletedActivity(tx, this.ctx, activityId, a.sport_type, summary);
    });
  }

  async discardRecording(activityId: string, at: number): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      await tx.run('DELETE FROM route_points WHERE activity_id = ?', [activityId]);
      await tx.run('DELETE FROM recording_events WHERE activity_id = ?', [activityId]);
      await tx.run(
        "UPDATE activities SET status = 'discarded', deleted_at = ?, updated_at = ? WHERE id = ?",
        [at, at, activityId],
      );
    });
  }
}

/** Serialised event payload (only laps with a pool length count carry one). */
export function eventPayload(e: SessionEvent): string | null {
  return e.type === 'lap' && e.lengthCount != null
    ? JSON.stringify({ lengthCount: e.lengthCount })
    : null;
}

function parseEvent(type: SessionEvent['type'], at: number, payload: string | null): SessionEvent {
  if (type === 'lap') {
    const p = payload ? (JSON.parse(payload) as { lengthCount?: number }) : {};
    return p.lengthCount != null ? { type, at, lengthCount: p.lengthCount } : { type, at };
  }
  return { type, at } as SessionEvent;
}

/**
 * Writes all derived data of a finished activity in the caller's transaction: summary metrics,
 * laps, legs, splits, processed route, record candidates, personal records and the sync outbox.
 */
export async function writeCompletedActivity(
  tx: SqlDriver,
  ctx: DatabaseContext,
  activityId: string,
  sportType: SportType,
  summary: SessionSummary,
): Promise<void> {
  const now = ctx.now();
  const m = summary.metrics;
  await tx.run(
    `UPDATE activities SET status = 'completed', ended_at = ?, elapsed_duration_ms = ?, moving_duration_ms = ?,
       distance_meters = ?, elevation_gain_meters = ?, elevation_loss_meters = ?, average_speed_mps = ?,
       maximum_speed_mps = ?, average_pace_ms_per_km = ?, has_reliable_track = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
    [
      summary.endedAt,
      Math.round(m.elapsedDurationMs),
      Math.round(m.movingDurationMs),
      m.distanceMeters,
      m.elevationGainMeters,
      m.elevationLossMeters,
      m.averageSpeedMps,
      m.maximumSpeedMps,
      m.averagePaceMsPerKm,
      summary.quality.hasReliableTrack ? 1 : 0,
      now,
      activityId,
    ],
  );
  for (const t of ['laps', 'activity_splits', 'processed_routes', 'record_candidates']) {
    await tx.run(`DELETE FROM ${t} WHERE activity_id = ?`, [activityId]);
  }
  await tx.run('DELETE FROM activity_segments WHERE parent_activity_id = ?', [activityId]);

  await insertMany(
    tx,
    'laps',
    [
      'id',
      'activity_id',
      'sequence_number',
      'started_at',
      'duration_ms',
      'distance_meters',
      'average_pace_ms_per_km',
      'average_speed_mps',
      'length_count',
    ],
    summary.laps.map((l) => [
      ctx.newId(),
      activityId,
      l.sequenceNumber,
      l.startedAt,
      Math.round(l.durationMs),
      l.distanceMeters,
      l.averagePaceMsPerKm,
      l.averageSpeedMps,
      l.lengthCount,
    ]),
  );
  await insertMany(
    tx,
    'activity_segments',
    [
      'id',
      'parent_activity_id',
      'segment_type',
      'sequence_number',
      'started_at',
      'ended_at',
      'elapsed_duration_ms',
      'moving_duration_ms',
      'distance_meters',
      'elevation_gain_meters',
    ],
    summary.legs.map((l) => [
      ctx.newId(),
      activityId,
      l.segmentType,
      l.sequenceNumber,
      l.startedAt,
      l.endedAt,
      Math.round(l.elapsedDurationMs),
      Math.round(l.movingDurationMs),
      l.distanceMeters,
      l.elevationGainMeters,
    ]),
  );
  await insertMany(
    tx,
    'activity_splits',
    [
      'activity_id',
      'split_index',
      'distance_meters',
      'moving_duration_ms',
      'pace_ms_per_km',
      'speed_mps',
      'elevation_gain_meters',
      'is_partial',
    ],
    summary.splits.map((s) => [
      activityId,
      s.index,
      s.distanceMeters,
      s.movingDurationMs,
      s.paceMsPerKm,
      s.speedMps,
      s.elevationGainMeters,
      s.isPartial ? 1 : 0,
    ]),
  );

  const segs = summary.route.segments;
  if (segs.some((s) => s.length > 0)) {
    const bounds = computeBounds(segs.flat());
    await tx.run(
      `INSERT INTO processed_routes (activity_id, algorithm_version, segments_polyline, display_polyline, min_latitude, min_longitude,
         max_latitude, max_longitude, gaps, accepted_sample_count, rejected_sample_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activityId,
        ROUTE_ALGORITHM_VERSION,
        JSON.stringify(segs.map((s) => encodePolyline(s, 6))),
        JSON.stringify(segs.map((s) => encodePolyline(simplifyRoute(s, 10), 5))),
        bounds?.minLatitude ?? null,
        bounds?.minLongitude ?? null,
        bounds?.maxLatitude ?? null,
        bounds?.maxLongitude ?? null,
        JSON.stringify(summary.route.gaps),
        summary.quality.acceptedSamples,
        summary.quality.rejectedSamples,
      ],
    );
  }

  const candidates = recordCandidatesForActivity(
    {
      id: activityId,
      sportType,
      startedAt: summary.startedAt,
      distanceMeters: m.distanceMeters,
      movingDurationMs: m.movingDurationMs,
      elevationGainMeters: m.elevationGainMeters,
      status: 'completed',
      deletedAt: null,
    },
    summary.timedPoints,
    getSport(sportType).records,
    { hasReliableTrack: summary.quality.hasReliableTrack },
  );
  await insertMany(
    tx,
    'record_candidates',
    ['activity_id', 'sport_type', 'metric_type', 'value', 'unit', 'basis', 'achieved_at'],
    candidates.map((c) => [
      activityId,
      c.sportType,
      c.metricType,
      c.value,
      c.unit,
      c.basis,
      c.achievedAt,
    ]),
  );
  await recomputePersonalRecords(tx, ctx.newId);
  const v = (await tx.get<{ version: number }>('SELECT version FROM activities WHERE id = ?', [
    activityId,
  ]))!.version;
  await enqueueOutbox(tx, now, {
    entityType: 'activity',
    entityId: activityId,
    operation: 'upsert',
    entityVersion: v,
  });
}
