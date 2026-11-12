# PACE Development Progress

_Last updated: 2026-11-12 (M4.7 real-world FIT validation harness)_

## Current Milestone
M0–M6 implemented in software. GPS reliability audit complete: 18 defects fixed, 8 residual risks
documented in [docs/GPS_RELIABILITY_AUDIT.md](docs/GPS_RELIABILITY_AUDIT.md). Blocked on the first
real macOS CI compile and on physical iPhone validation (M2 exit criterion).

## Completed (implemented and automatically tested)
- [x] Repository inspection, architecture and documentation (README, docs/*)
- [x] Project initialisation: pnpm monorepo, TS 6 strict, ESLint, Prettier, Jest, CI workflow
- [x] Design tokens (WCAG-checked) and component library
- [x] Domain model, units, formatting, time-zone-aware bucketing
- [x] GPS engine: validation, Kalman filtering with segment-close lag recovery, Doppler stationary gating, jump rejection timed from the last plausible fix, re-anchoring, gaps, smoothed elevation, speed
- [x] Recording state machine, session (pause, auto-pause, laps, pool swim, triathlon legs), deterministic replay
- [x] Recording coordinator: incremental persistence, journal drain, crash/finalisation recovery, start rollback, sequence continuity
- [x] Local SQLite schema, migrations, repositories, records, outbox; single-connection serialised driver
- [x] GPX import/export, CSV export, privacy zones
- [x] Encrypted, versioned backups; restore by replay
- [x] Sync engine (idempotent, backoff, conflict rules)
- [x] Analytics, records, goals services
- [x] API: auth guard, profiles, activity sync, route batches, backups, devices, entitlements, account deletion (e2e on PGlite)
- [x] Deterministic GPS replay suite (realistic run/ride, drift, poor accuracy, tunnel, jumps; correlated error)
- [x] Data-integrity suite (delivery, lifecycle, recovery, SQLite atomicity)
- [x] Training-consistency analytics: week days, active weeks, weekly streak, week-over-week change, 4-week average only when history covers it (unit-tested)
- [x] FIT validation harness (M4.7): `pnpm validate:fit` runs the real import pipeline against an in-memory database and compares FIT, companion GPX/TCX and PACE's final activity (integrity, format, processing, device totals), validates archives through the app's reader, checks a scenario manifest kept outside the repo and writes anonymised reports — harness tested with synthetic files only; **no real device files validated yet** (docs/IMPORT_VALIDATION.md)
- [x] FIT import (M4.6): independent read-only decoder (D22), FIT activities, laps, pauses, sensors and swim–bike–run triathlons through the shared import pipeline, bulk import of .fit/.fit.gz, migration 3 — logic tested with synthetic and hand-assembled files; **no real device FIT files tested yet**; screens bundled, not yet run on a device
- [x] Data portability (M4.5): TCX import, GPX cadence/power, bulk import of files/ZIP/gzip with safety limits and report, full portable export, migration 2 — logic tested; screens bundled, **not yet run on a device**
- [x] Home dashboard, activity history and activity detail redesign — logic unit-tested; UI typechecked, linted and bundled for iOS, **not yet rendered on a simulator or iPhone**

- [x] Native Swift core restructured (`Core/`), 29 XCTests via `swift test` (green in CI, Xcode 26.6)
- [x] iOS app Debug compile including the Swift module (green in CI run 43105734303)
- [x] CI split for cost: Linux checks on every change; macOS Swift tests only on native changes; full iOS suite manual (docs/TESTING.md, "Running the full iOS verification")

## Implemented, awaiting first full iOS run
- [ ] Release simulator build, launch check and Maestro first-screen flow (Phase 1, branch `ci/simulator-launch`)

## Implemented, not yet verified (requires external environment)
- [ ] iOS app run on simulator/device
- [ ] Visual check of the new Home, Activities and Activity detail screens (sizes, Dynamic Type, VoiceOver, Reduce Motion)
- [ ] Import/export on iPhone: Files picker, large Strava/Garmin archives, share sheet, migration 2 on an existing install
- [ ] FIT import with real device files (`pnpm validate:fit <folder>`, see TESTING.md) and on iPhone: picking .fit files, a Garmin Connect export archive, migration 3 on an existing install
- [ ] Legal review of the independent FIT decoder before a commercial release (DECISIONS.md D22)
- [ ] Background recording on a physical iPhone (TESTING.md device plan)
- [ ] Supabase auth flows against a real project
- [ ] MapLibre rendering with a licensed tile provider
- [ ] Cloud backup upload/download against real S3
- [ ] API against real PostgreSQL; Docker image build
- [ ] Maestro UI flows

## In Progress
- [ ] Physical-device validation (M2/M7)

## Blocked
- Physical iPhone for GPS/background tests.
- Supabase project credentials, map tile provider, S3 bucket (user-provided services).

## Tests
- Packages (real SQLite, replay, integrity, portability & FIT suites): 245 passing
- Mobile logic: 23 passing
- API end-to-end (NestJS + PGlite): 11 passing
- Native (XCTest): 29 passing (macOS CI)
- UI (Maestro): smoke-launch flow in the full iOS suite (first run pending); 2 flows written, not executed

## Known Issues / residual risks
- See audit R1–R8: permission revoked mid-recording keeps `RECORDING`; main-thread fsync cost; brief window where a failed write + crash loses a control event; GPS on while paused; OS termination gap; GPS-only elevation ±5–20 %.
- Goal sync and multi-device pull are not implemented (goals stay queued locally).
- FIT: validated only against synthetic and hand-assembled files; indoor FIT sessions (no GPS), pool-swim triathlons, multisport other than swim–bike–run, and swim chest-strap (HRM-Swim/Tri) heart rate are reported but not imported. The FIT decoder's licensing position has not had legal review (D22).
- OpenAPI document not generated yet; Sentry not wired.
- `react-dom` peer warning from a web-only dependency (iOS unaffected).

## Next Actions
1. Check the full iOS verification on PR #2 (`ci/simulator-launch`; it now runs automatically on every pull request) and its launch artifacts.
2. On a Mac/iPhone: `cd apps/mobile && npx expo prebuild --platform ios && npx expo run:ios --device`.
3. Execute the physical-device plan in docs/TESTING.md (tests 1–15) for running and cycling.
4. Decide R1 (permission revoked mid-recording → `INTERRUPTED`?).
5. Configure Supabase; run `maestro test apps/mobile/maestro`.
