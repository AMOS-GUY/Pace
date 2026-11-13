# M4.7 release readiness: FIT import and real-world validation

_Status as of 2026-11-13. Nothing in this document has been verified with real device recordings
or on a physical iPhone unless it says so explicitly._

## 1. Executive summary

PACE imports FIT, TCX, GPX and ZIP/gzip exports through one import pipeline: the same session
engine as live recordings. M4.6 added an independent FIT decoder. M4.7 added
`@pace/import-validation` (`pnpm validate:fit`), which checks the import against real exports
without ever storing or revealing them.

**Done:**
- the decoder and import, tested with synthetic and hand-assembled files;
- the validation harness, audited twice. 10 harness defects were fixed (A1, C1–C4, D1–D4,
  E3), and 8 of the fixes were re-verified by mutation checks.

**What is not done:**
- **No real device FIT file has been validated.** No Garmin, COROS, Wahoo or Zwift recording has
  been tested.
- **Nothing has run on a physical iPhone.** The app builds and launches on an iOS simulator in CI
  and shows its first screen; that is all.
- Three app export gaps (R1–R3) were found. Decided 2026-11-13: R1 is fixed on `fix/gpx-power-export`
  (awaiting merge); R2 and R3 are documented limitations, with no custom GPX extension.
- The FIT decoder's legal position has not had legal review (D22).

**Verdict:** ready for real-device validation, **not** ready to be described as compatible with
any manufacturer.

## 2. Implemented functionality

| Area | What exists | Evidence |
|---|---|---|
| FIT decoder | Headers (12/14 bytes), header and file CRC-16, definitions in both byte orders, every base type and invalid marker, compressed timestamps, developer fields (counted, named, not decoded), chained files, limits (25 MB, 2 M messages, 64 chained files) | Synthetic and hand-assembled tests, fuzz test with 3,000 random files |
| FIT mapping | file_id, sport, session, lap, record, timer events, field descriptions. Semicircles to degrees, enhanced altitude, heart rate, cadence plus fractional cadence, power. Swim–T1–bike–T2–run triathlons. | Synthetic tests |
| GPX/TCX | Tracks, segments, laps (TCX), heart rate, cadence, power extensions, sport mapping (`sport-mapping.test.ts`) | Synthetic tests built from Garmin- and Strava-shaped files |
| Archives | Streaming ZIP, gzip with CRC-32 and length check, unsafe-path refusal, nested archives refused, per-file, total, entry-count and size limits, cancellation and retry | Synthetic tests |
| Import pipeline | `importTrack` → RecordingSession → `writeCompletedActivity` in one transaction; duplicate detection by fingerprint and by ≥ 50 % overlap; migration 3 (`imported_fit`) | Tests on real SQLite (`node:sqlite`) |
| Validation harness | Six tiers (integrity, format, PACE processing, device totals, expectations, archive) plus the opt-in export round trip; manifest; JSON/Markdown reports; privacy guard | 72 harness tests, mutation-checked |

## 3. Security findings

These come from the import-validation infrastructure and the archive reader. Severity is for a
developer tool that reads the athlete's own files locally.

| ID | Finding | Severity | Status |
|---|---|---|---|
| S1 | The repository check compared paths as text, so a link or junction into the repository passed and a report could have been written into the checkout | Low | Fixed (65d22fb, D1), mutation-checked |
| S2 | The exports scan followed linked folders: possible loops, or reading the repository as "exports" | Low | Fixed (65d22fb, D2) |
| S3 | One unreadable file aborted the whole run (its message was already scrubbed) | Low | Fixed (65d22fb, D3) |
| S4 | A file the reader stopped early on could stay open until garbage collection | Info | Fixed (65d22fb, D4) |
| S5 | The archive reader streams local file headers and ignores the ZIP central directory. A ZIP whose central directory disagrees with its local headers is read as the local headers say. Nothing is extracted to disk and every limit still applies. | Low | App behaviour, documented, characterised by a test. No change proposed. |
| S6 | Developer field names from the file appear in warnings: control characters removed, at most 40 characters, scrubbed | Info | Documented |
| S7 | Files named with ordinary words have those words redacted from messages (over-redaction) | Info | Documented, deliberately on the safe side |

**Privacy verification:**
- Output never contains file or folder names, archive entry names, emails, coordinates, absolute
  times, serial numbers or titles. This is checked on the CLI output, the JSON report, the
  Markdown report and the error paths.
