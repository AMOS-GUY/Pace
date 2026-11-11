import { MULTISPORT_SEGMENT_TYPES, SPORT_TYPES } from '@pace/domain';
import { z } from 'zod';

/**
 * Runtime validation at trust boundaries: imported files, backups, API payloads and
 * native-module events. Internal code relies on TypeScript types instead.
 */

export const uuidSchema = z.uuid();
export const epochMsSchema = z.number().int().min(946_684_800_000).max(4_102_444_800_000);
export const sportTypeSchema = z.enum(SPORT_TYPES);
export const segmentTypeSchema = z.enum(MULTISPORT_SEGMENT_TYPES);
const nonNegative = z.number().finite().nonnegative();
const nullableNonNegative = nonNegative.nullable();

export const locationSampleSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  altitudeMeters: z.number().finite().min(-1000).max(10_000).nullable(),
  // Native layers may emit negative accuracy for invalid fixes; the GPS engine rejects them.
  horizontalAccuracyMeters: z.number().finite(),
  verticalAccuracyMeters: z.number().finite().nullable(),
  speedMps: z.number().finite().nullable(),
  courseDegrees: z.number().finite().nullable(),
  recordedAt: epochMsSchema,
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
  maxGpxPoints: 200_000,
  maxBackupBytes: 512 * 1024 * 1024,
} as const;

export { z };
