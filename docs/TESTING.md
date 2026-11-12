# Testing

## Automated suites

| Suite | Command | Environment | Tests | Runs in CI |
|---|---|---|---|---|
| Shared packages (domain, GPS engine, sports, metrics, activity engine, validation, formats, database, backup, sync, design system, core) | `pnpm test:unit` | Node + real SQLite (`node:sqlite`) | 232 | Linux job |
| Mobile logic (display helpers, dashboard, activity and import view models, expo-sqlite adapter incl. migrations, native entry validation) | `pnpm test:unit` | Node | 23 | Linux job |
| API end-to-end (every endpoint) | `pnpm test:api` | NestJS + real PostgreSQL (PGlite) | 11 | Linux job |
| **Native Swift core** (journal, recorder, serialisation) | `cd apps/mobile/modules/pace-tracking/ios && swift test` | macOS, XCTest | 29 | macOS job |
| iOS app compile incl. Swift module | `expo prebuild` + `xcodebuild` | macOS, iOS Simulator SDK | — | macOS job |
| Type-checks | `pnpm typecheck` | — | — | Linux job |
| iOS JS bundle | `npx expo export --platform ios` | Metro/Hermes | — | Linux job |

The macOS job runs with `shell: bash` (`-eo pipefail`) and fails if the `PaceTracking` pod is
not autolinked. Before the reliability audit it ran without `pipefail`, so its earlier "success"
did not prove the native code compiled (see GPS_RELIABILITY_AUDIT.md, F1).

## Data portability suite (M4.5)

Runs locally with real SQLite (`node:sqlite`) and realistic files: Garmin-style TCX
(TrainingCenterDatabase v2, ActivityExtension `TPX`, laps with calories and device summaries,
`Creator`) and Strava-style GPX (TrackPointExtension hr/cad/atemp, power, waypoints), built from
the deterministic synthetic tracks (`packages/formats/src/test-fixtures/device-files.ts`).

- **Parsing:** sport, notes, laps, pauses (a lap boundary is not a pause), heart rate, cadence,
  power; implausible sensor values skipped and counted; every kind of unimported information
  listed; indoor files refused with an explanation; DTD/entity, oversize and non-activity files
  refused.
- **Shared pipeline:** the same track as GPX and as TCX gives identical distance, moving and
  elapsed time, elevation, pace and max speed.
- **Duplicates:** same file again (either format), a differently sampled copy of the same session
  and PACE's own GPX export of a recorded activity are refused and name the existing activity;
  back-to-back sessions are not.
- **Archives:** mixed archive (valid, malformed, duplicate, FIT, photos, CSV, nested ZIP, `../`
  path); ZIP and gzip bombs stopped by bytes actually produced; entry-count and size limits;
  truncated archive keeps earlier imports and reports the cut-off file; retry completes it;
  repeated import adds nothing; 250-activity archive; cancellation between files; progress.
- **Export:** archive contents and row counts match the database; planted secrets, deleted
  activities, account/sync identifiers and coordinates (outside GPX) never appear; the privacy
  zone holds for every point of every track; export → import into a new database reproduces the
  activities and metrics (moving time within one GPS fix per segment edge for recorded activities,
  exact for imported ones); importing an export back into its source adds nothing.
- **Migration 2:** a populated v1 database keeps every row and child row; foreign keys are
  enforced again afterwards; a lossy rebuild is rolled back.

## FIT import suite (M4.6)

PACE reads FIT with its own decoder (`packages/formats/src/fit-decoder.ts`, see DECISIONS.md D22).
Its tests do not rely only on files written by our own test encoder
(`test-fixtures/fit-encoder.ts`, which has its own bit-by-bit CRC and value encoding):

- **Independent checks:** the CRC matches the published CRC-16/ARC check value (`123456789` →
  0xBB3D); a hand-assembled byte fixture with exactly known values (45°, 22.5°, 100 m, FIT time
  10⁹ s = 2021-09-08T01:46:40Z, a compressed timestamp) decodes exactly.
- **Container:** 12- and 14-byte headers, header checksum 0, both byte orders, every base type,
  arrays, UTF-8 strings, "not set" markers never turned into numbers, uninterpretable fields
  skipped and counted, compressed timestamps including the 32-second rollover, developer fields,
  chained files with their own definitions and timestamps.
- **Damaged and hostile files:** truncation at every byte and any single corrupted byte are
  rejected before anything is decoded; structurally broken files with a correct checksum
  (undefined local message, message past the end, short definition, unknown byte order, zero-size
  field, compressed timestamp first, trailing garbage) are rejected; size, message-count and
  chained-file limits; 3 000 seeded random files never fail with anything but a FIT error.
- **Activity mapping (`fit.ts`):** a lap boundary is not a pause, a timer stop/start is; the
  same run as FIT and as TCX gives identical point times, laps and sensor samples, with
  positions within 2·10⁻⁷° and altitude within 0.16 m (FIT stores 0.2 m steps); compressed
  timestamps, big-endian messages and 12-byte headers give identical results; chained activity
  files become separate activities and other chained files are reported; sports map (unknown
  ones need a choice); triathlon swim–T1–bike–T2–run keeps its four leg starts and only real lap
  changes; other multisport sequences and pool-swim triathlons are refused with the reason.
- **Sensor fidelity:** heart rate, cadence (with fractional cadence, e.g. 86.5) and power keep
  their own record times and units; sparse values stay sparse (nothing is interpolated);
  implausible values are skipped and counted; records without a position keep their sensors.
- **Reporting:** developer fields by name, device distance, temperature, calories, device and
  session summaries, device details, HRV, swim chest-strap heart rate and unknown data are all
  listed as not imported; GPS points recorded while the timer was stopped, repeated or
  out-of-order times and device-relative clocks are reported or refused.

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
| Import and export on iOS: Files-app picker with several files, reading large archives through `FileHandle` (memory, time for a multi-GB Strava export), share sheet for the ZIP, cache cleanup, migration 2 on an existing install | Logic tested in Node; device behaviour not yet verified |
| Supabase auth against a real project | Not run |
| API against real Postgres + S3/MinIO | Not run (PGlite used in tests) |
| Docker image build | Not run |
| Physical-device plan above | Not run |
