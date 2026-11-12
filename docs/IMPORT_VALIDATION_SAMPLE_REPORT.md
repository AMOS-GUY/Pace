<!-- Sample output of `pnpm validate:fit` on SYNTHETIC test fixtures (no real recordings). V1's lap-distance FAIL is deliberate: the sample manifest expects 1 km laps, the synthetic laps are 0.96 km. Regenerate rather than edit. -->

# PACE import validation report

Generated 2026-11-12 · mode: manifest · real device files: no

> Contains no file or folder names, emails, coordinates, absolute times, device identifiers, activity titles or raw sensor series. Scenario IDs are anonymous.

## Summary

| | PASS | FAIL | WARNING | NOT TESTED |
|---|---|---|---|---|
| Scenarios | 4 | 1 | 1 | 0 |
| Checks | 109 | 1 | 1 | 19 |

| Scenario | Result | Outcome | Companions |
|---|---|---|---|
| V1 | FAIL | imported | TCX, GPX |
| V2 | PASS | imported | TCX |
| V5 | PASS | imported | — |
| V8 | WARNING | imported | — |
| V11 | PASS | refused | — |
| V16 | PASS | archive | — |

## V1 — FAIL

**sport**: running · **points**: 602 · **segments**: 1 · **pauses**: 0 · **laps**: 2 · **legs**: — · **durationMinutes**: 10 · **distanceKm**: 1.95 · **movingMinutes**: 10 · **sensors**: {"heart_rate":602,"cadence":602,"power":0}

### Integrity (FIT parsed → PACE stored)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| parsed track invariants | PASS | — | — | — | — | Point times strictly increase, coordinates and sensor values are valid, laps and legs are ordered |
| GPS points stored as parsed | PASS | 602 | 602 | — | exact | Every parsed point was stored once at its own time; none were added or lost |
| sensor samples stored as recorded | PASS | 1204 | 1204 | — | exact | Heart rate, cadence and power were stored exactly as recorded: none interpolated, filled in, changed or dropped |
| pauses at segment boundaries | PASS | 0 | 0 | — | exact | Each timer stop in the file became exactly one pause between the same two points |
| lap starts stored | PASS | 1 | 1 | — | ±1 s | Every lap start in the file has a stored lap starting at the same time |
| stored start and end | PASS | — | — | 0 | ±0 s | The activity starts at the first point and ends at the last point |

### Format comparison (FIT vs companion, both as parsed)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| start time (TCX) | PASS | — | — | 0 | ±2 s | The FIT and TCX start at the same time |
| end time (TCX) | PASS | — | — | 0 | ±2 s | The FIT and TCX end at the same time |
| GPS point count (TCX) | PASS | 602 | 602 | 0 | exact | Same number of positioned points |
| positions at matching times (TCX) | PASS | 602 | — | 0.01 | ≤ 5 m | 602 shared timestamps; positions agree (largest difference in metres shown) |
| segments (pause structure) (TCX) | PASS | 1 | 1 | — | exact | Same number of timer-running segments |
| lap count (TCX) | PASS | 2 | 2 | — | exact | Same number of laps |
| lap start times (TCX) | PASS | — | — | 0 | ±2 s | Lap starts agree (largest difference shown) |
| heart rate samples (TCX) | PASS | 602 | 602 | 0 | ±0.5 bpm per sample | All 602 samples match |
| cadence samples (TCX) | PASS | 602 | 602 | 0 | ±1 rpm per sample | All 602 samples match |
| power samples (TCX) | NOT TESTED | — | — | — | — | Neither file has samples |
| start time (GPX) | PASS | — | — | 0 | ±2 s | The FIT and GPX start at the same time |
| end time (GPX) | PASS | — | — | 0 | ±2 s | The FIT and GPX end at the same time |
| GPS point count (GPX) | PASS | 602 | 602 | 0 | exact | Same number of positioned points |
| positions at matching times (GPX) | PASS | 602 | — | 0.01 | ≤ 5 m | 602 shared timestamps; positions agree (largest difference in metres shown) |
| segments (pause structure) (GPX) | PASS | 1 | 1 | — | exact | Same number of timer-running segments |
| laps (GPX) | NOT TESTED | — | — | — | — | GPX files carry no laps |
| heart rate samples (GPX) | PASS | 602 | 602 | 0 | ±0.5 bpm per sample | All 602 samples match |
| cadence samples (GPX) | PASS | 602 | 602 | 0 | ±1 rpm per sample | All 602 samples match |
| power samples (GPX) | NOT TESTED | — | — | — | — | Neither file has samples |

