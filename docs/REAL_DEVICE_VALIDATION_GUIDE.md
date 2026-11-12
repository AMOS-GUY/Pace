# Real-device validation: a step-by-step guide

You need your own recordings and about an hour. Nothing is uploaded, and nothing goes into the
repository. Details and the full matrix are in [IMPORT_VALIDATION.md](IMPORT_VALIDATION.md).

## 1. Record or pick five activities

| ID | Activity | What it must contain |
|---|---|---|
| V1 | Garmin run | Watch with GPS, wrist or strap heart rate, auto-lap on (1 km) |
| V2 | Garmin run with pauses and laps | Press stop and resume 2–3 times. Press lap 2–3 times. Write down how many of each. |
| V3 | Garmin ride | Edge or watch, outdoors with GPS |
| V4 | Ride with power and cadence | Power meter and cadence sensor paired. Ideally coast a few times and stop pedalling briefly. |
| V5 | Multisport (triathlon) | Garmin multisport profile: swim → T1 → bike → T2 → run (open water or outdoors) |

Existing activities are fine if they match. A short version of each is enough: about 10–20
minutes, except the triathlon.

## 2. Export each activity twice, from Garmin Connect (web)

For each activity, open it in Garmin Connect, then:
1. **⚙ → Export Original** downloads a ZIP. Unzip it and keep the `.fit` file.
2. **⚙ → Export to TCX** downloads the `.tcx` file.

No TCX is needed for V5: a TCX cannot hold the legs.

Menu names can change slightly; the gear menu is at the top right of the activity page. Never
use an online converter. If you don't have one of these activities, leave its rows out of the
manifest.

## 3. Put the files in a folder outside the repository

```
C:\Users\<you>\PaceValidation\
  manifest.json
  v1\run.fit            v1\run.tcx
  v2\run.fit            v2\run.tcx
  v3\ride.fit           v3\ride.tcx
  v4\ride.fit           v4\ride.tcx
  v5\tri.fit
```

The harness refuses to run on a folder, manifest or report location inside the PACE checkout.

## 4. Write `manifest.json`

**How to fill it in:**
- Fill in what you know, and leave the rest as `"unknown"`. An unknown value is reported as
  NOT TESTED, never as a pass.
- **Counts for V2:** replace the `3` and `5` with your own. Pauses is how many times you stopped
  the timer; laps is lap presses + 1.
- **V4 without coasting:** if you never coasted or stopped pedalling, set
  `"zeroValues": "unknown"`.
- **V4 without a power dropout:** keep `"sensorGaps": { "power": "unknown" }`, unless you know
  the power meter dropped out. A dropout must stay a gap.

```json
{
  "version": 1,
  "scenarios": [
    {
      "id": "V1",
      "file": "v1/run.fit",
      "companion": "v1/run.tcx",
      "expect": {
        "outcome": "imported",
        "sport": "running",
        "lapDistanceMeters": { "approx": 1000, "tolerance": 30 },
        "sensors": { "heart_rate": "present", "cadence": "present" }
      }
    },
    {
      "id": "V2",
      "file": "v2/run.fit",
      "companion": "v2/run.tcx",
      "expect": { "sport": "running", "pauses": 3, "laps": 5 }
    },
    {
      "id": "V3",
      "file": "v3/ride.fit",
      "companion": "v3/ride.tcx",
      "expect": { "outcome": "imported", "sport": "cycling" }
    },
    {
      "id": "V4",
      "file": "v4/ride.fit",
      "companion": "v4/ride.tcx",
      "expect": {
        "sport": "cycling",
        "sensors": { "power": "present", "cadence": "present" },
        "zeroValues": { "cadence": "present", "power": "present" },
        "sensorGaps": { "power": "unknown" }
      }
    },
    {
      "id": "V5",
      "file": "v5/tri.fit",
      "expect": { "outcome": "imported", "sport": "triathlon", "legs": 5 }
    }
  ]
}
```

## 5. Run the harness

From the PACE checkout (after `pnpm install`):

```bash
pnpm validate:fit "C:/Users/<you>/PaceValidation" --manifest "C:/Users/<you>/PaceValidation/manifest.json"
```

The console prints one line per scenario, for example `V2  PASS  imported`. The reports are
`report.md` and `report.json` in `PaceValidation/pace-validation-report/`.

**Exit code:**
- `0`: no failures.
- `1`: at least one FAIL.
- `2`: the run stopped (a usage error, a folder inside the repository, or a privacy stop). Nothing
  was written.

## 6. Read the report

Open `report.md`. Each scenario has five sections:

| Section | What it means | A failure here |
|---|---|---|
| Integrity | PACE stored exactly what the FIT contains | Always a real problem: report it |
| Format comparison | FIT vs TCX, as read by PACE | FAIL: times, positions, laps or sensor values disagree. WARNING: a known export difference (explained in the row). |
| PACE processing | PACE's activity from the FIT vs from the TCX | FAIL: same points, different result |
| Device-reported totals | PACE vs the watch's own totals | Always WARNING, because devices measure differently. Write down the size of the difference. |
| Expected results | Your manifest | FAIL: PACE disagrees with what you wrote, so check your counts first |

## 7. What to send back

Send `report.md` after reading it yourself. It is built without file names, coordinates, times or
device IDs, but you decide what to share. Never send the `.fit`, `.tcx` or `PRIVATE-file-key.json`
files.

Any FAIL is a finding. It is investigated first; the FIT decoder or the import changes only after
you approve a fix based on it.