- A seeded property test generates 400 messages mixing emails, Windows and POSIX paths,
  coordinates, 10-digit serials, ISO times and quoted titles. After scrubbing, every one passes the
  guard and none of the values remains. The guard refuses each value unscrubbed.
- The harness creates no temporary files: databases are in memory. Real file names never reach
  the importer (files are passed as `picked.<ext>`).

**Limits verified, unchanged, never raised for tests:**
- archive entry count, per-file and total decompressed size, archive size;
- FIT size, message count and chained-file count, and the 200,000-point budget;
- truncated, damaged or bomb-like inputs are refused.

## 4. Test coverage

Local results on `feature/fit-validation` are in section 11.

**Harness (`packages/import-validation`, 72 tests):**
- the original suite (35), the first audit (15), and hardening (21) plus the scenario-test
  addition;
- seeded property tests: privacy (seed 20261113) and FIT-vs-TCX agreement on random activities
  (seeds 1–8).

**Formats:** a new sport-mapping characterisation (24 cases). Decoder boundaries were already
covered: truncation at every byte, every single corrupted byte, structural errors, limits, fuzz.

**Mutation check:** each of these bugs was re-introduced, and its test failed (8 of 8 caught):
A1, C1, C2, C4, D1, the archive name deduplication, scrubbing without the coordinate rule, and a
dropped sensor sample. The script is described in the overnight report; it is not committed
because it rewrites source files.

## 5. Device compatibility matrix

Evidence levels:
- **A:** behaviour follows from the published FIT/GPX/TCX specification.
- **B:** shown by PACE's synthetic tests.
- **C:** observed in a real device recording (**none yet**).
- **D:** unverified hypothesis, to check with real files.

| Source | A (spec) | B (synthetic) | C (real) | D (to verify) |
|---|---|---|---|---|
| Garmin watch run (Forerunner/Fenix) | FIT activity structure, timer events, laps, records | Run with laps, pauses, heart rate and cadence; FIT = TCX = GPX | — | Auto-pause written as timer stop/start; auto-lap lap messages; run cadence as one-foot strides |
| Garmin Edge ride | Power (record 7) and cadence (4) fields | Power with dropouts, zero cadence | — | Speed-sensor distance vs GPS distance (device tier); records repeating a second |
| Garmin multisport | Sessions per leg; sport 18 multisport | Swim–T1–bike–T2–run, 5 legs | — | Open-water swim GPS sparseness; HRM-Swim/Tri stored heart rate (reported, not imported) |
| COROS | Same FIT container | Generic only | — | Timer event types, lap and session messages; exported GPX without `<type>` |
| Wahoo ELEMNT | Same FIT container | Generic only | — | Timer events; developer fields; sub-sport values |
| Strava export | FIT "original", GPX with numeric types (9 = run, 1 = ride), bulk ZIP with `.fit.gz` | Numeric types mapped; bulk-style ZIP with `.gz` entries | — | Real bulk export layout and size; GPX power extension name |
| Zwift / virtual | Sub-sport 58 = virtual | Virtual warning | — | That Zwift sets sub-sport 58; GPX type `virtual_ride` maps to no sport |
| Indoor (treadmill, trainer, pool) | — | Refused with the reason | — | — |

PACE must not be described as supporting any of these manufacturers until column C has entries.

**Recordings to collect first** (see [REAL_DEVICE_VALIDATION_GUIDE.md](REAL_DEVICE_VALIDATION_GUIDE.md)):
1. Garmin run with auto-lap.
2. Garmin run with manual pauses and laps.
3. Garmin ride.
4. Ride with power and cadence.
5. Garmin multisport.

After those: a COROS or Wahoo ride and a Strava bulk export.

## 6. Known limitations

**Import:**
- Indoor activities without GPS are refused.
- Pool-swim triathlons, and any multisport other than swim–bike–run, are refused.
- Developer fields, HRV, HRM-Swim/Tri stored heart rate and device distance or speed are not
  imported. Each is reported.
- The timezone of an imported activity is the phone's at import time, not the activity's
  location.

**Export round trip** (checked with `--export-roundtrip`), via the GPX export:
- **R1:** power is not exported to GPX.
- **R2:** laps are not exported, because GPX has none.
- **R3:** a triathlon cannot be re-imported from GPX.

`data.json` in the portable export keeps all three. Distance, moving and elapsed time, points,
pauses, heart rate, cadence and zero values survive exactly.

**Harness:**
- Device-total field numbers (session and lap 2, 7, 8, 9; session 26) follow the published
  profile but are unconfirmed on real files.