### PACE processing (final activity from FIT vs from companion)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| distance (TCX) | PASS | 1950 | 1950 | 0 | ±5 m or ±1% | PACE calculates the same distance from both files |
| moving time (TCX) | PASS | 601 | 601 | 0 | ±5 s or ±1% | Same moving time from both files |
| elapsed time (TCX) | PASS | 601 | 601 | 0 | ±2 s | Same elapsed time from both files |
| stored laps (TCX) | PASS | 2 | 2 | — | exact | Same number of stored laps |
| pause durations (TCX) | PASS | 0 | 0 | 0 | ±2 s per pause | Same pauses with the same durations (largest difference shown, seconds) |
| stored heart rate samples (TCX) | PASS | 602 | 602 | — | exact | Same number of stored samples |
| stored cadence samples (TCX) | PASS | 602 | 602 | — | exact | Same number of stored samples |
| stored power samples (TCX) | NOT TESTED | — | — | — | — | Neither activity has samples |
| duplicate detection (FIT then TCX) | PASS | 1 | 1 | — | exact | The TCX export of the same activity is recognised as a duplicate; one activity is kept |
| distance (GPX) | PASS | 1950 | 1950 | 0 | ±5 m or ±1% | PACE calculates the same distance from both files |
| moving time (GPX) | PASS | 601 | 601 | 0 | ±5 s or ±1% | Same moving time from both files |
| elapsed time (GPX) | PASS | 601 | 601 | 0 | ±2 s | Same elapsed time from both files |
| laps (GPX) | NOT TESTED | — | — | — | — | GPX files carry no laps |
| pause durations (GPX) | PASS | 0 | 0 | 0 | ±2 s per pause | Same pauses with the same durations (largest difference shown, seconds) |
| stored heart rate samples (GPX) | PASS | 602 | 602 | — | exact | Same number of stored samples |
| stored cadence samples (GPX) | PASS | 602 | 602 | — | exact | Same number of stored samples |
| stored power samples (GPX) | NOT TESTED | — | — | — | — | Neither activity has samples |
| duplicate detection (FIT then GPX) | PASS | 1 | 1 | — | exact | The GPX export of the same activity is recognised as a duplicate; one activity is kept |

### Device-reported totals (informational, not ground truth)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| distance vs device total | PASS | 1950 | 1962 | -12 | ±2% | PACE GPS distance agrees with the device total |
| moving time vs device timer time | PASS | 601 | 600 | 1 | ±10 s or ±2% | PACE moving time agrees with the device timer time |
| elapsed time vs device total | PASS | 601 | 601 | 0 | ±5 s | PACE elapsed time agrees with the device |
| start vs device start | PASS | — | — | 0 | ±5 s | PACE starts at the device start time |
| laps vs device | PASS | 2 | 2 | — | exact | Same number of laps as the device |
| lap starts vs device | PASS | 1 | 1 | — | ±2 s | Every device lap after the first starts at a PACE lap boundary |

### Expected results (scenario manifest)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| sport | PASS | running | running | — | — | Matches the expectation |
| laps | PASS | 2 | 2 | — | — | Matches the expectation |
| lap distances (all but the last lap) | FAIL | 0/1 within | 1000 ± 30 m | — | — | 1 lap(s) outside the expected distance |
| heart rate samples | PASS | present | present | — | — | Matches the expectation |
| cadence samples | PASS | present | present | — | — | Matches the expectation |
| power samples | PASS | absent | absent | — | — | Matches the expectation |

Import warnings:

- Not imported: device lap and session summaries (figures are recalculated from the track) and device name.

## V2 — PASS

