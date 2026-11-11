# PACE Development Progress

_Last updated: 2026-11-11_

## Current Milestone
M0–M6 implemented in software; blocked on macOS + physical iPhone validation (M2 exit criterion).

## Completed (implemented and automatically tested)
- [x] Repository inspection
- [x] Architecture and documentation (README, docs/*)
- [x] Project initialisation: pnpm monorepo, TS 6 strict, ESLint, Prettier, Jest, CI workflow
- [x] Design tokens (WCAG-checked) and component library
- [x] Domain model, units, formatting, time-zone-aware bucketing
- [x] GPS engine: validation, Kalman filtering, drift suppression, jump rejection/re-anchoring, gaps, elevation hysteresis, speed
- [x] Recording state machine, session (pause, auto-pause, laps, pool swim, triathlon legs), deterministic replay
- [x] Recording coordinator: incremental persistence, journal drain, crash recovery, retries
- [x] Local SQLite schema, migrations, repositories, personal records, outbox
- [x] GPX import/export, CSV export, privacy zones
- [x] Encrypted, versioned backups; restore by replay
- [x] Sync engine (idempotent, backoff, conflict rules)
- [x] Analytics, records, goals services
- [x] API: auth guard, profiles, activity sync, route batches, backups, devices, entitlements, account deletion (e2e on PGlite)

## Implemented, not yet verified (requires external environment)
- [ ] iOS app on device/simulator (type-checks and Metro iOS bundle succeed; native build not run)
- [ ] Swift tracking module compile + background recording on a physical iPhone
- [ ] Supabase auth flows against a real project
- [ ] MapLibre rendering with a licensed tile provider
- [ ] Cloud backup upload/download against real S3
- [ ] API against real PostgreSQL; Docker image build
- [ ] Maestro UI flows

## In Progress
- [ ] Physical-device validation (M2/M7)

## Blocked
- macOS with Xcode (native compile) — development machine is Windows.
- Physical iPhone for GPS/background tests.
- Supabase project credentials, map tile provider, S3 bucket (user-provided services).

## Tests
- Unit/integration (packages, real SQLite): 122 passing
- Mobile logic: 4 passing
- API end-to-end (NestJS + PGlite): 11 passing
- UI (Maestro): 2 flows written, not executed
- Native (XCTest): not written yet

## Known Issues
- Kalman filter lag loses ≈3–4 m per recording segment (documented trade-off).
- Goal sync and multi-device pull are not implemented (goals stay queued locally).
- OpenAPI document not generated yet.
- Sentry not wired (error reporting logs locally).
- `react-dom` peer warning from a web-only dependency (iOS unaffected).

## Next Actions
1. On a Mac: `cd apps/mobile && npx expo prebuild --platform ios && npx expo run:ios --device`.
2. Execute the physical-device plan in docs/TESTING.md for running and cycling.
3. Configure Supabase redirect URLs; run `maestro test apps/mobile/maestro`.
4. Stand up staging API (docker-compose or managed Postgres + R2/S3) and validate backups.
5. Add XCTests for SampleJournal and LocationRecorder.
