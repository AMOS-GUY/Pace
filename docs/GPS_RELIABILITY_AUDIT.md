# GPS reliability & data-integrity audit

_Date: 2026-11-12 · Scope: native iOS tracking, native→JS synchronisation, SQLite persistence,
recovery, GPS filtering and distance accuracy. No product features were added._

## Summary

The audit found **18 defects**, all fixed, and **8 residual risks** that are documented rather
than changed (they need a product decision or physical-device data).

The most serious finding was a process failure. The previous CI "iOS native build: successful"
did **not** prove the Swift module compiled. The build step piped `xcodebuild` into `tail`
without `pipefail`, so failures were hidden, and the Swift journal actually contained a syntax
error. The earlier claim that "the Swift module compiles" is retracted. CI is now fixed, and the
native code has 29 XCTests. They will run for the first time on the next macOS CI run.

> **Status update (2026-11-12):** the 29 XCTests and the native Debug build first passed in CI in
> run 43105734303. The full iOS verification then passed in [run 43238428111](https://github.com/AMOS-GUY/Pace/actions/runs/43238428111): Release and Debug simulator
> builds, a simulator launch check and the Maestro first-screen flow. None of this tests GPS
> recording or background recording on a physical iPhone, which remain outstanding.

Measured on the deterministic replay suite, which uses correlated GPS error:

| Metric | Before | After |
|---|---|---|
| Distance, city run / hilly ride | 0.36 % / 0.21 % | 0.30 % / 0.18 % |
| Stationary urban-canyon drift, 15 min | **166 m** | **0 m** |
| Climbing, city run (truth 103 m) | **323 m** | 99 m |
| Climbing, hilly ride (truth 250 m) | **419 m** | 244 m |
| Spurious climbing on flat routes | 52–88 m | 5–10 m |
| Filter lag lost per recording segment | 3–4 m | < 0.5 m (clean track) |
| 2 km spike after standing still | **counted** | rejected |

## Severity scale

**Critical** – could ship broken without anyone knowing. **High** – loses or corrupts recorded
data, or makes core metrics wrong. **Medium** – loses data in specific failure windows or
noticeably degrades accuracy. **Low** – edge cases.

## Findings and fixes

| ID | Area | Severity | Finding | Fix | Test |
|---|---|---|---|---|---|
| F1 | CI / native | Critical | macOS job piped `xcodebuild` into `tail` under the default shell (no `pipefail`), masking build failures. `SampleJournal.swift` contained a literal newline inside a string literal, so it could not compile. | Job uses `shell: bash` (`-eo pipefail`), verifies the `PaceTracking` pod is autolinked, detects workspace/scheme, and runs `swift test` first. Swift code restructured and re-reviewed. | CI job `ios-native` |
| F2 | Native lifecycle | High | (a) The recorder was owned by the Expo module instance, so a JS runtime reload deallocated `CLLocationManager` and stopped recording. (b) On module creation the recorder automatically restarted journaling for the last activity. After a force-quit and relaunch hours later, JS saw "native still recording", kept the session `RECORDING`, and counted the whole downtime as moving time; the straight-line chord across the gap could also be counted as distance. | Recorder is a process-wide singleton (survives JS reloads). No automatic restart: after a process restart the activity is recovered as `INTERRUPTED` and the athlete chooses to resume or finish. | `LocationRecorderTests.testANewProcessDoesNotRestartRecordingByItself`; `recording-integrity` "JS reload", "force-quit" |
| F3 | SQLite | High | expo-sqlite's `withExclusiveTransactionAsync` opens a **new connection** per transaction. Per-connection pragmas (`foreign_keys=ON`, `synchronous=FULL`) did not apply inside any transaction, and concurrent writes on the main connection fail with `database is locked`. Node tests used one connection and could not see this. | Driver now runs everything on the one configured connection with `withTransactionAsync`, serialised by an in-process lock so nothing interleaves. | `expo-sqlite-driver.test.ts`: FK enforced in transaction; no interleaving |
| F4 | Native→JS | High | The native boundary validated raw samples with a strict schema (altitude −1 000…10 000 m, timestamp ≥ 2000). A well-typed but implausible fix was dropped, leaving a permanent hole in the gap-free sequence, so ingestion stalled for the rest of the activity. Backups containing such a sample would also fail to restore. | Raw-sample schema is type-only (plus coordinate range); plausibility is judged by the GPS engine, which keeps and rejects such samples. Structurally malformed entries stop delivery and are reported, never silently skipped; they stay in the native journal. | `validation.test.ts`, `entries.test.ts` |
| F5 | Native→JS | High | An acquisition-only fix delivered after recording had started was counted as a recorded sample. That shifted the expected sequence by one, so the first real journal entry was discarded as a "duplicate" and live and replayed sessions diverged. | Acquisition fixes only update the GPS indicator and are never counted once an activity exists. | `recording-integrity` "acquisition fix delivered after recording started" |
| F6 | GPS filtering | High | Jump plausibility compared against the anchor's timestamp. After standing still, the anchor is minutes old, so a 2 km multipath spike looked like a slow 3 m/s move and was **counted**. | Elapsed time is measured from the latest plausible fix. | `gps-engine.test.ts` "multipath spike after a long stationary period" |
| F7 | Recovery | Medium | The interruption time was taken from samples loaded from SQLite only, ignoring samples drained from the native journal during recovery. | Session tracks `lastDataAt` (newest sample or event) after the drain. | `recording-integrity` "force-quit" (moving time = last captured sample) |
| F8 | Recovery | Medium | A crash after "finished" was persisted but before the summary was saved left the session in `FINALIZING`, with no UI action available. | Recovery completes the save (or reports `FAILED` with retry). | `recording-integrity` "completes a save that was interrupted" |
| F9 | Finalisation | Medium | Finish drained the journal *before* stopping native. Samples captured in between were never persisted and were then deleted along with the journal. | Stop native → drain → finish event → persist → delete journal. | `recording-integrity` "samples captured up to the tap are stored" |
| F10 | Start | Medium | If native failed to open its journal, an activity row remained with nothing recording; a retry then collided on the same id. | Rollback: the record is discarded and the retry gets a fresh id. | `recording-integrity` "no orphan activity" |
| F11 | Journal | Medium | If the journal file was lost, numbering restarted at 0 and JS would drop every new sample as a duplicate. | `startRecording(id, policy, nextSequence)`: native never assigns a number below what JS holds. | `LocationRecorderTests.testLostJournalStillHonoursTheJavaScriptSequence`; `recording-integrity` "never reuses sequence numbers" |
| F12 | Journal | Medium | After a torn final line (power loss mid-write), the next appended line was glued onto the fragment and became unreadable. | Tail is repaired (newline appended) when the file is opened. | `SampleJournalTests.testTornTailIsRepairedBeforeAppending` |
| F13 | Journal | Low | If the compaction rewrite failed (e.g. disk full), the journal handle stayed closed and every later fix failed to journal. | Original file is reopened on failure (the atomic write leaves it intact). | code review (needs a full disk to reproduce) |
| F14 | Session | Medium | Fixes recorded *before* a resume but delivered after it were counted into the new segment. | Samples older than the current start/resume are excluded from metrics (still stored raw). | `recording-integrity` "keeps raw samples recorded while paused" |
| F15 | Elevation | Medium | Correlated GPS altitude error wandered past the 3 m hysteresis: 2–3× inflated climbing and 50–90 m on flat routes. | Exponential smoothing (τ = 10 s, time-based) before a 5 m hysteresis; same in splits. Parameters chosen from a sweep, see § Accuracy. | replay suite (all scenarios) |
| F16 | Distance | Medium | Slow urban-canyon wander (σ = 6 m, τ = 60 s) is indistinguishable from slow walking by position alone: 166 m in 15 min. | Doppler speed gating: a fix whose platform speed is below a per-sport threshold is stationary. Displacement is measured from the anchor, so gating delays but never loses real movement. | replay "stationary drift"; existing slow-walk test |
| F17 | Distance | Low | Filter lag (≈3–4 m) was lost at every pause, gap and finish, and two tests had been relaxed to tolerate it. | Segment close re-solves the last leg against the latest *raw* fix (a real sample) when moving. Idempotent. Tests restored to < 0.5 m. | `gps-engine.test.ts` gap/pause/idempotency |
| F18 | Native→JS | Low | Malformed native entries were dropped without a trace. | See F4: delivery stops and the error is reported; entries remain in the journal. | `entries.test.ts` |

## Residual risks (documented, not changed)

| ID | Risk | Why not changed | Mitigation / next step |
|---|---|---|---|
| R1 | If location permission is revoked mid-recording, the session stays `RECORDING` (UI shows "GPS signal lost"); moving time continues. | Converting to `INTERRUPTED` is a product behaviour change. | Device test #11; decide in M7. |
| R2 | Journal fsync runs on the main thread per Core Location batch (typically 1 fix/s). | Needs on-device profiling before changing threading. | Instruments during the device test plan. |
| R3 | Between a failed SQLite batch write and the next successful one, the in-memory session is ahead of disk. A crash in that window loses the *control event* (pause/lap); samples are safe in the journal. | Rare (requires disk failure + crash); fixing requires event journaling in native. | Monitor `onError` reports in beta. |
| R4 | GPS stays on while paused (needed to keep a fix and for auto-resume). | Battery trade-off. | Measure battery %/h on device. |
| R5 | iOS does not relaunch apps for standard location updates after termination. An activity killed by the OS has a gap until the user reopens the app. | Platform behaviour. Significant-change monitoring could wake the app but needs "Always" permission. | Recovered as `INTERRUPTED`; nothing captured is lost. |
| R6 | GPS-only elevation still has ≈5–20 % error (smaller on long climbs, larger on short rolling hills). | Physics of GPS altitude. | Barometric altitude source (CMAltimeter) is the planned fix. |
| R7 | Swift tests and the native build have not yet run (development machine is Windows). | Needs macOS. | **Resolved 2026-11-12:** `swift test` and the build pass in CI with pipefail ([run 43238428111](https://github.com/AMOS-GUY/Pace/actions/runs/43238428111)). |
| R8 | `onAuthorizationChange` events are emitted by native but not consumed by the coordinator. | Tied to R1. | — |

## Accuracy: scenarios, tolerances and justification

All scenarios are generated deterministically (`gps-engine/src/test-fixtures/realistic-routes.ts`)
and replayed through the full recording stack. Every run also asserts that replaying the persisted
events and raw samples reproduces the identical summary.

**Error model.** Horizontal error is a first-order Gauss–Markov (AR(1)) process: σ = 2.5–3 m and
τ = 20–25 s on open sky; σ = 6 m and τ = 60 s for urban-canyon drift; σ = 25 m during degraded
bursts. Vertical error has σ = 3–4 m and τ = 30 s. These match published characteristics of
smartphone GNSS (≈3–5 m CEP in open sky, slowly varying errors) and iOS-reported accuracies.

| Scenario | Truth | Measured | Error | Tolerance | Justification |
|---|---|---|---|---|---|
| City run, 4 laps, 48 corners, 3 stops | 11 650 m | 11 685 m | +0.30 % | ±1.5 % | Typical consumer-device distance accuracy is 1–2 %; corner cutting and residual noise inflation must stay inside it. |
| Hilly ride, 5–16 m/s, 2 stops | 19 966 m | 20 001 m | +0.18 % | ±1.0 % | Faster motion averages out relative error. |
| Ride climbing | 250 m | 244 m | −2 % | ±10 % | Long monotonic climb; smoothing barely affects it. |
| City-run climbing (±8 m rolling) | 103 m | 99 m | −4 % | ±20 % | Short hills are partly absorbed by smoothing + hysteresis; ±20 % is the documented GPS-only limit (R6). |
| Ride moving time with auto-pause | 2 475 s | 2 473 s | −2 s | ±24 s | Each stop needs the speed window to fall and then rise again: ≤ 12 s per stop. |
| Ride max speed | 16.0 m/s | 16.75 m/s | +0.75 | < peak + 1.0 | Over a 5 s window, correlated error contributes ≈0.3 m/s σ; the maximum of ~800 windows is ≈3σ. |
| Stationary drift, 15 min | 0 m | 0 m | — | < 30 m | Must be negligible versus any real activity (< 0.3 % of a 10 km run). |
| Poor-accuracy burst (60 s over corners) | 2 910 m | 2 863 m | −1.6 % | ±2.5 %, must be negative | Degraded fixes are rejected and the gap is bridged by a chord; across corners the chord is necessarily shorter than the path. |
| Tunnel, 90 s at 9 m/s | 5 991 m | 6 001 m | +0.16 % | ±1 %; chord ±15 m | Straight tunnel: the chord equals the true path. |
| Spikes 450 m / 300 m ×2 / cluster 150 m ×3 | 2 910 m | 2 926 m | +0.53 % | < +25 m vs truth, ±2 % | Spikes must add nothing (≈1 800 m if not rejected). The self-consistent 3-fix cluster forces two re-anchors and costs a few seconds of progress. |
| 0.2 Hz sampling | true path sampled at 0.2 Hz | — | < 1 % | ±1 % vs sampled truth | At 0.2 Hz the path between fixes is unobservable; the fair reference is the true path at the same instants. |

**Known accuracy limitations** (communicate to users where relevant):

- Distance across a signal gap is a straight line. On winding roads or tunnels with curves it is
  short.
- A self-consistent multipath cluster (≥ 3 fixes) cannot be told apart from real movement in
  real time. It is re-anchored, not counted, so a few seconds of real progress may be lost.
- Doppler-speed gating relies on Core Location's speed. Imported GPX has no speed, so imported
  tracks fall back to position-only drift suppression.
- Elevation without a barometer: see R6.

## Verified vs. requires a physical iPhone

**Verified by automated tests in this audit** (Node, real SQLite, and PostgreSQL via PGlite):

- Raw-sample preservation; contiguous, duplicate-free sequences under duplicate, out-of-order,
  missed and late deliveries; acknowledgement only after durable storage.
- Recovery after JS reload, force-quit, device restart, native-module failure, and crash during
  finalisation; correct interruption timing.
- Pause/resume/finish/discard data handling; start rollback; sequence continuity after journal loss.
- SQLite atomicity of batches, retry after a failed write, FK enforcement inside transactions on
  the expo-sqlite adapter (simulated single connection).
- GPS accuracy on the replay suite (table above); deterministic replay equality.

**Written at audit time for the next macOS CI run** (cannot run on Windows). Both now pass in CI ([run 43238428111](https://github.com/AMOS-GUY/Pace/actions/runs/43238428111)):

- 29 Swift XCTests covering journal durability, sequence numbering, compaction, torn-tail repair,
  journal-before-notify, acquisition vs recording, process restart, policy switching, deletion
  rules, authorisation and serialisation.
- Full app compile with the real Swift module (now with pipefail and an autolink check).

**Requires a physical iPhone** (nothing above substitutes for these):

- Background delivery with the screen locked; `CLBackgroundActivitySession`; the blue indicator.
- Real Core Location behaviour: first-fix time, accuracy, Doppler speed reliability while walking
  slowly, behaviour in tunnels and urban canyons, distance against a measured course.
- OS termination, low-power mode, incoming calls, permission changes mid-activity (R1).
- File protection while locked (`completeUntilFirstUserAuthentication`) on real hardware.
- Battery drain per sport policy and main-thread fsync cost (R2, R4).
- expo-sqlite behaviour on device (the adapter is tested against a faithful simulation, not the
  native library).

The step-by-step device protocol is in [TESTING.md](TESTING.md#physical-device-test-plan).
