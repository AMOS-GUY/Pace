import { type RecordedEvent, type SessionConfig, replaySession } from '@pace/activity-engine';
import {
  BackupError,
  type BackupDocument,
  type BackupDocumentV2,
  type BackupPayload,
  type BackupSensorSample,
  PORTABLE_SETTING_KEYS,
  type PortableSettingKey,
  backupDocumentSchemaV2,
  createBackupDocument,
  portableSettingSchemas,
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
  /** The backup's format version (1 has no sensor samples). */
  formatVersion: number;
  restored: number;
  skippedExisting: number;
  failed: Array<{ activityId: string; reason: string }>;
  goalsRestored: number;
  /** Heart-rate, cadence and power samples restored with the restored activities. */
  sensorSamplesRestored: number;
  /** Portable settings applied from the backup (see PORTABLE_SETTING_KEYS). */
  settingsRestored: PortableSettingKey[];
  /** Settings in the backup that were not applied: not portable, or failing validation. */
  settingsIgnored: number;
  /**
   * Goals or settings that could not be written. Activities restored before are kept; goals and
   * settings are each written all-or-nothing, so running the restore again completes them.
   */
  otherFailures: Array<{ part: 'goals' | 'settings'; reason: string }>;
}

/**
 * Only these settings are written into backups and applied on restore, whatever the backup's
 * version. Never backed up or restored: authentication sessions (the encrypted `secure:*`
 * rows), onboarding state, and sync or backup bookkeeping. Version 1 backups contain `secure:*`
 * rows; they are ignored.
 */
const PORTABLE = new Set<string>(PORTABLE_SETTING_KEYS);

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
      sensorSamples: [],
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
      // Sensor samples exactly as stored, in the order they were stored (rowid).
      const sensors = await db.all<{
        sensor_type: BackupSensorSample['type'];
        value: number;
        unit: BackupSensorSample['unit'];
        recorded_at: number;
        source_device_id: string | null;
      }>(
        'SELECT sensor_type, value, unit, recorded_at, source_device_id FROM sensor_samples WHERE activity_id = ? ORDER BY rowid',
        [r.id],
      );
      for (const x of sensors)
        payload.sensorSamples.push({
          activityId: r.id,
          type: x.sensor_type,
          value: x.value,
          unit: x.unit,
          recordedAt: x.recorded_at,
          sourceDeviceId: x.source_device_id,
        });
    }
    payload.goals = (
      await db.all<GoalRow>('SELECT * FROM training_goals WHERE deleted_at IS NULL')
    ).map(toGoal);
    payload.settings = (
      await db.all<{ key: PortableSettingKey; value: string }>(
        `SELECT key, value FROM settings WHERE key IN (${PORTABLE_SETTING_KEYS.map(() => '?').join(', ')}) ORDER BY key`,
        [...PORTABLE_SETTING_KEYS],
      )
    ).filter((s) => portableSettingValue(s.key, s.value) != null);
    return payload;
  }

  /** Creates backup bytes. Encrypted whenever a key is given (always, for cloud uploads). */
  async createBackup(
    key: BackupKey | null,
  ): Promise<{ bytes: Uint8Array; document: BackupDocumentV2 }> {
    const document = createBackupDocument(await this.buildPayload(), {
      createdAt: this.ctx.now(),
      appVersion: this.appVersion,
      schemaVersion: MIGRATIONS[MIGRATIONS.length - 1]!.version,
    });
    // Never write a backup that restore would refuse: validate it now, with the same schema.
    const check = backupDocumentSchemaV2.safeParse(document);
    if (!check.success)
      throw new BackupError(
        `Could not create a valid backup: ${check.error.issues[0]?.message ?? ''}`,
        'invalid_format',
      );
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
    const report: RestoreReport = {
      formatVersion: doc.formatVersion,
      restored: 0,
      skippedExisting: 0,
      failed: [],
      goalsRestored: 0,
      sensorSamplesRestored: 0,
      settingsRestored: [],
      settingsIgnored: 0,
      otherFailures: [],
    };
    const p = doc.payload;
    const samplesBy = groupBy(p.samples, (s) => s.activityId);
    const eventsBy = groupBy(p.events, (e) => e.activityId);
    // Version 1 has no sensor samples; it is never read as version 2.
    const sensorsBy = groupBy(
      doc.formatVersion === 2 ? doc.payload.sensorSamples : [],
      (s) => s.activityId,
    );

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
          // In the same transaction: an activity is restored with all its sensor samples or not
          // at all. Stored order is kept; values and times are exactly as backed up.
          const sensors = sensorsBy.get(a.id) ?? [];
          await insertMany(
            tx,
            'sensor_samples',
            [
              'id',
              'activity_id',
              'sensor_type',
              'value',
              'unit',
              'recorded_at',
              'source_device_id',
            ],
            sensors.map((x) => [
              this.ctx.newId(),
              a.id,
              x.type,
              x.value,
              x.unit,
              x.recordedAt,
              x.sourceDeviceId,
            ]),
          );
          await writeCompletedActivity(tx, this.ctx, a.id, a.sportType, summary);
        });
        report.restored++;
        report.sensorSamplesRestored += (sensorsBy.get(a.id) ?? []).length;
      } catch (e) {
        report.failed.push({
          activityId: a.id,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    try {
      let goals = 0;
      await this.ctx.db.transaction(async (tx) => {
        for (const g of p.goals) {
          const r = await tx.run(
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
          goals += r.changes;
        }
      });
      report.goalsRestored = goals;
    } catch (e) {
      report.otherFailures.push({ part: 'goals', reason: reason(e) });
    }
    // Portable settings replace the device's values: restoring brings back the athlete's
    // preferences and profile. Anything else in the backup (in version 1 that includes the
    // encrypted auth-session rows) is ignored, as is any value failing validation.
    const seen = new Set<string>();
    const apply: Array<{ key: PortableSettingKey; value: string }> = [];
    for (const s of p.settings) {
      const value =
        PORTABLE.has(s.key) && !seen.has(s.key)
          ? portableSettingValue(s.key as PortableSettingKey, s.value)
          : null;
      if (value == null) {
        report.settingsIgnored++;
        continue;
      }
      seen.add(s.key);
      apply.push({ key: s.key as PortableSettingKey, value });
    }
    try {
      await this.ctx.db.transaction(async (tx) => {
        for (const s of apply)
          await tx.run(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
            [s.key, s.value, this.ctx.now()],
          );
      });
      report.settingsRestored = apply.map((s) => s.key);
    } catch (e) {
      report.otherFailures.push({ part: 'settings', reason: reason(e) });
    }
    return report;
  }
}

/**
 * The validated JSON of a portable setting, or null when it is not valid JSON or fails its
 * schema. Unknown fields from a newer app are dropped.
 */
function portableSettingValue(key: PortableSettingKey, raw: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = portableSettingSchemas[key].safeParse(json);
  return parsed.success ? JSON.stringify(parsed.data) : null;
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
