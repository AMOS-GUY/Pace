import { type RecordedEvent, type SessionConfig, replaySession } from '@pace/activity-engine';
import {
  type BackupDocument,
  type BackupPayload,
  createBackupDocument,
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
  parseBackup,
  serializeBackup,
} from '@pace/backup';
import {
  ACTIVITY_COLUMNS,
  type ActivityRow,
  type DatabaseContext,
  type GoalRow,
  MIGRATIONS,
  ROUTE_POINT_COLUMNS,
  type RoutePointRow,
  insertMany,
  sampleValues,
  toActivity,
  toGoal,
  toSample,
  writeCompletedActivity,
} from '@pace/database';
import type { SessionEvent } from '@pace/activity-engine';

export type BackupKey =
  { kind: 'passphrase'; passphrase: string } | { kind: 'raw'; key: Uint8Array };

export interface RestoreReport {
  restored: number;
  skippedExisting: number;
  failed: Array<{ activityId: string; reason: string }>;
  goalsRestored: number;
}

/** Settings that are device-specific or sensitive and never leave the device in a backup. */
const NON_PORTABLE_SETTINGS = new Set(['onboarding.completed', 'session', 'backup.lastRunAt']);

export class BackupService {
  constructor(
    private readonly ctx: DatabaseContext,
    private readonly appVersion: string,
  ) {}

  async buildPayload(): Promise<BackupPayload> {
    const db = this.ctx.db;
    const rows = await db.all<ActivityRow & { session_config: string | null }>(
      `SELECT ${ACTIVITY_COLUMNS}, session_config FROM activities WHERE deleted_at IS NULL AND status = 'completed' ORDER BY started_at`,
    );
    const payload: BackupPayload = {
      activities: [],
      samples: [],
      events: [],
      laps: [],
      goals: [],
      settings: [],
    };
    for (const r of rows) {
      payload.activities.push({
        ...toActivity(r),
        sessionConfig: r.session_config ? (JSON.parse(r.session_config) as unknown) : null,
      });
      const pts = await db.all<RoutePointRow>(
        'SELECT * FROM route_points WHERE activity_id = ? ORDER BY sequence_number',
        [r.id],
      );
      for (const p of pts)
        payload.samples.push({
          activityId: r.id,
          sequenceNumber: p.sequence_number,
          ...toSample(p),
        });
      const evs = await db.all<{
        sequence_number: number;
        event_type: SessionEvent['type'];
        occurred_at: number;
        after_sample_count: number;
        payload: string | null;
      }>('SELECT * FROM recording_events WHERE activity_id = ? ORDER BY sequence_number', [r.id]);
      for (const e of evs) {
        const lengthCount = e.payload
          ? ((JSON.parse(e.payload) as { lengthCount?: number }).lengthCount ?? null)
          : null;
        payload.events.push({
          activityId: r.id,
          sequenceNumber: e.sequence_number,
          type: e.event_type,
          at: e.occurred_at,
          afterSampleCount: e.after_sample_count,
          lengthCount,
        });
      }
    }
    payload.goals = (
      await db.all<GoalRow>('SELECT * FROM training_goals WHERE deleted_at IS NULL')
    ).map(toGoal);
    payload.settings = (
      await db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
    ).filter((s) => !NON_PORTABLE_SETTINGS.has(s.key));
    return payload;
  }

  /** Creates backup bytes. Encrypted whenever a key is given (always, for cloud uploads). */
  async createBackup(
    key: BackupKey | null,
  ): Promise<{ bytes: Uint8Array; document: BackupDocument }> {
    const document = createBackupDocument(await this.buildPayload(), {
      createdAt: this.ctx.now(),
      appVersion: this.appVersion,
      schemaVersion: MIGRATIONS[MIGRATIONS.length - 1]!.version,
    });
    const plain = serializeBackup(document);
    return { bytes: key ? encryptBackup(plain, key) : plain, document };
  }

