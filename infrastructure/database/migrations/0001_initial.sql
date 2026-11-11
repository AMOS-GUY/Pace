-- PACE cloud schema v1. Append-only: never edit an applied migration; add a new file instead.

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  avatar_url text,
  measurement_system text NOT NULL DEFAULT 'metric' CHECK (measurement_system IN ('metric', 'imperial')),
  language text NOT NULL DEFAULT 'en',
  timezone text NOT NULL DEFAULT 'UTC',
  preferred_sports text[] NOT NULL DEFAULT '{}',
  height_cm double precision,
  weight_kg double precision,
  weekly_target_distance_meters double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  sport_type text NOT NULL CHECK (sport_type IN ('running', 'cycling', 'walking', 'hiking', 'swimming', 'triathlon')),
  title text NOT NULL,
  description text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  timezone text NOT NULL,
  status text NOT NULL,
  source text NOT NULL,
  swim_mode text,
  pool_length_meters double precision,
  elapsed_duration_ms bigint NOT NULL CHECK (elapsed_duration_ms >= 0),
  moving_duration_ms bigint NOT NULL CHECK (moving_duration_ms >= 0),
  distance_meters double precision NOT NULL CHECK (distance_meters >= 0),
  elevation_gain_meters double precision NOT NULL,
  elevation_loss_meters double precision NOT NULL,
  average_speed_mps double precision,
  maximum_speed_mps double precision,
  average_pace_ms_per_km double precision,
  version integer NOT NULL,
  client_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_activities_user_started ON activities (user_id, started_at DESC);

CREATE TABLE route_points (
  activity_id uuid NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  sequence_number integer NOT NULL CHECK (sequence_number >= 0),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  altitude_meters double precision,
  horizontal_accuracy_meters double precision NOT NULL,
  vertical_accuracy_meters double precision,
  speed_mps double precision,
  course_degrees double precision,
  recorded_at timestamptz NOT NULL,
  source text NOT NULL,
  PRIMARY KEY (activity_id, sequence_number)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  device_type text NOT NULL,
  manufacturer text,
  model text,
  external_identifier text NOT NULL,
  last_connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_devices_user_external ON devices (user_id, external_identifier);

CREATE TABLE backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  format_version integer NOT NULL,
  storage_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  encrypted boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_backups_user ON backups (user_id, created_at DESC);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