- `sensorGaps` ignores late-starting or early-ending sensors.

## 7. Outstanding risks and app findings

**Owner decisions (2026-11-13):**
- **R1:** approved and implemented on `fix/gpx-power-export`. Power is written as Garmin
  PowerExtension v1, exactly on matching track points.
- **R2:** no change; documented.
- **R3:** documented. The GPX import now warns about multisport files; there is no custom
  extension.

Details are in docs/EXPORT_FORMATS.md on that branch. A new finding, **R6** (heart rate and
cadence attached to points up to 5 s after a sample, and rounded), is reported there and not
changed.


| ID | Affected code | Reproduction | Expected | Actual | Proposed fix | Risk |
|---|---|---|---|---|---|---|
| R1 | `ActivityService.exportGpx` (core) and `toGpx` (formats/gpx.ts) | `hardening.test.ts`, "reports the known gaps" (ride with 561 power samples) | Power survives export and re-import (the GPX importer reads `<power>`) | 0 power samples | Export the power series as the `<power>` point extension the importer already reads | Low: adds data to exported GPX; changes app export, so it needs your approval |
| R2 | GPX format | Same test (run with 2 laps) | — | Laps 2 → 1 | None: GPX has no laps. State it in the export README. | — |
| R3 | `parseGpxTrack` type map, `importTrack` | Same file, triathlon | — | GPX `<type>triathlon</type>` maps to no sport, and a triathlon needs legs | Leave as is and document; or exclude triathlons from the "re-importable GPX" claim | Behaviour change if mapped: a triathlon from GPX would still be refused |
| R4 | `fit.ts` (record handling) | Hypothesis | — | Records repeating the previous second are skipped together with their sensor values | Check with real files (the "repeating time" warning shows the count) | Decoder change only with real-file evidence and approval |
| R5 | `fit.ts` | Hypothesis | — | Sensor values recorded while the timer was stopped are kept | Check with real files | Same |

**Other risks:**
- No physical iPhone recording, no background GPS, no file picker on a device.
- Legal review of the independent FIT decoder (D22).

## 8. Physical iPhone testing requirements

Install a development build (`npx expo run:ios --device`), then on the device:
- **Imports:** pick a `.fit` and a `.fit.gz` in the Files app; import a Garmin export ZIP and a
  Strava bulk export (time, memory); cancel and retry an import.
- **Migration 3** on an existing install that already has activities.
- **Export:** export, then re-import the portable export.
- **Recording:** the full physical-device recording plan in TESTING.md (tests 1–15), including
  background recording, screen lock and app termination.

## 9. Real FIT recording requirements

- **Provenance:** your own recordings, or volunteers with written consent.
- **What to export:** the FIT original plus a TCX (and, if possible, a GPX) of each activity.
- **Where they live:** a folder outside the repository. Nothing is uploaded.
- **Never use** Garmin SDK samples, third-party recordings, or online converters.
- **How:** [REAL_DEVICE_VALIDATION_GUIDE.md](REAL_DEVICE_VALIDATION_GUIDE.md).

## 10. Recommended next milestone

**M4.8 — Real-device validation sprint.** In order:
1. Run the five-scenario guide on your own Garmin recordings, with `--export-roundtrip`.
2. Triage every FAIL and WARNING into decoder, import or harness findings, without changing
   behaviour until you approve.
3. Merge `fix/gpx-power-export` (R1 and R3) after review.
4. First physical-iPhone session: install, import from Files, migration 3, and a short outdoor
   recording.

**Why this before new features:**
- Every capability since M4.5 is proven only synthetically.
- The harness, CI (simulator launch) and the guide now exist, so this is the cheapest point to
  find device-specific problems, and the most valuable.
- A new feature on unvalidated import would multiply the risk.

## 11. Local validation results

See the overnight report for the exact counts and commands. CI status for PR #2 is in section 12.

## 12. CI

PR #2 (`ci/simulator-launch`) runs:
- Linux checks on every push and pull request;
- the full iOS verification (Swift tests, Release and Debug simulator builds, simulator launch
  check, Maestro first-screen flow) on every pull request and every push to `main`.

**First passing full run:** [43238428111](https://github.com/AMOS-GUY/Pace/actions/runs/43238428111)
on `0d06e46`. Results for `8132b38` are in the overnight report. This branch,
`feature/fit-validation`, gets CI only through a pull request: its workflow file predates PR #2.