**sport**: running · **points**: 603 · **segments**: 2 · **pauses**: 1 · **laps**: 2 · **legs**: — · **durationMinutes**: 11 · **distanceKm**: 1.8 · **movingMinutes**: 10 · **sensors**: {"heart_rate":603,"cadence":0,"power":0}

### Integrity (FIT parsed → PACE stored)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| parsed track invariants | PASS | — | — | — | — | Point times strictly increase, coordinates and sensor values are valid, laps and legs are ordered |
| GPS points stored as parsed | PASS | 603 | 603 | — | exact | Every parsed point was stored once at its own time; none were added or lost |
| sensor samples stored as recorded | PASS | 603 | 603 | — | exact | Heart rate, cadence and power were stored exactly as recorded: none interpolated, filled in, changed or dropped |
| pauses at segment boundaries | PASS | 1 | 1 | — | exact | Each timer stop in the file became exactly one pause between the same two points |
| lap starts stored | PASS | 1 | 1 | — | ±1 s | Every lap start in the file has a stored lap starting at the same time |
| stored start and end | PASS | — | — | 0 | ±0 s | The activity starts at the first point and ends at the last point |

### Format comparison (FIT vs companion, both as parsed)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| start time (TCX) | PASS | — | — | 0 | ±2 s | The FIT and TCX start at the same time |
| end time (TCX) | PASS | — | — | 0 | ±2 s | The FIT and TCX end at the same time |
| GPS point count (TCX) | PASS | 603 | 603 | 0 | exact | Same number of positioned points |
| positions at matching times (TCX) | PASS | 603 | — | 0.01 | ≤ 5 m | 603 shared timestamps; positions agree (largest difference in metres shown) |
| segments (pause structure) (TCX) | PASS | 2 | 2 | — | exact | Same number of timer-running segments |
| lap count (TCX) | PASS | 2 | 2 | — | exact | Same number of laps |
| lap start times (TCX) | PASS | — | — | 0 | ±2 s | Lap starts agree (largest difference shown) |
| heart rate samples (TCX) | PASS | 603 | 603 | 0 | ±0.5 bpm per sample | All 603 samples match |
| cadence samples (TCX) | NOT TESTED | — | — | — | — | Neither file has samples |
| power samples (TCX) | NOT TESTED | — | — | — | — | Neither file has samples |

### PACE processing (final activity from FIT vs from companion)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| distance (TCX) | PASS | 1800 | 1800 | 0 | ±5 m or ±1% | PACE calculates the same distance from both files |
| moving time (TCX) | PASS | 601 | 601 | 0 | ±5 s or ±1% | Same moving time from both files |
| elapsed time (TCX) | PASS | 661 | 661 | 0 | ±2 s | Same elapsed time from both files |
| stored laps (TCX) | PASS | 2 | 2 | — | exact | Same number of stored laps |
| pause durations (TCX) | PASS | 1 | 1 | 0 | ±2 s per pause | Same pauses with the same durations (largest difference shown, seconds) |
| stored heart rate samples (TCX) | PASS | 603 | 603 | — | exact | Same number of stored samples |
| stored cadence samples (TCX) | NOT TESTED | — | — | — | — | Neither activity has samples |
| stored power samples (TCX) | NOT TESTED | — | — | — | — | Neither activity has samples |
| duplicate detection (FIT then TCX) | PASS | 1 | 1 | — | exact | The TCX export of the same activity is recognised as a duplicate; one activity is kept |

### Device-reported totals (informational, not ground truth)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| distance vs device total | NOT TESTED | — | — | — | — | The device wrote no total distance |
| moving time vs device timer time | NOT TESTED | — | — | — | — | The device wrote no timer time |
| elapsed time vs device total | PASS | 661 | 661 | 0 | ±5 s | PACE elapsed time agrees with the device |
| start vs device start | PASS | — | — | 0 | ±5 s | PACE starts at the device start time |
| laps vs device | PASS | 2 | 2 | — | exact | Same number of laps as the device |
| lap starts vs device | PASS | 1 | 1 | — | ±2 s | Every device lap after the first starts at a PACE lap boundary |

