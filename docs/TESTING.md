# Testing

## Automated suites

| Suite | Command | Environment | Tests | Runs in CI |
|---|---|---|---|---|
| Shared packages (domain, GPS engine, sports, metrics, activity engine, validation, formats, database, backup, sync, design system, core) | `pnpm test:unit` | Node + real SQLite (`node:sqlite`) | 163 | Linux job |
| Mobile logic (display helpers, dashboard and activity view models, expo-sqlite adapter, native entry validation) | `pnpm test:unit` | Node | 19 | Linux job |
| API end-to-end (every endpoint) | `pnpm test:api` | NestJS + real PostgreSQL (PGlite) | 11 | Linux job |
| **Native Swift core** (journal, recorder, serialisation) | `cd apps/mobile/modules/pace-tracking/ios && swift test` | macOS, XCTest | 29 | macOS job |
| iOS app compile incl. Swift module | `expo prebuild` + `xcodebuild` | macOS, iOS Simulator SDK | — | macOS job |
| Type-checks | `pnpm typecheck` | — | — | Linux job |
| iOS JS bundle | `npx expo export --platform ios` | Metro/Hermes | — | Linux job |

The macOS job runs with `shell: bash` (`-eo pipefail`) and fails if the `PaceTracking` pod is
not autolinked. Before the reliability audit it ran without `pipefail`, so its earlier "success"
did not prove the native code compiled (see GPS_RELIABILITY_AUDIT.md, F1).

## Deterministic GPS replay suite

`packages/activity-engine/src/gps-replay-suite.test.ts`, using scenario generators in
`packages/gps-engine/src/test-fixtures/realistic-routes.ts`.

- **Error model:** correlated (AR(1)) horizontal and vertical error, varying reported accuracy,
  seeded and fully reproducible.
- **Scenarios:**
  - city run (4 laps, 48 corners, junction stops)
  - hilly ride (climb, fast descent, auto-pause at traffic lights)
  - 15-minute urban-canyon stationary drift
  - 60 s poor-accuracy burst over corners
  - 90 s tunnel
  - multipath spikes plus a self-consistent displaced cluster
- **Fault invariants:** duplicated fixes, out-of-order fixes, invalid fixes (null island,
  negative accuracy, NaN), and 0.2 Hz thinning.
- **Every scenario** is run through the full `RecordingSession` stack and also re-run via
  `replaySession`. The two results must be identical.
- **Tolerances** are derived from the error model and documented with their reasoning in
  GPS_RELIABILITY_AUDIT.md § Accuracy. To print the results table:
  `PACE_GPS_REPORT=1 npx jest gps-replay-suite`.

Synthetic data lives only in `test-fixtures/` and is never used for user-visible activities.

## Data-integrity suite

`packages/database/src/recording-integrity.test.ts` runs the coordinator against the real SQLite
recording store and a bridge double that follows the Swift contract. The bridge double journals
before notifying, keeps a persisted sequence high-water mark, and accepts `nextSequence` on start.

- **Invariant checked everywhere:** stored raw sequences are exactly `0…n−1`.
- **Delivery:** duplicate delivery, out-of-order batches, late acquisition fixes, and a fully
  suspended JS runtime.
- **Lifecycle:** finish ordering, pause with movement and late fixes, discard, and native start
  failure.
- **Recovery:** JS reload, force-quit, journal loss, crash during finalisation, and an
  unavailable native module.
- **SQLite:** batch atomicity, and retry after a failed write.

Native-side counterparts of the same contract live in the Swift XCTests.

## Physical-device test plan

Required before beta (M2 exit criterion and M7). Use a real iPhone with a development build and
run each test for at least 30 minutes, unless stated otherwise, on a measured course or alongside
a reference device.

| # | Scenario | Pass criteria |
|---|---|---|
| 1 | Screen unlocked, app in foreground | Distance within 2 % of the course |
| 2 | Screen locked for the whole activity | No sample gap > 5 s (compare `route_points` timestamps) |
| 3 | App backgrounded (music, camera, other apps) | As #2 |
| 4 | Incoming phone call mid-activity | Recording continues; no gap > call setup time |
| 5 | Low Power Mode / battery < 20 % | Recording continues; note fix interval |
| 6 | Signal loss (tunnel, underpass, dense city) | Gap recorded; no invented points; resumes automatically |
| 7 | Airplane mode for the whole activity | Saved locally; syncs later |
| 8 | Device restart mid-activity | Recovered as `INTERRUPTED`; all journaled samples present; moving time ends at the last fix |
| 9 | Force-quit from the app switcher mid-activity | As #8 |
| 10 | JS reload (dev menu) mid-activity | Recording continues without a gap |
| 11 | Location permission set to "Never" mid-recording | Documented behaviour (see audit R1) |
| 12 | Long duration (4 h+), each sport policy | Battery %/h recorded; no growth in journal size beyond the compaction bound |
| 13 | Cycling descents > 50 km/h | No false jump rejection (compare against a cycling computer) |
| 14 | Standing still for 10 min outdoors and indoors | Added distance < 30 m |
| 15 | Slow walking (< 1 m/s) | Distance not suppressed by Doppler gating (compare course) |

For every run, record:

- distance error against the reference;
- moving time against a stopwatch;
- the largest gap between fixes;
- battery percentage used per hour;
- journal sequence count against the stored `route_points` count, which must be equal.

## Not yet executed

| Area | Status |
|---|---|
| Swift XCTests and native compile | Written; first run on the next macOS CI job |
| Maestro flows (`apps/mobile/maestro`) | Written, not run |
| Home dashboard, activity history and activity detail UI (rendering, layout on iPhone SE to Pro Max, animation, VoiceOver) | Typechecked, linted and bundled for iOS (`expo export`); not yet rendered on a simulator or device |
| Supabase auth against a real project | Not run |
| API against real Postgres + S3/MinIO | Not run (PGlite used in tests) |
| Docker image build | Not run |
| Physical-device plan above | Not run |
