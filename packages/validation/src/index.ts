import { MULTISPORT_SEGMENT_TYPES, SPORT_TYPES } from '@pace/domain';
import { z } from 'zod';

/**
 * Runtime validation at trust boundaries: imported files, backups, API payloads and
 * native-module events. Internal code relies on TypeScript types instead.
 */

export const uuidSchema = z.uuid();
/** Every stored activity time must lie in 2000-01-01 .. 2100-01-01 (UTC). */
export const MIN_EPOCH_MS = 946_684_800_000;
export const MAX_EPOCH_MS = 4_102_444_800_000;
export const epochMsSchema = z.number().int().min(MIN_EPOCH_MS).max(MAX_EPOCH_MS);
export const sportTypeSchema = z.enum(SPORT_TYPES);
export const segmentTypeSchema = z.enum(MULTISPORT_SEGMENT_TYPES);
const nonNegative = z.number().finite().nonnegative();
const nullableNonNegative = nonNegative.nullable();

/**
 * A *raw* location sample at a storage/transport boundary (native bridge, backups, sync).
 *
 * Deliberately permissive: raw samples are preserved exactly as captured, so this schema only
 * guarantees well-typed values (and coordinate ranges, which every platform guarantees). Physical
 * plausibility — accuracy, timestamps, altitude, jumps — is judged later by the GPS engine, which
 * keeps but rejects implausible samples. Rejecting them here would create holes in the gap-free
 * sample sequence and make an otherwise valid backup unrestorable.
 */
export const locationSampleSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  altitudeMeters: z.number().finite().nullable(),
  // Native layers may emit negative accuracy for invalid fixes; the GPS engine rejects them.
  horizontalAccuracyMeters: z.number().finite(),
  verticalAccuracyMeters: z.number().finite().nullable(),
  speedMps: z.number().finite().nullable(),
  courseDegrees: z.number().finite().nullable(),
  recordedAt: z.number().int().nonnegative(),
  source: z.enum(['device_gps', 'device_fused', 'external_device', 'import', 'replay']),
});
export type LocationSampleInput = z.infer<typeof locationSampleSchema>;

export const activityStatusSchema = z.enum([
  'recording',
  'paused',
  'interrupted',
  'completed',
  'discarded',
]);
export const activitySourceSchema = z.enum([
  'recorded',
  'imported_gpx',
  'imported_tcx',
  'imported_fit',
  'imported_backup',
  'manual',
  'healthkit',
]);

export const activitySchema = z.object({
  id: uuidSchema,
  userId: z.string().nullable(),
  sportType: sportTypeSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).nullable(),
  startedAt: epochMsSchema,
  endedAt: epochMsSchema.nullable(),
  timezone: z.string().min(1).max(64),
  status: activityStatusSchema,
  source: activitySourceSchema,
  swimMode: z.enum(['pool', 'open_water']).nullable(),
  poolLengthMeters: z.number().positive().max(100).nullable(),
  elapsedDurationMs: nonNegative,
  movingDurationMs: nonNegative,
  distanceMeters: nonNegative,
  elevationGainMeters: nonNegative,
  elevationLossMeters: nonNegative,
  averageSpeedMps: nullableNonNegative,
  maximumSpeedMps: nullableNonNegative,
  averagePaceMsPerKm: nullableNonNegative,
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
  deletedAt: epochMsSchema.nullable(),
  version: z.number().int().nonnegative(),
});
export type ActivityInput = z.infer<typeof activitySchema>;

export const activityEditSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(4000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const lapSchema = z.object({
  id: uuidSchema,
  activityId: uuidSchema,
  sequenceNumber: z.number().int().nonnegative(),
  startedAt: epochMsSchema,
  durationMs: nonNegative,
  distanceMeters: nonNegative,
  averagePaceMsPerKm: nullableNonNegative,
  averageSpeedMps: nullableNonNegative,
  lengthCount: z.number().int().positive().nullable(),
});

export const segmentSchema = z.object({
  id: uuidSchema,
  parentActivityId: uuidSchema,
  segmentType: segmentTypeSchema,
  sequenceNumber: z.number().int().nonnegative(),
  startedAt: epochMsSchema,
  endedAt: epochMsSchema.nullable(),
  elapsedDurationMs: nonNegative,
  movingDurationMs: nonNegative,
  distanceMeters: nonNegative,
  elevationGainMeters: nonNegative,
});

export const routePointSchema = locationSampleSchema.extend({
  sequenceNumber: z.number().int().nonnegative(),
});

export const trainingGoalSchema = z.object({
  id: uuidSchema,
  userId: z.string().nullable(),
  sportType: sportTypeSchema.nullable(),
  goalType: z.enum(['distance', 'activity_count', 'duration']),
  targetValue: z.number().positive().max(1e10),
  period: z.enum(['week', 'month']),
  startDate: z.iso.date().nullable(),
  endDate: z.iso.date().nullable(),
  createdAt: epochMsSchema,
  updatedAt: epochMsSchema,
  deletedAt: epochMsSchema.nullable(),
});

export const goalInputSchema = trainingGoalSchema.pick({
  sportType: true,
  goalType: true,
  targetValue: true,
  period: true,
});

export const profileUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    avatarUrl: z.url().max(2048).nullable(),
    measurementSystem: z.enum(['metric', 'imperial']),
    language: z.string().min(2).max(16),
    timezone: z.string().min(1).max(64),
    preferredSports: z.array(sportTypeSchema).max(6),
    heightCm: z.number().min(50).max(272).nullable(),
    weightKg: z.number().min(20).max(400).nullable(),
    weeklyTargetDistanceMeters: z.number().positive().max(2_000_000).nullable(),
  })
  .partial();
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export const credentialsSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
});

/** Limits applied to user-supplied files before parsing, to avoid resource exhaustion. */
export const IMPORT_LIMITS = {
  maxGpxBytes: 25 * 1024 * 1024,
  /** Also the point limit for one TCX file (shared across its activities). */
  maxGpxPoints: 200_000,
  maxTcxBytes: 25 * 1024 * 1024,
  maxFitBytes: 25 * 1024 * 1024,
  /** Messages of any kind in one FIT file (all chained files together). */
  maxFitMessages: 2_000_000,
  maxBackupBytes: 512 * 1024 * 1024,
  /** Bulk import: compressed archive size (streamed from disk, never held in memory). */
  maxArchiveBytes: 4 * 1024 * 1024 * 1024,
  /** Bulk import: entries examined in one archive. */
  maxArchiveEntries: 50_000,
  /** Bulk import: decompressed size of one activity file inside an archive or .gz. */
  maxEntryBytes: 25 * 1024 * 1024,
  /** Bulk import: total decompressed bytes of activity files in one archive (ZIP-bomb guard). */
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  /** Bulk import: activity files imported from one selection. */
  maxImportFiles: 20_000,
} as const;

export { z };
