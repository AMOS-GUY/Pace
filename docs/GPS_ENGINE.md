# GPS engine

Source: `packages/gps-engine`, consumed by `packages/activity-engine`. Native capture:
`apps/mobile/modules/pace-tracking/ios`.

## Raw vs processed data

- **Raw samples** (`route_points`) are stored exactly as delivered by Core Location, including
  rejected ones. They are never modified, filtered out of storage, or deleted to save space
  (only when the user deletes/discards the activity).
- **Processed route** (`processed_routes`) is derived: filtered positions, segment breaks and gap
  metadata, plus a simplified display polyline. It can be rebuilt from raw data at any time
  (`ROUTE_ALGORITHM_VERSION`).

## Pipeline (`RouteProcessor.process`)

| Step | Rule | Outcome |
|---|---|---|
| Structural validation | finite lat/lon in range, not (0,0), timestamp ≥ 2000-01-01, accuracy ≥ 0 | `rejected: invalid_*` |
| Ordering | timestamp must increase | `rejected: out_of_order / duplicate` |
| Accuracy gate | horizontal accuracy ≤ policy max | `rejected: poor_accuracy` |
| Plausibility | `(d − accA − accB) / dt ≤ maxPlausibleSpeed`, with d from the anchor and dt from the **latest plausible fix** (not the anchor, which can be minutes old after standing still) | `rejected: implausible_jump` |
| Re-anchoring | N (3) consecutive mutually-consistent "jump" samples → new segment, no distance across the jump | `accepted` + gap `reanchor` |
| Gap detection | no usable fix for `gapThresholdMs` → segment closed at its last real fix, new segment; straight-line chord counted only if plausible (configurable) | gap `signal_loss` |
| Position filter | accuracy-weighted Kalman (process noise per sport) | filtered coordinate |
| Doppler gate | platform speed below `stationarySpeedMps` → stationary | `stationary` (no distance) |
| Movement gate | filtered displacement from anchor < `max(minMovement, factor × mean accuracy)` | `stationary` (no distance) |
| Accept | distance += geodesic distance anchor→filtered | `accepted` |
| Segment close | at pause, gap, leg change and finish: last leg re-solved against the latest raw fix when moving (≥ 0.5 m/s) — recovers filter lag | — |

**No points are ever synthesised.** Gaps are recorded as metadata; the map shows a break.

## Distance

Haversine on the IUGG mean Earth radius (6 371 008.8 m) — error far below consumer GPS accuracy
at activity scale. Distance is measured from the last *accepted anchor*, so slow movement whose
per-fix steps are below the noise radius still accrues once it exceeds it.

**Filter lag** (≈3–4 m behind genuine motion) is recovered when a segment is closed, by re-solving
the final leg against the latest *raw* fix — a real recorded sample, never a synthesised point.
Stationary drift is suppressed by the movement gate and, when the platform reports it, by Doppler
speed, which stays near zero while the position wanders. Measured results and tolerances are in
[GPS_RELIABILITY_AUDIT.md](GPS_RELIABILITY_AUDIT.md#accuracy-scenarios-tolerances-and-justification).

## Time, pace, speed

- **Elapsed time** = finish − start (wall clock).
- **Moving time** = sum of intervals in `RECORDING` that are not auto-paused. Pauses,
  interruptions and auto-pauses are excluded; auto-pause is back-dated to when the athlete
  stopped.
- **Pace** = moving time / distance (ms per km), only above `minDistanceForAveragesMeters`.
- **Speed** = distance / moving time. Current speed uses a rolling window; max speed only counts
  windows covering ≥ half the window to avoid single-pair spikes.
- Samples recorded before a pause but delivered after it are still counted (batched delivery).

## Elevation

GPS altitude error is large and temporally correlated, so plain hysteresis counts its slow wander
as climbing (measured 2–3× inflation). Altitude is first smoothed with a time-based exponential
moving average (τ = 10 s), then gain/loss is accrued with a 5 m hysteresis. Fixes with vertical
accuracy worse than 20 m are ignored; smoothing and reference reset across pauses. Splits use the
same filter. Parameters were chosen from a sweep over the replay scenarios (audit F15); GPS-only
elevation remains ±5–20 %. A barometric source is the planned improvement.

## Policies (per sport)

`GPS_POLICIES` in `policy.ts` — acquisition hints (accuracy, distance filter, CLActivityType) and
processing thresholds for `run`, `walk`, `hike`, `ride`, `open_water_swim`. Pool swims use no GPS;
triathlon legs use their sport's policy; transitions use none.

## Auto-pause

Per-sport thresholds with hysteresis (`stopSpeed < resumeSpeed`) and a stop delay. Unknown speed
(no fix) never triggers auto-pause, so tunnels do not stop the clock.

## Native recorder (iOS)

- One `LocationRecorder` per process (survives JS reloads), driving `CLLocationManager` through a
  small `LocationManaging` protocol so the logic is unit-tested with XCTest.
- `pausesLocationUpdatesAutomatically = false`; background updates, the blue indicator and
  `CLBackgroundActivitySession` (iOS 17+) only while recording.
- `SampleJournal`: JSON lines per activity in Application Support with
  `completeUntilFirstUserAuthentication` protection (writable while locked), fsync per batch,
  journal-before-notify, a persisted `ackThrough` high-water mark, `nextSequence` from JS so
  numbering never restarts, and torn-tail repair.
- No automatic restart after a process restart: JS recovers the activity as `INTERRUPTED`.

**Not yet validated on hardware** — see TESTING.md. iOS can still suspend or terminate apps in
extreme conditions; PACE recovers everything that was captured.

## Replay testing

`replaySession(config, events, samples)` rebuilds any session exactly; `runScript` drives a live
session over a sample sequence with commands at sample indices. Synthetic tracks (straight lines,
drift, jumps, gaps, noise with a seeded PRNG) live in `gps-engine/src/test-fixtures` and are used
**only** in tests. Recorded GPX files can be replayed by parsing them with `@pace/formats`.
