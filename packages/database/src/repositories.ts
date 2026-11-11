import type {
  Activity,
  ActivitySegment,
  Lap,
  LocationSample,
  PersonalRecord,
  SportType,
  Split,
  TrainingGoal,
} from '@pace/domain';
import { type RecordCandidate, bestRecords } from '@pace/metrics-engine';
import type { SqlDriver, SqlValue } from './driver';
import {
  ACTIVITY_COLUMNS,
  type ActivityRow,
  type GoalRow,
  type LapRow,
  type RecordRow,
  type RoutePointRow,
  type SegmentRow,
  type SplitRow,
  toActivity,
  toGoal,
  toLap,
  toRecord,
  toSample,
  toSegment,
  toSplit,
} from './mappers';

export interface DatabaseContext {
  db: SqlDriver;
  now: () => number;
  newId: () => string;
}

// ============================================================================ outbox

export type OutboxEntityType = 'activity' | 'goal' | 'profile';

export interface OutboxEntry {
  id: number;
  entityType: OutboxEntityType;
  entityId: string;
  operation: 'upsert' | 'delete';
  entityVersion: number;
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

/** Enqueue inside the same transaction as the change it describes (transactional outbox). */
export async function enqueueOutbox(
  tx: SqlDriver,
  now: number,
  e: {
    entityType: OutboxEntityType;
    entityId: string;
    operation: 'upsert' | 'delete';
    entityVersion: number;
  },
): Promise<void> {
  // Idempotency key is stable per (entity, version, op): retries and re-enqueues dedupe.
  const key = `${e.entityType}:${e.entityId}:${e.entityVersion}:${e.operation}`;
  await tx.run(
    `INSERT OR IGNORE INTO sync_outbox (entity_type, entity_id, operation, entity_version, idempotency_key, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [e.entityType, e.entityId, e.operation, e.entityVersion, key, now, now],
  );
}

export class SyncOutboxRepository {
  constructor(private readonly ctx: DatabaseContext) {}

  async due(limit = 20): Promise<OutboxEntry[]> {
    const rows = await this.ctx.db.all<{
      id: number;
      entity_type: OutboxEntityType;
      entity_id: string;
      operation: 'upsert' | 'delete';
      entity_version: number;
      idempotency_key: string;
      attempts: number;
      next_attempt_at: number;
      last_error: string | null;
    }>('SELECT * FROM sync_outbox WHERE next_attempt_at <= ? ORDER BY id LIMIT ?', [
      this.ctx.now(),
      limit,
    ]);
    return rows.map((r) => ({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      operation: r.operation,
      entityVersion: r.entity_version,
      idempotencyKey: r.idempotency_key,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastError: r.last_error,
    }));
  }
  async pendingCount(): Promise<number> {
    return (await this.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox'))?.n ?? 0;
  }
  async complete(id: number): Promise<void> {
    await this.ctx.db.run('DELETE FROM sync_outbox WHERE id = ?', [id]);
  }
  async fail(id: number, nextAttemptAt: number, error: string): Promise<void> {
    await this.ctx.db.run(
      'UPDATE sync_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?',
      [nextAttemptAt, error.slice(0, 500), id],
    );
  }
}

// ============================================================================ activities

export interface ActivityQuery {
  sportTypes?: readonly SportType[];
  /** Inclusive lower / exclusive upper bound on started_at (epoch ms). */
  from?: number;
  to?: number;
  search?: string;
  sort?: 'newest' | 'oldest';
  limit?: number;
  offset?: number;
  includeIncomplete?: boolean;
}

export class ActivityRepository {
  constructor(private readonly ctx: DatabaseContext) {}

  async getById(id: string): Promise<Activity | null> {
    const r = await this.ctx.db.get<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE id = ?`,
      [id],
    );
    return r ? toActivity(r) : null;
  }

