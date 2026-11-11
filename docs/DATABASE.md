# Database

## Local (SQLite, on device) — source of truth for activity data

Schema and migrations: `packages/database/src/migrations.ts`. Driver: `expo-sqlite` on device,
`node:sqlite` in tests — same SQL in both.

Connection settings: `foreign_keys = ON`, `journal_mode = WAL`, `synchronous = FULL` (a committed
GPS batch survives power loss).

| Table | Purpose |
|---|---|
| `activities` | One row per activity. Units in column names (`distance_meters`, `moving_duration_ms`, …). `session_config` (JSON) makes every activity replayable. `version` drives sync. `deleted_at` = tombstone. |
| `route_points` | Raw samples. PK `(activity_id, sequence_number)`, `WITHOUT ROWID`, idempotent inserts. |
| `recording_events` | Control events with `after_sample_count` for exact replay. |
| `processed_routes` | Derived geometry (encoded polylines per segment, display polyline, bounds, gaps). |
| `laps`, `activity_segments`, `activity_splits` | Derived per-activity detail (segments = triathlon legs). |
| `sensor_samples` | Heart rate / cadence / power (imported from GPX today; BLE later). |
| `record_candidates` → `personal_records` | Per-activity candidates; records are the best per (sport, metric), recomputed on completion and deletion. |
| `training_goals` | Weekly/monthly distance, count or duration goals. |
| `devices` | Paired sensors (future). |
| `sync_outbox` | Transactional outbox; idempotency key per (entity, version, op). |
| `settings` | Preferences, profile cache, encrypted values (`secure:*`, key in Keychain). |
| `schema_migrations` | Applied migration versions. |

### Rules

- Migrations are append-only, each in a transaction; a failing migration rolls back fully.
- A database created by a newer app version is refused (downgrade protection) instead of guessed.
- Timestamps are UTC epoch milliseconds; each activity stores its IANA time zone for local-day
  bucketing.
- Deleting an activity keeps a tombstone row (for sync) but purges route data and derived rows.
- Cloud sync success never deletes local data.

## Cloud (PostgreSQL) — source of truth for identity and synced copies

DDL: `infrastructure/database/migrations/*.sql` (applied by `pnpm --filter @pace/api db:migrate`);
Drizzle mirror: `apps/api/src/database/schema.ts`.

| Table | Notes |
|---|---|
| `profiles` | One per Supabase user (`user_id` unique). |
| `activities` | Client-generated UUID PK, `user_id` on every row, `version` + `client_updated_at` for conflict detection, tombstones. |
| `route_points` | PK `(activity_id, sequence_number)`, cascade delete, range checks. |
| `backups` | Metadata only (`storage_key`, size, SHA-256, `encrypted = true`); ciphertext lives in object storage. |
| `devices` | Unique `(user_id, external_identifier)`. |
| `idempotency_keys` | Replays first response per `(user_id, key)`; body-hash mismatch → 409. |

All timestamps are `timestamptz`. Every query filters by the authenticated `user_id`.

## Backup format (v1)

`packages/backup`. Payload = activities (with session config), raw samples, recording events,
goals and portable settings — i.e. *source* data. On restore, every activity is rebuilt by
deterministic replay, which both regenerates derived data and validates integrity; one corrupt
activity never blocks the rest. Container: magic header, gzip JSON, SHA-256 over canonical JSON;
encrypted variant wraps it in XChaCha20-Poly1305 (see SECURITY.md).
