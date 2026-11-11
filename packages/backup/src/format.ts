import {
  activitySchema,
  epochMsSchema,
  lapSchema,
  locationSampleSchema,
  trainingGoalSchema,
  z,
} from '@pace/validation';

export const BACKUP_FORMAT = 'pace-backup';
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Backup payload v1: the *source* data needed to rebuild every activity — activity rows, raw
 * samples, recording events and session configs. Derived data (splits, processed routes,
 * records) is recomputed on restore by deterministic replay, which also validates integrity.
 */
export const backupPayloadSchema = z.object({
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
export type BackupPayload = z.infer<typeof backupPayloadSchema>;

export const backupDocumentSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  createdAt: epochMsSchema,
  appVersion: z.string().max(32),
  schemaVersion: z.number().int().positive(),
  counts: z.object({
    activities: z.number().int(),
    samples: z.number().int(),
    events: z.number().int(),
  }),
  /** Hex SHA-256 of the canonical JSON of `payload`. */
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  payload: backupPayloadSchema,
});
export type BackupDocument = z.infer<typeof backupDocumentSchema>;
