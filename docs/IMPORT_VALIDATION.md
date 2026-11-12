# Import validation with real device files (M4.7)

`pnpm validate:fit` checks PACE's FIT, GPX/TCX and archive import against **your own exports**,
kept **outside the repository**. It runs the real import pipeline against a temporary in-memory
database, compares the results three ways and writes anonymised JSON and Markdown reports.

It is validation infrastructure only. It does not change the FIT decoder, the parsers or how
PACE imports. Discrepancies are recorded, never corrected.

> **Quick start:** [REAL_DEVICE_VALIDATION_GUIDE.md](REAL_DEVICE_VALIDATION_GUIDE.md) walks through five
> Garmin scenarios step by step.

> **Status:** the harness is tested with synthetic files only. **No real device files have been
> validated yet.** Reports say so (`realDeviceFiles: false`).

## What is compared

| Tier | Compares | Result on a difference |
|---|---|---|
| **Integrity** | The FIT as parsed → what PACE stored. GPS points (same count and times), sensor samples (identical, none interpolated or dropped), pauses at the timer stops, lap and leg starts, start and end. | FAIL |
| **Format** | The FIT versus a GPX/TCX export of the same activity, both read by PACE's parsers. Start and end time, point count, positions at matching times, segment (pause) structure, lap count and starts, and heart rate, cadence and power at matching times. | FAIL for times, positions, laps and sensor values. WARNING where exports are known to differ (point thinning, missing channels, no pause marks). |
| **PACE processing** | PACE's final activity from the FIT versus from the companion: distance, moving and elapsed time, stored laps, pause durations, stored sensor counts. Also checks that importing both keeps one activity (duplicate detection). | FAIL. Time and distance become WARNING when the companion has no matching pause information. |
| **Device totals** | PACE's final activity versus the totals the device wrote in the FIT session and lap messages: distance, timer time, elapsed time, start, laps and lap starts. | Always WARNING. Device totals are **not** ground truth. |
| **Expectations** | Expected properties from your scenario manifest. | FAIL. Unknown expectations are NOT TESTED. |
| **Archive** | PACE's own ZIP/GZIP reader and bulk import, with the app's limits. Every entry is accounted for, the database stays consistent, a second import adds nothing, and a cancelled import resumes. | FAIL; an archive that stops early is a WARNING. |

Each result is **PASS**, **FAIL**, **WARNING** or **NOT TESTED**:
- A scenario's result is its worst check.
- A scenario is NOT TESTED only if nothing in it could be tested.
- An unknown or missing expectation is never counted as a pass.

### Tolerances

| Comparison | Tolerance |
|---|---|
| Start and end times (format) | ±2 s |
| Positions at the same timestamp | ≤ 5 m |
| Lap and pause boundaries | ±2 s |
| Sensor values at the same timestamp | heart rate ±0.5 bpm, cadence ±1 rpm (TCX/GPX store integers, FIT stores e.g. 85.5), power ±0.5 W |
| Distance, PACE (FIT) vs PACE (companion) | ±1 % or ±5 m |
| Moving time, PACE (FIT) vs PACE (companion) | ±1 % or ±5 s |
| Elapsed time, PACE (FIT) vs PACE (companion) | ±2 s |
| Device distance | ±2 % |
| Device timer time | ±2 % or ±10 s |
| Device elapsed time and start | ±5 s |
| Device lap starts | ±2 s |
| Sensor dropout (expectation `sensorGaps`) | a gap of ≥ 10 s (configurable) that no pause explains |

The values are in `packages/import-validation/src/checks.ts` (`TOLERANCES`) and are repeated in
every report.

### Known representation differences (not discrepancies)

- **Laps:** PACE stores no lap rows for an activity without lap changes. The harness counts that
  as one lap and says so in the explanation.
- **Distance:** PACE calculates distance from GPS points. FIT and TCX device distances
  (wheel sensor, foot pod, smoothing) are compared only in the device tier.
- **Cadence:** cadence is one foot's strides or crank revolutions per minute, as FIT, TCX and GPX
  define it.
- **Companion without a sport:** a GPX or TCX that names no sport (no `<type>`, TCX
  `Sport="Other"`) is imported with the FIT's sport. That is what the app does after the athlete
  chooses one. The report says so in a `… sport` check. A file that names its own sport is never
  overridden, and a triathlon is never used as the override, because GPX/TCX carry no legs.
- **Multisport elapsed time:** the device total is the span from the first session's start to the
  last session's end, so the gaps between legs are included, as in PACE.

### Not covered