  async list(q: ActivityQuery = {}): Promise<{ items: Activity[]; total: number }> {
    const where: string[] = ['deleted_at IS NULL'];
    const params: SqlValue[] = [];
    if (!q.includeIncomplete) where.push("status = 'completed'");
    if (q.sportTypes && q.sportTypes.length > 0) {
      where.push(`sport_type IN (${q.sportTypes.map(() => '?').join(',')})`);
      params.push(...q.sportTypes);
    }
    if (q.from != null) {
      where.push('started_at >= ?');
      params.push(q.from);
    }
    if (q.to != null) {
      where.push('started_at < ?');
      params.push(q.to);
    }
    if (q.search && q.search.trim()) {
      // LIKE with escaped wildcards; user input never becomes SQL.
      const term = `%${q.search
        .trim()
        .toLowerCase()
        .replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(
        "(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(description, '')) LIKE ? ESCAPE '\\')",
      );
      params.push(term, term);
    }
    const clause = where.join(' AND ');
    const order = q.sort === 'oldest' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = await this.ctx.db.all<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE ${clause} ORDER BY started_at ${order}, id ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const total =
      (
        await this.ctx.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM activities WHERE ${clause}`,
          params,
        )
      )?.n ?? 0;
    return { items: rows.map(toActivity), total };
  }

  /** Every completed, non-deleted activity (analytics input). */
  async allCompleted(): Promise<Activity[]> {
    const rows = await this.ctx.db.all<ActivityRow>(
      `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE deleted_at IS NULL AND status = 'completed' ORDER BY started_at`,
    );
    return rows.map(toActivity);
  }

  async updateDetails(
    id: string,
    edit: { title?: string; description?: string | null },
  ): Promise<Activity> {
    return this.ctx.db.transaction(async (tx) => {
      const now = this.ctx.now();
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (edit.title !== undefined) {
        sets.push('title = ?');
        params.push(edit.title);
      }
      if (edit.description !== undefined) {
        sets.push('description = ?');
        params.push(edit.description);
      }
      if (sets.length === 0) throw new Error('Nothing to update');
      const res = await tx.run(
        `UPDATE activities SET ${sets.join(', ')}, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`,
        [...params, now, id],
      );
      if (res.changes === 0) throw new Error('Activity not found');
      const row = (await tx.get<ActivityRow>(
        `SELECT ${ACTIVITY_COLUMNS} FROM activities WHERE id = ?`,
        [id],
      ))!;
      if (row.status === 'completed') {
        await enqueueOutbox(tx, now, {
          entityType: 'activity',
          entityId: id,
          operation: 'upsert',
          entityVersion: row.version,
        });
      }
      return toActivity(row);
    });
  }

  /**
   * Soft delete: the row becomes a tombstone (for sync), route data is purged for privacy,
   * and personal records are recomputed without it.
   */
  async softDelete(id: string): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      const now = this.ctx.now();
      const row = await tx.get<{ version: number; sport_type: SportType }>(
        'SELECT version, sport_type FROM activities WHERE id = ? AND deleted_at IS NULL',
        [id],
      );
      if (!row) throw new Error('Activity not found');
      await tx.run(
        'UPDATE activities SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [now, now, id],
      );
      for (const table of [
        'route_points',
        'recording_events',
        'processed_routes',
        'activity_splits',
        'sensor_samples',
        'laps',
        'record_candidates',
      ]) {
        await tx.run(`DELETE FROM ${table} WHERE activity_id = ?`, [id]);
      }
      await tx.run('DELETE FROM activity_segments WHERE parent_activity_id = ?', [id]);
      await recomputePersonalRecords(tx, this.ctx.newId);
      await enqueueOutbox(tx, now, {
        entityType: 'activity',
        entityId: id,
        operation: 'delete',
        entityVersion: row.version + 1,
      });
    });
  }

  async laps(activityId: string): Promise<Lap[]> {
    return (
      await this.ctx.db.all<LapRow>(
        'SELECT * FROM laps WHERE activity_id = ? ORDER BY sequence_number',
        [activityId],
      )
    ).map(toLap);
  }
  async segments(activityId: string): Promise<ActivitySegment[]> {
    return (
      await this.ctx.db.all<SegmentRow>(
        'SELECT * FROM activity_segments WHERE parent_activity_id = ? ORDER BY sequence_number',
        [activityId],
      )
    ).map(toSegment);
  }
  async splits(activityId: string): Promise<Split[]> {
    return (
      await this.ctx.db.all<SplitRow>(
        'SELECT * FROM activity_splits WHERE activity_id = ? ORDER BY split_index',
        [activityId],
      )
    ).map(toSplit);
  }
}

// ============================================================================ route data

