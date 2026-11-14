import {
  activitySchema,
  epochMsSchema,
  lapSchema,
  locationSampleSchema,
  sportTypeSchema,
  trainingGoalSchema,
  z,
} from '@pace/validation';

export const BACKUP_FORMAT = 'pace-backup';
/** The format version new backups are written in. */
export const BACKUP_FORMAT_VERSION = 2;
/** Every format version this build can read. Older builds read only version 1. */
export const SUPPORTED_BACKUP_FORMAT_VERSIONS = [1, 2] as const;

// ============================================================================ version 1

/**
 * Backup payload v1: the *source* data needed to rebuild every activity — activity rows, raw
 * samples, recording events and session configs. Derived data (splits, processed routes,
 * records) is recomputed on restore by deterministic replay, which also validates integrity.
 *
 * Version 1 carries no sensor samples (heart rate, cadence, power), and its settings list is
 * whatever the device held. Restore applies only the portable settings allowlist, whatever the
 * version.
 */
export const backupPayloadSchemaV1 = z.object({
  activities: z.array(activitySchema.extend({ sessionConfig: z.unknown().nullable() })),
  samples: z.array(
    locationSampleSchema.extend({
      activityId: z.uuid(),
      sequenceNumber: z.number().int().nonnegative(),
    }),
  ),
  events: z.array(
    z.object({
      activityId: z.uuid(),
      sequenceNumber: z.number().int().nonnegative(),
      type: z.enum([
        'started',
        'paused',
        'resumed',
        'auto_paused',
        'auto_resumed',
        'interrupted',
        'lap',
        'leg_advanced',
        'finished',
      ]),
      at: epochMsSchema,
      afterSampleCount: z.number().int().nonnegative(),
      lengthCount: z.number().int().positive().nullable(),
    }),
  ),
  laps: z.array(lapSchema),
  goals: z.array(trainingGoalSchema),
  settings: z.array(z.object({ key: z.string().max(128), value: z.string().max(100_000) })),
});
export type BackupPayloadV1 = z.infer<typeof backupPayloadSchemaV1>;

const documentBase = {
  format: z.literal(BACKUP_FORMAT),
  createdAt: epochMsSchema,
  appVersion: z.string().max(32),
  schemaVersion: z.number().int().positive(),
  /** Hex SHA-256 of the canonical JSON of `payload`. */
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
};

/**
 * Version 1 as written by earlier PACE builds. The payload and counts are strict: a field from a
 * later version (such as `sensorSamples`) is refused, never silently dropped, so a newer backup
 * relabelled as version 1 cannot pass as one.
 */
export const backupDocumentSchemaV1 = z.object({
  ...documentBase,
  formatVersion: z.literal(1),
  counts: z
    .object({
      activities: z.number().int(),
      samples: z.number().int(),
      events: z.number().int(),
    })
    .strict(),
  payload: backupPayloadSchemaV1.strict(),
});
export type BackupDocumentV1 = z.infer<typeof backupDocumentSchemaV1>;

// ============================================================================ version 2

const SENSOR_UNITS = { heart_rate: 'bpm', cadence: 'rpm', power: 'W' } as const;

/**
 * One stored sensor sample, exactly as in `sensor_samples` (no rounding, no resampling). Samples
 * are listed per activity in the order they were stored; restore keeps that order.
 */
export const backupSensorSampleSchema = z
  .object({
    activityId: z.uuid(),
    type: z.enum(['heart_rate', 'cadence', 'power']),
    value: z.number().finite().min(0).max(3000),
    unit: z.enum(['bpm', 'rpm', 'W']),
    recordedAt: epochMsSchema,
    sourceDeviceId: z.string().max(128).nullable(),
  })
  .refine((s) => SENSOR_UNITS[s.type] === s.unit, { message: 'Sensor unit does not match type' });
export type BackupSensorSample = z.infer<typeof backupSensorSampleSchema>;

/**
 * Settings a backup may carry, and the only ones restore will ever apply, whatever the backup's
 * version. Everything else stays on the device: authentication sessions (`secure:*`), onboarding
 * state, sync and backup bookkeeping.
 */
export const PORTABLE_SETTING_KEYS = ['preferences', 'profile'] as const;
export type PortableSettingKey = (typeof PORTABLE_SETTING_KEYS)[number];

/** Unknown fields (from a newer app) are dropped, known ones are checked. */
export const portableSettingSchemas: Record<PortableSettingKey, z.ZodType> = {
  preferences: z.object({
    measurementSystem: z.enum(['metric', 'imperial']).optional(),
    exportPrivacyZoneMeters: z.number().finite().min(0).max(10_000).optional(),
    autoPause: z.partialRecord(sportTypeSchema, z.boolean()).optional(),
    lastSport: sportTypeSchema.optional(),
    poolLengthMeters: z.number().finite().min(10).max(100).optional(),
  }),
  profile: z.object({
    displayName: z.string().max(100),
    preferredSports: z.array(sportTypeSchema).max(10),
    heightCm: z.number().finite().min(50).max(300).nullable(),
    weightKg: z.number().finite().min(20).max(400).nullable(),
  }),
};

/** Backup payload v2: v1 plus sensor samples; settings limited to the portable allowlist. */
export const backupPayloadSchemaV2 = backupPayloadSchemaV1.extend({
  sensorSamples: z.array(backupSensorSampleSchema),
  settings: z.array(
    z.object({ key: z.enum(PORTABLE_SETTING_KEYS), value: z.string().max(100_000) }),
  ),
});
export type BackupPayloadV2 = z.infer<typeof backupPayloadSchemaV2>;

export const backupDocumentSchemaV2 = z
  .object({
    ...documentBase,
    formatVersion: z.literal(2),
    counts: z
      .object({
        activities: z.number().int(),
        samples: z.number().int(),
        events: z.number().int(),
        sensorSamples: z.number().int(),
      })
      .strict(),
    payload: backupPayloadSchemaV2.strict(),
  })
  // Strict like version 1: a field this build does not know is refused, never silently dropped.
  .strict()
  .superRefine((doc, ctx) => {
    const p = doc.payload;
    const c = doc.counts;
    if (
      c.activities !== p.activities.length ||
      c.samples !== p.samples.length ||
      c.events !== p.events.length ||
      c.sensorSamples !== p.sensorSamples.length
    )
      ctx.addIssue({ code: 'custom', message: 'Backup counts do not match its contents' });
    const ids = new Set(p.activities.map((a) => a.id));
    if (p.sensorSamples.some((s) => !ids.has(s.activityId)))
      ctx.addIssue({ code: 'custom', message: 'Sensor samples refer to a missing activity' });
  });
export type BackupDocumentV2 = z.infer<typeof backupDocumentSchemaV2>;

// ============================================================================ any version

/** What new backups contain. */
export type BackupPayload = BackupPayloadV2;
/** A parsed backup of any supported version; check `formatVersion` before using v2 fields. */
export type BackupDocument = BackupDocumentV1 | BackupDocumentV2;

/** @deprecated Use backupDocumentSchemaV2 (written) or parseBackup (reads every version). */
export const backupDocumentSchema = backupDocumentSchemaV2;
/** @deprecated Use backupPayloadSchemaV2. */
export const backupPayloadSchema = backupPayloadSchemaV2;
