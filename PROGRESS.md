# PACE Development Progress

_Last updated: 2026-11-12 (GPS reliability & data-integrity audit)_

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
- [x] Home dashboard, activity history and activity detail redesign — logic unit-tested; UI typechecked, linted and bundled for iOS, **not yet rendered on a simulator or iPhone**

## Implemented, awaiting first macOS CI run
- [ ] Native Swift core restructured (`Core/`), 29 XCTests via `swift test`
- [ ] iOS app compile including the Swift module — **correction:** the previous "macOS build successful" did not prove this (failures were masked by a pipe without `pipefail`; the Swift journal had a syntax error). Fixed; awaiting a genuine green run.

## Implemented, not yet verified (requires external environment)
- [ ] iOS app run on simulator/device
- [ ] Visual check of the new Home, Activities and Activity detail screens (sizes, Dynamic Type, VoiceOver, Reduce Motion)
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
- Packages (real SQLite, replay & integrity suites): 163 passing
- Mobile logic: 19 passing
- API end-to-end (NestJS + PGlite): 11 passing
- Native (XCTest): 29 written, run on macOS CI
- UI (Maestro): 2 flows written, not executed

## Known Issues / residual risks
- See audit R1–R8: permission revoked mid-recording keeps `RECORDING`; main-thread fsync cost; brief window where a failed write + crash loses a control event; GPS on while paused; OS termination gap; GPS-only elevation ±5–20 %.
- Goal sync and multi-device pull are not implemented (goals stay queued locally).
- OpenAPI document not generated yet; Sentry not wired.
- `react-dom` peer warning from a web-only dependency (iOS unaffected).

## Next Actions
1. Check the macOS CI job: `swift test` and the app build must both pass; fix any compile errors.
2. On a Mac/iPhone: `cd apps/mobile && npx expo prebuild --platform ios && npx expo run:ios --device`.
3. Execute the physical-device plan in docs/TESTING.md (tests 1–15) for running and cycling.
4. Decide R1 (permission revoked mid-recording → `INTERRUPTED`?).
5. Configure Supabase; run `maestro test apps/mobile/maestro`.