  /** Validates (and decrypts) a backup without touching the database. */
  open(bytes: Uint8Array, key: BackupKey | null): BackupDocument {
    if (isEncryptedBackup(bytes)) {
      if (!key) throw new Error('This backup is encrypted');
      return parseBackup(decryptBackup(bytes, key));
    }
    return parseBackup(bytes);
  }

  /**
   * Restores a backup additively: activities already on the device are kept as they are
   * (local data is authoritative and never overwritten or deleted). Each restored activity is
   * rebuilt by deterministic replay of its raw data; one corrupt activity never blocks others.
   */
  async restore(doc: BackupDocument): Promise<RestoreReport> {
    const report: RestoreReport = { restored: 0, skippedExisting: 0, failed: [], goalsRestored: 0 };
    const p = doc.payload;
    const samplesBy = groupBy(p.samples, (s) => s.activityId);
    const eventsBy = groupBy(p.events, (e) => e.activityId);

    for (const a of p.activities) {
      const exists = await this.ctx.db.get('SELECT 1 AS x FROM activities WHERE id = ?', [a.id]);
      if (exists) {
        report.skippedExisting++;
        continue;
      }
      try {
        if (!a.sessionConfig) throw new Error('Activity has no session configuration');
        const config = a.sessionConfig as SessionConfig;
        if (config.activityId !== a.id || config.sportType !== a.sportType)
          throw new Error('Session configuration does not match activity');
        const samples = (samplesBy.get(a.id) ?? []).sort(
          (x, y) => x.sequenceNumber - y.sequenceNumber,
        );
        samples.forEach((s, i) => {
          if (s.sequenceNumber !== i) throw new Error('Raw samples are not contiguous');
        });
        const events: RecordedEvent[] = (eventsBy.get(a.id) ?? [])
          .sort((x, y) => x.sequenceNumber - y.sequenceNumber)
          .map((e) => ({
            event: (e.type === 'lap' && e.lengthCount != null
              ? { type: 'lap', at: e.at, lengthCount: e.lengthCount }
              : { type: e.type, at: e.at }) as SessionEvent,
            afterSampleCount: e.afterSampleCount,
          }));
        const session = replaySession(config, events, samples);
        const summary = session.summary();

        await this.ctx.db.transaction(async (tx) => {
          await tx.run(
            `INSERT INTO activities (id, user_id, sport_type, title, description, started_at, ended_at, timezone, status, source,
               swim_mode, pool_length_meters, session_config, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?)`,
            [
              a.id,
              a.userId,
              a.sportType,
              a.title,
              a.description,
              a.startedAt,
              a.endedAt,
              a.timezone,
              a.source,
              a.swimMode,
              a.poolLengthMeters,
              JSON.stringify(config),
              a.createdAt,
              a.updatedAt,
              a.version,
            ],
          );
          await insertMany(
            tx,
            'route_points',
            ROUTE_POINT_COLUMNS,
            samples.map((s) => sampleValues(a.id, s.sequenceNumber, s)),
          );
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
            events.map((e, i) => [
              a.id,
              i,
              e.event.type,
              e.event.at,
              e.afterSampleCount,
              e.event.type === 'lap' && e.event.lengthCount != null
                ? JSON.stringify({ lengthCount: e.event.lengthCount })
                : null,
            ]),
          );
          await writeCompletedActivity(tx, this.ctx, a.id, a.sportType, summary);
        });
        report.restored++;
      } catch (e) {
        report.failed.push({
          activityId: a.id,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    for (const g of p.goals) {
      const r = await this.ctx.db.run(
        `INSERT OR IGNORE INTO training_goals (id, user_id, sport_type, goal_type, target_value, period, start_date, end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          g.id,
          g.userId,
          g.sportType,
          g.goalType,
          g.targetValue,
          g.period,
          g.startDate,
          g.endDate,
          g.createdAt,
          g.updatedAt,
        ],
      );
      report.goalsRestored += r.changes;
    }
    for (const s of p.settings) {
      if (NON_PORTABLE_SETTINGS.has(s.key)) continue;
      await this.ctx.db.run(
        'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        [s.key, s.value, this.ctx.now()],
      );
    }
    return report;
  }
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  }
  return m;
}
