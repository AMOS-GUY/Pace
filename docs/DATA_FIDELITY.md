# Data fidelity: what each format keeps

What PACE can read and write, and what is lost on the way. Checked against the code and tests on
2026-11-13. "Tested" means automated tests with synthetic files. **No real device file and no
physical iPhone has been used yet.**

Legend: ✅ kept · 🟡 partly (see notes) · ❌ not kept · — not applicable

## Imports

| Information | GPX | TCX | FIT |
|---|---|---|---|
| Route points (position, time, elevation) | ✅ | ✅ | ✅ (semicircles → degrees; enhanced altitude preferred) |
| Pauses | 🟡 Only as separate `<trkseg>` (most exports use one segment) | 🟡 Only as an extra `<Track>` inside a lap | ✅ Timer stop/start events |
| Laps | ❌ GPX has none (R2) | ✅ | ✅ |
| Heart rate | ✅ TrackPointExtension `hr` | ✅ | ✅ |
| Cadence | ✅ `cad` (whole numbers) | ✅ bike `Cadence`, run `RunCadence` | ✅ including fractional cadence |
| Power | ✅ `<power>` or `PowerInWatts` | ✅ `Watts` | ✅ |
| Sensor values without a GPS position | ❌ GPX values sit on points | ✅ | ✅ Kept, reported |
| Same-second records | — | — | 🟡 Until R4 is merged, a second record in the same second is skipped. The fix is on `fix/fit-same-second-records`. |
| Sport | 🟡 Mapped `<type>` names and Strava numbers; others → you choose | 🟡 Running and Biking; `Other` → you choose | ✅ Run, ride, walk, hike, swim, triathlon |
| Triathlon legs | ❌ Warned (R3) | ❌ (multisport sessions not read) | ✅ Swim–T1–bike–T2–run only |
| Indoor activities without GPS | Refused | Refused | Refused, with the reason |
| Developer fields, HRV, device distance or speed, calories, temperature | ❌ Reported as not imported | ❌ Reported | ❌ Reported |
| Archives | ZIP and `.gz`: streamed, size and entry limits, unsafe paths refused, nested archives refused, damaged entries reported | same | same |
| Duplicates | Refused, by fingerprint or ≥ 50 % time overlap across all formats | same | same |

## Exports and backups

| Information | GPX (per activity or in the ZIP) | Portable export (`data.json` + CSV + GPX) | Encrypted backup |
|---|---|---|---|
| Route points and pauses | ✅ (privacy zone applied) | ✅ in the GPX files | ✅ raw samples and events |
| Distance, moving and elapsed time | ✅ recomputed identically on re-import | ✅ | ✅ recomputed by replay |
| Laps | ❌ (R2) | ✅ `data.json`, `laps.csv` | ✅ |
| Triathlon legs | ❌ (R3; re-import warns) | ✅ `data.json` | ✅ replayed from leg events |
| Heart rate and cadence | 🟡 One value per sample on its nearest point ≤ 2 s; whole numbers (R6, fixed on `fix/gpx-sensor-timestamps`) | ✅ `data.json` | ❌ **Not in backups (R7)** |
| Power | ✅ at exact point times (R1) | ✅ `data.json` | ❌ **Not in backups (R7)** |
| Splits, records | ❌ | ✅ | ✅ recomputed |
| Goals, settings, profile | ❌ | ✅ | 🟡 Goals restored; settings are saved in the backup but not applied on restore |
| Re-importable into PACE | ✅ | 🟡 Only its GPX files; PACE does not read `data.json` | ✅ restore |
| Other apps | ✅ GPX is widely read (power support varies; untested) | Readable JSON and CSV | ❌ PACE only |

**No TCX or FIT export exists.**

## Which one to use

- **Share a route with another app:** GPX.
- **Keep a complete, readable copy of everything:** the portable export.
- **Move PACE to a new iPhone:** the encrypted backup. Until R7 is fixed, keep a portable export
  too, because backups do not contain heart rate, cadence or power.

## Open findings

| ID | Finding | Status |
|---|---|---|
| R6 | GPX export copied heart rate and cadence onto the following 5 s of points; re-import duplicated them (24 → 120 samples) | Fixed on `fix/gpx-sensor-timestamps`, awaiting review |
| R4 | FIT records sharing a second were dropped entirely (cadence, power, even a GPS point) | Fixed on `fix/fit-same-second-records`, awaiting review |
| **R7** | **Encrypted backups contain no sensor samples.** A backup → restore round trip kept the activity, 300 GPS points, 2 laps and the distance exactly, but heart rate, cadence and power went from 600 samples to 0. | **Needs a decision** (see below) |

**R7, proposed fix (not implemented):**
- Add the sensor samples to the backup payload as backup format **version 2** (activity,
  sensor type, value, unit, time).
- Restore inserts them with the activity, after replay.
- Version 1 backups keep restoring as now.

Nothing in the database schema changes. This needs your approval because it changes a
persisted file format, and backups made with the new version cannot be restored by older app
versions.