export interface ProcessedRoute {
  algorithmVersion: number;
  /** One encoded polyline per recording segment (pauses/gaps break segments). */
  segments: string[];
  /** Simplified polyline segments for list thumbnails / overview maps. */
  display: string[];
  bounds: {
    minLatitude: number;
    minLongitude: number;
    maxLatitude: number;
    maxLongitude: number;
  } | null;
  gaps: Array<{ kind: string; startedAt: number; endedAt: number; countedDistanceMeters: number }>;
  acceptedSampleCount: number;
  rejectedSampleCount: number;
}

export class RouteRepository {
  constructor(private readonly ctx: DatabaseContext) {}

  /** Raw samples, paginated by sequence number. */
  async rawPage(
    activityId: string,
    afterSequence = -1,
    limit = 5000,
  ): Promise<Array<LocationSample & { sequenceNumber: number }>> {
    const rows = await this.ctx.db.all<RoutePointRow>(
      'SELECT * FROM route_points WHERE activity_id = ? AND sequence_number > ? ORDER BY sequence_number LIMIT ?',
      [activityId, afterSequence, limit],
    );
    return rows.map((r) => ({ ...toSample(r), sequenceNumber: r.sequence_number }));
  }

  async allRaw(activityId: string): Promise<LocationSample[]> {
    const out: LocationSample[] = [];
    let after = -1;
    for (;;) {
      const page = await this.rawPage(activityId, after, 5000);
      out.push(...page.map(({ sequenceNumber: _s, ...s }) => s));
      if (page.length < 5000) return out;
      after = page[page.length - 1]!.sequenceNumber;
    }
  }

  async rawCount(activityId: string): Promise<number> {
    return (
      (
        await this.ctx.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM route_points WHERE activity_id = ?',
          [activityId],
        )
      )?.n ?? 0
    );
  }

  async processed(activityId: string): Promise<ProcessedRoute | null> {
    const r = await this.ctx.db.get<{
      algorithm_version: number;
      segments_polyline: string;
      display_polyline: string;
      min_latitude: number | null;
      min_longitude: number | null;
      max_latitude: number | null;
      max_longitude: number | null;
      gaps: string;
      accepted_sample_count: number;
      rejected_sample_count: number;
    }>('SELECT * FROM processed_routes WHERE activity_id = ?', [activityId]);
    if (!r) return null;
    return {
      algorithmVersion: r.algorithm_version,
      segments: JSON.parse(r.segments_polyline) as string[],
      display: JSON.parse(r.display_polyline) as string[],
      bounds:
        r.min_latitude != null &&
        r.min_longitude != null &&
        r.max_latitude != null &&
        r.max_longitude != null
          ? {
              minLatitude: r.min_latitude,
              minLongitude: r.min_longitude,
              maxLatitude: r.max_latitude,
              maxLongitude: r.max_longitude,
            }
          : null,
      gaps: JSON.parse(r.gaps) as ProcessedRoute['gaps'],
      acceptedSampleCount: r.accepted_sample_count,
      rejectedSampleCount: r.rejected_sample_count,
    };
  }
}

// ============================================================================ records