### Expected results (scenario manifest)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| pauses | PASS | 1 | 1 | — | — | Matches the expectation |
| total pause time | NOT TESTED | — | — | — | — | Expected value unknown (not given in the manifest) |
| laps | PASS | 2 | 2 | — | — | Matches the expectation |

Import warnings:

- Not imported: device lap and session summaries (figures are recalculated from the track) and device name.

## V5 — PASS

**sport**: cycling · **points**: 601 · **segments**: 1 · **pauses**: 0 · **laps**: 1 · **legs**: — · **durationMinutes**: 10 · **distanceKm**: 4.8 · **movingMinutes**: 10 · **sensors**: {"heart_rate":601,"cadence":601,"power":561}

### Integrity (FIT parsed → PACE stored)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| parsed track invariants | PASS | — | — | — | — | Point times strictly increase, coordinates and sensor values are valid, laps and legs are ordered |
| GPS points stored as parsed | PASS | 601 | 601 | — | exact | Every parsed point was stored once at its own time; none were added or lost |
| sensor samples stored as recorded | PASS | 1763 | 1763 | — | exact | Heart rate, cadence and power were stored exactly as recorded: none interpolated, filled in, changed or dropped |
| pauses at segment boundaries | PASS | 0 | 0 | — | exact | Each timer stop in the file became exactly one pause between the same two points |
| lap starts stored | PASS | 0 | 0 | — | ±1 s | Every lap start in the file has a stored lap starting at the same time |
| stored start and end | PASS | — | — | 0 | ±0 s | The activity starts at the first point and ends at the last point |

### Format comparison (FIT vs companion, both as parsed)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| companion comparison | NOT TESTED | — | — | — | — | No GPX or TCX export of this activity was supplied |

### Device-reported totals (informational, not ground truth)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| distance vs device total | NOT TESTED | — | — | — | — | The device wrote no total distance |
| moving time vs device timer time | NOT TESTED | — | — | — | — | The device wrote no timer time |
| elapsed time vs device total | PASS | 600 | 600 | 0 | ±5 s | PACE elapsed time agrees with the device |
| start vs device start | PASS | — | — | 0 | ±5 s | PACE starts at the device start time |
| laps vs device | PASS | 1 | 1 | — | exact | Same number of laps as the device (PACE stores no lap rows for an activity without lap changes; counted as one lap) |

### Expected results (scenario manifest)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| sport | PASS | cycling | cycling | — | — | Matches the expectation |
| cadence zero values kept | PASS | present | present | — | — | Matches the expectation |
| power dropouts (gaps ≥ 10 s) left as gaps | PASS | present | present | — | — | Matches the expectation |

Import warnings:

- Not imported: device lap and session summaries (figures are recalculated from the track) and device name.

## V8 — WARNING

**sport**: triathlon · **points**: 1725 · **segments**: 1 · **pauses**: 0 · **laps**: 1 · **legs**: 5 · **durationMinutes**: 36.8 · **distanceKm**: 10.8 · **movingMinutes**: 36.8 · **sensors**: {"heart_rate":1543,"cadence":0,"power":0}

### Integrity (FIT parsed → PACE stored)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| parsed track invariants | PASS | — | — | — | — | Point times strictly increase, coordinates and sensor values are valid, laps and legs are ordered |
| GPS points stored as parsed | PASS | 1725 | 1725 | — | exact | Every parsed point was stored once at its own time; none were added or lost |
| sensor samples stored as recorded | PASS | 1543 | 1543 | — | exact | Heart rate, cadence and power were stored exactly as recorded: none interpolated, filled in, changed or dropped |
| pauses at segment boundaries | PASS | 0 | 0 | — | exact | Each timer stop in the file became exactly one pause between the same two points |
| lap starts stored | PASS | 0 | 0 | — | ±1 s | Every lap start in the file has a stored lap starting at the same time |
| triathlon legs stored | PASS | 5 | 5 | — | ±1 s per leg start | Swim, T1, bike, T2 and run were stored at the leg start times in the file |
| stored start and end | PASS | — | — | 0 | ±0 s | The activity starts at the first point and ends at the last point |

