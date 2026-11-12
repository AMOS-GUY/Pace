# Testing

## Automated suites

| Suite | Command | Environment | Tests | Runs in CI |
|---|---|---|---|---|
| Shared packages (domain, GPS engine, sports, metrics, activity engine, validation, formats, database, backup, sync, design system, core) | `pnpm test:unit` | Node + real SQLite (`node:sqlite`) | 151 | Linux job |
| Mobile logic (display helpers, expo-sqlite adapter, native entry validation) | `pnpm test:unit` | Node | 8 | Linux job |
| API end-to-end (every endpoint) | `pnpm test:api` | NestJS + real PostgreSQL (PGlite) | 11 | Linux job |
| **Native Swift core** (journal, recorder, serialisation) | `cd apps/mobile/modules/pace-tracking/ios && swift test` | macOS, XCTest | 29 | iOS workflow: on native changes, and in the full suite |
| iOS app compile incl. Swift module (Release and Debug) | `expo prebuild` + `xcodebuild` | macOS, iOS Simulator SDK | — | iOS workflow, full suite (manual) |
| Release app launch on a simulator + Maestro first screen | `scripts/ci/ios-simulator-launch.sh`, `maestro/smoke-launch.yaml` | macOS, iOS Simulator | — | iOS workflow, full suite (manual) |
| Type-checks | `pnpm typecheck` | — | — | Linux job |
| iOS JS bundle | `npx expo export --platform ios` | Metro/Hermes | — | Linux job |

The macOS jobs run with `shell: bash` (`-eo pipefail`) and fail if the `PaceTracking` pod is
not autolinked. Before the reliability audit it ran without `pipefail`, so its earlier "success"
did not prove the native code compiled (see GPS_RELIABILITY_AUDIT.md, F1).

## CI: what runs when

macOS runner minutes are billed at 10x on private repositories, and one iOS build takes
17-28 minutes, so only the cheap checks run on every change.

| Workflow / job | Runner | Runs | Duration |
|---|---|---|---|
| `CI` / Typecheck, lint, test | Linux | every push to `main` and `ci/**`, every pull request | ~2 min |
| `iOS` / Swift native tests | macOS | a push that changes `apps/mobile/modules/**` or `ios.yml`; or manually (`suite: swift-tests`) | ~2 min |
| `iOS` / Full iOS verification | macOS | manually only (`suite: full`, or the `ios-full-verification` PR label) | ~55 min (~35 without the Debug build) |

The full suite is one job: Swift tests, toolchain check, prebuild, pods, autolink check,
Release simulator build, launch check (alive after 30 s, no crash report, no fatal log line),
Maestro first-screen flow, and the Debug (development build) compile. It reuses one checkout,
install and `pod install` for both builds. The Debug build also runs when an earlier launch
step failed, so one paid run reports both results; the job still fails if any step failed.

## Running the full iOS verification

Run it before every release, and before merging changes to native code, the iOS
configuration or dependencies.

**From the Actions tab** (needs `ios.yml` on `main`: GitHub shows "Run workflow" only for
workflows on the default branch):

1. Open the repository on GitHub, then the **Actions** tab.
2. In the left sidebar, select the **iOS** workflow.
3. Click **Run workflow** (right side, above the run list).
4. Choose the **branch** to verify, set **suite** to `full`, and leave **debug_build** checked
   for the complete suite (uncheck it to skip the ~20 min Debug compile).
5. Click the green **Run workflow** button. The run appears in the list after a few seconds.

**From a pull request** (works before `ios.yml` is on `main`):

1. Create the label once: **Issues** or **Pull requests** -> **Labels** -> **New label**, named
   exactly `ios-full-verification`.
2. On the pull request, add the label under **Labels**. This starts the full suite on the
   pull request's merge commit.
3. To run it again after new commits, remove the label and add it again, or use **Re-run all
   jobs** on the run for the same commit.

**From the command line:** `gh workflow run ios.yml --ref <branch> -f suite=full -f debug_build=true`
(same default-branch requirement as the button).

**Reading the result:** open the run, then the **Full iOS verification** job. Every step must
be green. The run's **Artifacts** section holds `simulator-launch` (`device.log`,
`after-30s.png`, any crash reports, `simulator.txt`, `maestro-junit.xml`, Maestro screenshots
and `xcodebuild-release.log`) and `xcodebuild-log` (the Debug build log).

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
| Swift XCTests and native Debug compile | Passed in CI (run 43105734303, Xcode 26.6) |
| Release simulator launch + Maestro smoke flow | Written; first run pending (full iOS suite) |
| Maestro flows `record-run`, `auth-onboarding` | Written, not run (need Supabase) |
| Supabase auth against a real project | Not run |
| API against real Postgres + S3/MinIO | Not run (PGlite used in tests) |
| Docker image build | Not run |
| Physical-device plan above | Not run |