- Sensors that start late or stop early (a strap connected after the start) are not reported as
  dropouts. `sensorGaps` looks only at gaps between two samples. The integrity tier still proves
  nothing was filled in.
- Developer field names (Connect IQ, Stryd) appear in warnings as the device wrote them, after
  scrubbing. They are app-defined labels, not personal data, but read the report before sharing
  it.

## Privacy

- **Nothing personal in output.** No original file or folder names, account emails, coordinates,
  absolute dates or times, serial numbers or device identifiers, activity titles or notes, and
  no raw sensor series. Output has only anonymous scenario IDs (V1, F2, A1, …), counts,
  durations, distances, differences and plain-language explanations.
- **Free text is scrubbed:** warnings, refusal reasons and error messages. Known secrets, emails,
  paths, coordinate-like numbers, numbers with 8 or more digits, date-times and quoted titles are
  replaced with placeholders.
- **Final check:** before anything is printed or written, the complete output is checked against
  every secret collected during the run, and against email, path, coordinate and long-number
  patterns. The secrets are paths, file names, archive entry names, FIT serial numbers, titles and
  the home folder. On any hit the run stops with "Output withheld: it would contain …". The
  message names the kind of data, never the value, and nothing is written.
- **Ordinary-word names get over-redacted.** A file or folder named with an ordinary word
  (`treadmill.fit`, `exports/`) has that word redacted from messages too, e.g. "indoor,
  [redacted] or pool". This errs on the side of privacy.
- **Real names never enter the importer:** files are passed to it as `picked.fit`,
  `picked.zip`, …, so no outcome or message can carry them.
- **Everything stays outside the repository:** recordings, the manifest and the report folder.
  The harness refuses a folder, manifest or report location inside it. `*.fit`, `*.fit.gz` and
  `*.FIT` are git-ignored as a second guard.
- **Nothing is uploaded or sent anywhere.** The harness reads local files and writes two report
  files.
- **`--write-key`** writes `PRIVATE-file-key.json`, a map from F/A IDs to your file names. Only
  you need it. Do not share or commit it; with a manifest you don't need it.

## Placing your exports