### Format comparison (FIT vs companion, both as parsed)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| companion comparison | NOT TESTED | — | — | — | — | No GPX or TCX export of this activity was supplied |

### Device-reported totals (informational, not ground truth)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| distance vs device total | NOT TESTED | — | — | — | — | The device wrote no total distance |
| moving time vs device timer time | NOT TESTED | — | — | — | — | The device wrote no timer time |
| elapsed time vs device total | WARNING | 2208 | 2200 | 8 | ±5 s | PACE elapsed time runs from the first to the last GPS point; the device's may include time before the first fix. Device totals are not ground truth: devices may use wheel or foot-pod sensors, smoothing, or count time differently. |
| start vs device start | PASS | — | — | 0 | ±5 s | PACE starts at the device start time |
| laps vs device | PASS | 5 | 5 | — | exact | Same number of laps as the device (leg changes count as lap boundaries, as on the device) |
| lap starts vs device | PASS | 4 | 4 | — | ±2 s | Every device lap after the first starts at a PACE lap boundary (leg changes count as lap boundaries, as on the device) |

### Expected results (scenario manifest)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| sport | PASS | triathlon | triathlon | — | — | Matches the expectation |
| legs | PASS | 5 | 5 | — | — | Matches the expectation |

Import warnings:

- Not imported: device lap and session summaries (figures are recalculated from the track) and device name.

## V11 — PASS

### Integrity (FIT parsed → PACE stored)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| file accepted | PASS | refused | — | — | — | PACE refused the file: This FIT activity has no GPS positions (for example an indoor, [redacted], trainer or pool session). Activities without a GPS track cannot be imported yet. |

### Expected results (scenario manifest)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| outcome | PASS | refused | refused | — | — | Matches the expectation |

## V16 — PASS

**entries**: 6 · **imported**: 3 · **duplicates**: 1 · **needsSport**: 0 · **failed**: 1 · **skipped**: 1 · **sourceErrors**: 0 · **importedByKind**: {".fit":1,".gpx.gz":2} · **failureReasons**: {"Unsafe file name in archive (path leaves the archive (..))":1} · **skippedByExtension**: {".jpg":1} · **seconds**: 0.4 · **peakMemoryMb**: 203

### Expected results (scenario manifest)

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| imported activities | PASS | 3 | 3 | — | — | Matches the expectation |
| duplicates | PASS | 1 | 1 | — | — | Matches the expectation |
| failed entries | PASS | 1 | 1 | — | — | Matches the expectation |
| skipped entries | PASS | 1 | 1 | — | — | Matches the expectation |

### Archive reading and bulk import

| Check | Result | PACE / FIT | Reference | Difference | Tolerance | Explanation |
|---|---|---|---|---|---|---|
| every entry accounted for | PASS | 6 | 6 | — | exact | Every file in the archive was imported, reported as a duplicate or failure, or skipped as not an activity |
| database consistent | PASS | 3 | 3 | — | — | One complete activity with its points per imported entry; foreign keys and integrity check clean |
| second import adds nothing | PASS | 0 | 0 | — | — | Every activity is recognised as already imported on the second run |
| cancel and resume | PASS | 1 + 2 | 3 | — | — | A cancelled import keeps what it imported, and importing again completes the rest without duplicates |

## Tolerances

```json
{
  "timeMs": 2000,
  "positionMeters": 5,
  "boundaryMs": 2000,
  "sensor": {
    "heart_rate": 0.5,
    "cadence": 1,
    "power": 0.5
  },
  "pipelineDistanceRelative": 0.01,
  "pipelineDistanceMeters": 5,
  "pipelineMovingRelative": 0.01,
  "pipelineMovingSeconds": 5,
  "pipelineElapsedSeconds": 2,
  "deviceDistanceRelative": 0.02,
  "deviceTimerRelative": 0.02,
  "deviceTimerSeconds": 10,
  "deviceElapsedSeconds": 5,
  "deviceLapStartSeconds": 2,
  "sensorGapSeconds": 10
}
```
