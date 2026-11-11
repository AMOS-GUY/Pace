import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Cloud schema (PostgreSQL). Mirrors infrastructure/database/migrations/*.sql, which is the
 * source of truth for DDL. All timestamps are timestamptz (UTC); units are explicit in names.
 * Every user-owned table carries user_id and every query filters by it.
 */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  measurementSystem: text('measurement_system').notNull().default('metric'),
  language: text('language').notNull().default('en'),
  timezone: text('timezone').notNull().default('UTC'),
  preferredSports: text('preferred_sports').array().notNull().default([]),
  heightCm: doublePrecision('height_cm'),
  weightKg: doublePrecision('weight_kg'),
  weeklyTargetDistanceMeters: doublePrecision('weekly_target_distance_meters'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    sportType: text('sport_type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    timezone: text('timezone').notNull(),
    status: text('status').notNull(),
    source: text('source').notNull(),
    swimMode: text('swim_mode'),
    poolLengthMeters: doublePrecision('pool_length_meters'),
    elapsedDurationMs: bigint('elapsed_duration_ms', { mode: 'number' }).notNull(),
    movingDurationMs: bigint('moving_duration_ms', { mode: 'number' }).notNull(),
    distanceMeters: doublePrecision('distance_meters').notNull(),
    elevationGainMeters: doublePrecision('elevation_gain_meters').notNull(),
    elevationLossMeters: doublePrecision('elevation_loss_meters').notNull(),
    averageSpeedMps: doublePrecision('average_speed_mps'),
    maximumSpeedMps: doublePrecision('maximum_speed_mps'),
    averagePaceMsPerKm: doublePrecision('average_pace_ms_per_km'),
    version: integer('version').notNull(),
    clientUpdatedAt: ts('client_updated_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('idx_activities_user_started').on(t.userId, t.startedAt)],
);

export const routePoints = pgTable(
  'route_points',
  {
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    altitudeMeters: doublePrecision('altitude_meters'),
    horizontalAccuracyMeters: doublePrecision('horizontal_accuracy_meters').notNull(),
    verticalAccuracyMeters: doublePrecision('vertical_accuracy_meters'),
    speedMps: doublePrecision('speed_mps'),
    courseDegrees: doublePrecision('course_degrees'),
    recordedAt: ts('recorded_at').notNull(),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.activityId, t.sequenceNumber] })],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    deviceType: text('device_type').notNull(),
    manufacturer: text('manufacturer'),
    model: text('model'),
    externalIdentifier: text('external_identifier').notNull(),
    lastConnectedAt: ts('last_connected_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_devices_user_external').on(t.userId, t.externalIdentifier)],
);

export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    formatVersion: integer('format_version').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    encrypted: boolean('encrypted').notNull(),
    status: text('status').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('idx_backups_user').on(t.userId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    response: jsonb('response').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const schema = { profiles, activities, routePoints, devices, backups, idempotencyKeys };