1. **Make a folder outside the repository.** For example `C:\Users\<you>\PaceValidation\` on
   Windows or `~/PaceValidation/` on macOS. Never use a folder under the PACE checkout.
2. **Export each activity in its original format, plus a companion where possible:**
   - **Garmin Connect** (web): open the activity, ⚙ menu.
     - **Export Original** gives a ZIP containing the `.fit`. Unzip it.
     - **Export to TCX** and **Export to GPX** give the companions.
   - **Strava** (web): activity, ⋯ menu.
     - **Export Original** gives the device's FIT.
     - **Export GPX** gives the companion.
   - **COROS app or Wahoo app:** share or export the activity as FIT, plus GPX or TCX if the app
     offers it.
   - **Bulk exports:** Garmin "Export Your Data" (account data management) and Strava "Download
     your account". Keep the ZIP as it is.
3. **Lay the folder out** however you like, for example:
   ```
   PaceValidation/
     manifest.json
     garmin-run/      run.fit  run.tcx  run.gpx
     edge-ride/       ride.fit ride.tcx
     triathlon/       race.fit
     bulk/            garmin-export.zip  strava-export.zip
   ```
   - Without a manifest, a companion is found by having the same base name as its FIT
     (`run.fit` → `run.tcx` / `run.gpx` / `run.tcx.gz` / `run.gpx.gz`).
   - With a manifest, names do not matter.
4. **Optionally write `manifest.json`** (see below) with the scenario ID and what you know about
   each activity.
5. **Run it from the repository:**
   ```bash
   pnpm validate:fit "C:/Users/<you>/PaceValidation" --manifest "C:/Users/<you>/PaceValidation/manifest.json"
   ```
   **Options:**
   - `--out <folder>`: the report folder. Default: `PaceValidation/pace-validation-report/`.
   - `--expect-valid`: every file must import.
   - `--write-key`: write the private ID → name map (folder mode only).
6. **Read the reports:** `report.md` and `report.json` in the report folder.
   - The console prints one line per scenario (ID, result, outcome) and a summary.
   - The exit code is 1 if any check failed, 2 for a usage or privacy stop.
7. **Before sharing a report, read it.** It is built to be shareable, but you decide.

## Scenario manifest

**Format:** JSON, `version: 1`. Paths are relative to the manifest and may not leave its folder.

**Scenario IDs:** anonymous labels matching `^[A-Z]{1,3}\d{1,3}[a-z]?$` (V1, V4b, A2). They
cannot hold names or dates.

**Unknown values:** every expectation is optional. Use `"unknown"` or `null`, or leave the key
out.

```json
{
  "version": 1,
  "scenarios": [
    {
      "id": "V1",
      "file": "garmin-run/run.fit",
      "companion": ["garmin-run/run.tcx", "garmin-run/run.gpx"],
      "expect": {
        "outcome": "imported",
        "sport": "running",
        "lapDistanceMeters": { "approx": 1000, "tolerance": 30 },
        "sensors": { "heart_rate": "present", "cadence": "present", "power": "absent" },
        "pauses": 0
      }
    },
    {
      "id": "V2",
      "file": "run-pauses/run.fit",
      "companion": "run-pauses/run.tcx",
      "expect": { "pauses": 3, "laps": 5, "pauseSeconds": "unknown" }
    },
    {
      "id": "V4",
      "file": "edge-ride/ride.fit",
      "companion": "edge-ride/ride.tcx",
      "expect": {
        "sport": "cycling",
        "sensors": { "power": "present", "cadence": "present", "heart_rate": "unknown" }
      }
    },
    {
      "id": "V5",
      "file": "dropouts/ride.fit",
      "expect": {
        "zeroValues": { "cadence": "present" },
        "sensorGaps": { "power": "present" },
        "gapSeconds": 10
      }
    },
    { "id": "V8", "file": "triathlon/race.fit", "expect": { "sport": "triathlon", "legs": 5 } },
    { "id": "V11", "file": "treadmill/run.fit", "expect": { "outcome": "refused" } },
    { "id": "V12", "file": "zwift/ride.fit", "expect": { "warningsInclude": ["virtual"] } },
    {
      "id": "V16",
      "archive": "bulk/garmin-export.zip",
      "expect": { "imported": { "min": 1 }, "sourceErrors": 0 }
    }
  ]
}
```

**Activity expectations:**
- `outcome`: `imported`, `refused`, `needs_sport` or `unknown`.
- `sport`.
- Numbers: `points`, `pauses`, `pauseSeconds`, `laps`, `lapDistanceMeters` (every lap but the
  last), `legs`, `distanceMeters`, `movingTimeSeconds`, `elapsedTimeSeconds`.
- `sensors.{heart_rate,cadence,power}`: `present`, `absent`, or a count.
- `zeroValues.{…}`: `present` or `absent`.
- `sensorGaps.{…}`: `present` or `absent`, with `gapSeconds` (default 10).
- `warningsInclude`: substrings expected in PACE's warnings.

**Archive expectations:** `imported`, `duplicates`, `needsSport`, `failed`, `skipped`,
`sourceErrors`.

**A number can be:**
- `3`, or `{"equals": 3}`
- `{"approx": 1000, "tolerance": 30}`
- `{"min": 1}`, `{"max": 5}`, or `{"min": 1, "max": 5}`
- `"unknown"` or `null`

## Validation matrix

"Harness" is what the harness can now check automatically for a scenario once the files exist.
"Verified" is whether real files have been checked. **No row is verified yet.**

| ID | Scenario | Source | Companion | What the harness checks | Verified |
|---|---|---|---|---|---|
| V1 | Garmin run, 1 km auto-laps, wrist heart rate, run cadence | Forerunner/Fenix | TCX + GPX | All tiers; `lapDistanceMeters`; sensors present | ✗ |
| V2 | Garmin run with manual pauses and laps | same | TCX | Pause count and durations vs TCX and device; lap starts | ✗ |
| V3 | Garmin run with auto-pause | same | TCX | Whether auto-pause appears as timer stops (`pauses`); device timer time | ✗ |
| V4 | Garmin Edge ride with power and cadence | Edge | TCX | Power and cadence values at matching times; GPS vs device (wheel) distance | ✗ |
| V5 | Ride with power dropouts and zero cadence while coasting | Edge | TCX | `zeroValues`, `sensorGaps`; integrity: nothing filled in | ✗ |
| V6 | Wahoo ELEMNT ride with power | Wahoo | GPX/TCX | All tiers; manufacturer differences in timer events, laps, sessions | ✗ |
| V7 | COROS run or ride | COROS | GPX/TCX | Same as V6 | ✗ |
| V8 | Garmin triathlon, open water, transitions | Multisport watch | — | Integrity of the 5 legs; `legs`, `sport`; device totals summed over sessions | ✗ |
| V9 | Duathlon or multisport without transitions | same | — | `outcome: refused` and the reason | ✗ |
| V10 | Missing measurements: strap dropout, GPS loss in a tunnel, sensor added mid-activity | any | TCX | `sensorGaps`; integrity: sensors kept for points without a position | ✗ |
| V11 | Indoor treadmill, trainer or pool | any | — | `outcome: refused` | ✗ |
| V12 | Zwift or other virtual ride | Zwift | GPX | `warningsInclude: ["virtual"]` (confirms sub-sport 58) | ✗ |
| V13 | Stryd or Connect IQ developer fields | Garmin + Stryd | TCX | `warningsInclude` with the field names; power present or absent | ✗ |
| V14 | Long activity (over 6 h, 1 s recording) | any | TCX | All tiers; run time and memory | ✗ |
| V15 | Older device with compressed timestamps | Edge 500 / FR310XT | TCX | All tiers | ✗ |
| V16 | Garmin and Strava bulk export ZIPs | account exports | inside | Archive tier: accounting, consistency, repeat import, cancel and resume, `imported`/`failed` counts | ✗ |
| V17 | The same activity as FIT, TCX and GPX | any | all | Duplicate detection (activity tier), `duplicates` (archive tier) | ✗ |
| V18 | Partially synced or corrupted file | if available | — | `outcome: refused`; nothing stored | ✗ |

**Covered by the harness's synthetic regression tests:**
- V1, V2, V5, V8, V11, V16, V17 and V18.
- Large archives with cancellation.
- Archive limits.
- Truncated archives.
- Unsafe entry paths.
- Nested archives.
- Damaged `.gz` entries.

**Values the device-totals tier reads that real files must confirm:** session and lap fields 2,
7, 8 and 9, and session field 26. They follow the published FIT profile, like the importer's own
mappings.

## Getting usable files

- **Own recordings first.** Garmin, Wahoo, COROS, Strava exports, as above.
- **Volunteers** only with written consent that the files are used locally for testing, never
  committed or uploaded.
- **No public FIT files and no third-party recordings** without explicit approval, file by file.
- **Never** Garmin SDK samples, or test files from other projects whose origin is unclear (D22).

## Audit (2026-11-13)

A review of the harness against these requirements:
- independent imports;
- database parity;
- comparison correctness;
- privacy;
- archives.

Fixed, each with a regression test in `packages/import-validation/src/audit.test.ts`:

| ID | Finding | Fix |
|---|---|---|
| A1 | A companion naming no sport was refused with "choose a sport". Its PACE-processing comparison was then skipped, and the duplicate check failed for the wrong reason. | Imported with the FIT's sport through the same `importTrack` option the app uses after the athlete chooses one. |
| C1 | Pause boundaries were only counted between formats, never compared in time. | New format check, segment boundaries: every pause start and end ±2 s. |
| C2 | When lap counts differed, lap starts were paired by index and reported misleading differences. | Not tested when counts differ; the lap count check already fails. |
| C3 | Equal segments but a different number of stored pauses would have crashed the run. | Reported as a FAIL. |
| C4 | A multisport file's device elapsed time summed its sessions and left out the gaps between legs: a false WARNING. | Uses the span from first start to last end. |
| D1 | The repository check compared paths as text, so a link or junction into the repository passed. | Real locations are compared, with links followed. |
| D2 | The folder scan followed linked folders, which could loop or reach into the repository. | Linked folders are skipped. |
| D3 | One unreadable file stopped the whole run. | That scenario fails with a scrubbed message, and the others continue. |
| D4 | A file the reader stopped early on (an oversized file) could stay open until garbage collection. Found by reading the code; no test. | The file is closed after reading. |

Checked and found correct, with new tests where coverage was missing:
- **Import isolation:** each FIT, companion and duplicate import uses its own in-memory database
  and the app's `importTrack` (A2).
- **Database parity:** the harness driver runs the app's `configureConnection` and migrations;
  foreign keys and cascades, CHECK constraints, rollback and nested-transaction refusal behave as
  on the device (B1–B4).
- **Archive limits:** the entry-count limit and the per-file limit are enforced through the app's
  own reader (E1, E2), alongside the existing total-size, truncation, unsafe-path, nested-archive,
  damaged-entry, duplicate and cancel/resume tests.
- **Timestamps:** reports carry only differences, never absolute times.

Differences from the app database that do not affect results:
- **Statement locking:** the app driver serialises every statement on one connection; the harness
  driver locks only transactions. The harness runs strictly sequentially.
- **WAL mode:** it does not apply to an in-memory database.
