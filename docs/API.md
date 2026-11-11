# API

NestJS 11 modular monolith. Base path **`/api/v1`**. JSON only. All endpoints except `health`
and `version` require `Authorization: Bearer <Supabase access token>`.

## Conventions

- **Identity** comes only from the verified token (`sub`). Request bodies never carry user ids.
- **Errors**: `{ "code": string, "message": string, "issues"?: [...], "server"?: {...} }`.
  Codes: `validation_error`, `unauthenticated`, `invalid_token`, `not_found`, `version_conflict`,
  `id_conflict`, `idempotency_key_reused`, `too_large`, `rate_limited`, `storage_unavailable`, …
- **Validation**: Zod at every boundary (`@pace/validation` shared with the app).
- **Rate limiting**: `RATE_LIMIT_PER_MINUTE` per client (default 120), stricter on backup creation.
- **Idempotency**: `Idempotency-Key` header on `POST /backups`; activity sync is idempotent by
  `(id, version, updatedAt)`; route batches by `(activity_id, sequence_number)`.
- **Pagination**: cursor-based (`?limit=&cursor=`), `nextCursor: null` at the end.
- **Logging**: method, path (no query), status, duration — never bodies, tokens or coordinates.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + database check (public) |
| GET | `/version` | API version (public) |
| POST | `/auth/profile` | Create profile for the caller (idempotent) |
| GET / PATCH | `/profiles/me` | Read / update own profile |
| POST | `/activities/sync` | Version-checked upsert: `applied` / `duplicate` / 409 `version_conflict` with `server` copy |
| POST | `/activities/:id/route-batches` | `{ firstSequence, samples[≤5000] }`, contiguous, idempotent |
| GET | `/activities` | Own activities, newest first, cursor pagination |
| GET / PATCH | `/activities/:id` | Read / edit title & description (bumps version) |
| DELETE | `/activities/:id?version=` | Tombstone + purge route points (idempotent) |
| POST | `/backups` | `{ sizeBytes ≤ 512 MB, checksumSha256, formatVersion, encrypted: true }` → `{ backup, uploadUrl }` (presigned PUT, 15 min) |
| POST | `/backups/:id/complete` | Verifies the object exists with the declared size |
| GET | `/backups` | List own backups |
| GET | `/backups/:id` | `{ backup, downloadUrl }` (presigned GET, 10 min) |
| DELETE | `/backups/:id` | Deletes object and metadata |
| GET / POST / DELETE | `/devices`, `/devices/:id` | Register sensors/watches |
| GET | `/entitlements` | Plan features from configuration (no prices) |
| DELETE | `/account` | Deletes all user data + backups, then the Supabase auth user |

## Sync semantics

Client → server only in v1 (multi-device pull is M5+). The client's outbox pushes activity
metadata, then raw route batches. On `version_conflict` the client merges with
`resolveActivityConflict` (recorded data local-wins; title/description newest-wins; deletions
win) and re-queues. Other users' ids yield `id_conflict` without revealing data.

## Configuration

Validated at startup (`apps/api/src/config/env.ts`) — the process exits with a precise list of
missing/invalid variables. See `.env.example`.

## Running

```bash
pnpm build:api && pnpm --filter @pace/api db:migrate && pnpm --filter @pace/api start
```

An OpenAPI document is not generated yet (see ROADMAP); this file is the contract and the
end-to-end tests in `apps/api/test` exercise every endpoint.