/** Rebuild personal_records as the best per (sport, metric) over all stored candidates. */
export async function recomputePersonalRecords(tx: SqlDriver, newId: () => string): Promise<void> {
  const rows = await tx.all<{
    activity_id: string;
    sport_type: SportType;
    metric_type: RecordCandidate['metricType'];
    value: number;
    unit: 'ms' | 'meters';
    basis: RecordCandidate['basis'];
    achieved_at: number;
  }>(
    `SELECT c.* FROM record_candidates c JOIN activities a ON a.id = c.activity_id
     WHERE a.deleted_at IS NULL AND a.status = 'completed'`,
  );
  const best = bestRecords(
    rows.map((r) => ({
      sportType: r.sport_type,
      metricType: r.metric_type,
      value: r.value,
      unit: r.unit,
      basis: r.basis,
      activityId: r.activity_id,
      achievedAt: r.achieved_at,
    })),
  );
  const existing = await tx.all<{
    id: string;
    sport_type: string;
    metric_type: string;
    activity_id: string;
    value: number;
  }>('SELECT id, sport_type, metric_type, activity_id, value FROM personal_records');
  const byKey = new Map(existing.map((e) => [`${e.sport_type}:${e.metric_type}`, e]));
  const keep = new Set<string>();
  for (const b of best) {
    const key = `${b.sportType}:${b.metricType}`;
    keep.add(key);
    const cur = byKey.get(key);
    if (cur && cur.activity_id === b.activityId && cur.value === b.value) continue;
    await tx.run('DELETE FROM personal_records WHERE sport_type = ? AND metric_type = ?', [
      b.sportType,
      b.metricType,
    ]);
    await tx.run(
      `INSERT INTO personal_records (id, user_id, sport_type, metric_type, value, unit, basis, activity_id, achieved_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cur?.id ?? newId(),
        b.sportType,
        b.metricType,
        b.value,
        b.unit,
        b.basis,
        b.activityId,
        b.achievedAt,
      ],
    );
  }
  for (const [key, e] of byKey)
    if (!keep.has(key)) await tx.run('DELETE FROM personal_records WHERE id = ?', [e.id]);
}

export class PersonalRecordRepository {
  constructor(private readonly ctx: DatabaseContext) {}
  async list(): Promise<PersonalRecord[]> {
    return (
      await this.ctx.db.all<RecordRow>(
        'SELECT * FROM personal_records ORDER BY sport_type, metric_type',
      )
    ).map(toRecord);
  }
  async forActivity(activityId: string): Promise<PersonalRecord[]> {
    return (
      await this.ctx.db.all<RecordRow>('SELECT * FROM personal_records WHERE activity_id = ?', [
        activityId,
      ])
    ).map(toRecord);
  }
}

// ============================================================================ goals

export class GoalRepository {
  constructor(private readonly ctx: DatabaseContext) {}

  async list(): Promise<TrainingGoal[]> {
    return (
      await this.ctx.db.all<GoalRow>(
        'SELECT * FROM training_goals WHERE deleted_at IS NULL ORDER BY created_at',
      )
    ).map(toGoal);
  }

  async create(
    input: Pick<TrainingGoal, 'sportType' | 'goalType' | 'targetValue' | 'period'> &
      Partial<Pick<TrainingGoal, 'startDate' | 'endDate'>>,
  ): Promise<TrainingGoal> {
    const now = this.ctx.now();
    const goal: TrainingGoal = {
      id: this.ctx.newId(),
      userId: null,
      sportType: input.sportType,
      goalType: input.goalType,
      targetValue: input.targetValue,
      period: input.period,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.ctx.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO training_goals (id, user_id, sport_type, goal_type, target_value, period, start_date, end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          goal.id,
          null,
          goal.sportType,
          goal.goalType,
          goal.targetValue,
          goal.period,
          goal.startDate,
          goal.endDate,
          now,
          now,
        ],
      );
      await enqueueOutbox(tx, now, {
        entityType: 'goal',
        entityId: goal.id,
        operation: 'upsert',
        entityVersion: now,
      });
    });
    return goal;
  }

  async update(
    id: string,
    patch: Partial<Pick<TrainingGoal, 'targetValue' | 'sportType' | 'period' | 'goalType'>>,
  ): Promise<void> {
    const now = this.ctx.now();
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const cols: Record<string, string> = {
      targetValue: 'target_value',
      sportType: 'sport_type',
      period: 'period',
      goalType: 'goal_type',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      params.push(v as SqlValue);
    }
    if (sets.length === 0) return;
    await this.ctx.db.transaction(async (tx) => {
      const r = await tx.run(
        `UPDATE training_goals SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
        [...params, now, id],
      );
      if (r.changes === 0) throw new Error('Goal not found');
      await enqueueOutbox(tx, now, {
        entityType: 'goal',
        entityId: id,
        operation: 'upsert',
        entityVersion: now,
      });
    });
  }

  async remove(id: string): Promise<void> {
    const now = this.ctx.now();
    await this.ctx.db.transaction(async (tx) => {
      await tx.run('UPDATE training_goals SET deleted_at = ?, updated_at = ? WHERE id = ?', [
        now,
        now,
        id,
      ]);
      await enqueueOutbox(tx, now, {
        entityType: 'goal',
        entityId: id,
        operation: 'delete',
        entityVersion: now,
      });
    });
  }
}

// ============================================================================ settings

export class SettingsRepository {
  constructor(private readonly ctx: DatabaseContext) {}
  async get<T>(key: string): Promise<T | null> {
    const r = await this.ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      key,
    ]);
    return r ? (JSON.parse(r.value) as T) : null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.ctx.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, JSON.stringify(value), this.ctx.now()],
    );
  }
  async remove(key: string): Promise<void> {
    await this.ctx.db.run('DELETE FROM settings WHERE key = ?', [key]);
  }
}
