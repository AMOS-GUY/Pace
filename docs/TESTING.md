# Testing

## Automated (run on every CI build)

| Suite | Command | Environment | Count |
|---|---|---|---|
| Domain, GPS, sports, metrics, activity engine, validation, formats, database, backup, sync, design system, core | `pnpm test:unit` | Node + real SQLite (`node:sqlite`) | 122 |
| Mobile logic (display helpers, expo-sqlite adapter) | `pnpm test:unit` | Node | 4 |
| API end-to-end (all endpoints) | `pnpm test:api` | NestJS + real PostgreSQL (PGlite) | 11 |
| Type-checks (packages, API, mobile) | `pnpm typecheck` | — | — |
| iOS JS bundle | `npx expo export --platform ios` | Metro/Hermes | — |

### What the GPS replay tests cover

Synthetic, seeded tracks (test fixtures only): clean runs/rides, realistic noise, stationary drift,
slow walking, single jumps, sustained displacement (re-anchoring), poor accuracy, out-of-order and
duplicate fixes, signal loss with and without movement, pause/resume with movement while paused,
auto-pause on stop, no auto-pause on signal loss, late-delivered batches, triathlon legs, pool
laps, and exact replay equality.

### Persistence and recovery tests

Coordinator + real SQLite: incremental persistence and acknowledgement, journal drain before
commands, crash recovery (JS dies, native keeps journaling), device restart → `INTERRUPTED`,
failed batch persist retry, failed final save + retry, discard; migrations (idempotent, data
preserved across a new migration, atomic rollback, downgrade refusal, FK enforcement); full
backup → encrypted file → restore on a fresh database by replay.

## Not yet executed (needs macOS / devices)

| Area | How | Status |
|---|---|---|
| Swift module compile | CI job `ios-native` on macOS, or `npx expo run:ios` | **Not run** (developed on Windows) |
| XCTest for `SampleJournal` / `LocationRecorder` | to be added with the first macOS build | Not written |
| Maestro flows (`apps/mobile/maestro`) | `maestro test apps/mobile/maestro` on a simulator with simulated location | Written, **not run** |
| Supabase auth against a real project | manual + Maestro `auth-onboarding.yaml` | Not run |
| API against real Postgres + S3/MinIO | docker-compose, manual | Not run (PGlite used in tests) |
| Docker image build | `docker build -f infrastructure/docker/api.Dockerfile .` | Not run |

## Physical-device test plan (required before beta, M2/M7)

Run each on a real iPhone, at least 30 min, comparing against a reference device/known course:

1. Screen unlocked, app foreground.
2. Screen locked for the whole activity.
3. App backgrounded (other apps used, music, camera).
4. Incoming phone call mid-activity.
5. Low Power Mode / low battery.
6. GPS signal loss (tunnel, underpass, dense city).
7. Airplane mode / no internet for the whole activity.
8. Device restart mid-activity → recovery as `INTERRUPTED`, data intact.
9. Force-crash / JS reload mid-activity → recovery, no gap in samples.
10. Long duration (4 h+), battery drain measurement per sport policy.
11. Permission downgraded to "Never" mid-recording.
12. Cycling at > 50 km/h descents (jump-rejection false positives).

Record for each: distance error vs reference, moving time vs truth, sample gaps, battery %/h,
any lost samples (compare journal sequence vs `route_points` count).
