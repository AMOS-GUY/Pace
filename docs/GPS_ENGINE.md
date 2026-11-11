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
| Plausibility | `(d − accA − accB) / dt ≤ maxPlausibleSpeed` vs anchor | `rejected: implausible_jump` |
| Re-anchoring | N (3) consecutive mutually-consistent "jump" samples → new segment, no distance across the jump | `accepted` + gap `reanchor` |
| Gap detection | no usable fix for `gapThresholdMs` → new segment; straight-line chord counted only if plausible (configurable) | gap `signal_loss` |
| Position filter | accuracy-weighted Kalman (process noise per sport) | filtered coordinate |
| Movement gate | filtered displacement from anchor < `max(minMovement, factor × mean accuracy)` | `stationary` (no distance) |
| Accept | distance += geodesic distance anchor→filtered | `accepted` |

**No points are ever synthesised.** Gaps are recorded as metadata; the map shows a break.

## Distance

Haversine on the IUGG mean Earth radius (6 371 008.8 m) — error far below consumer GPS accuracy
at activity scale. Distance is measured from the last *accepted anchor*, so slow movement whose
per-fix steps are below the noise radius still accrues once it exceeds it.

**Known trade-off:** the Kalman filter lags genuine motion slightly; at a pause or the end of an
activity ≈3–4 m per segment is not recovered (≈0.07 % of a 5 km run). This is preferred over the
much larger inflation caused by unfiltered jitter (tests: 600 s of 8 m jitter → < 60 m instead of
≈2.5 km; noisy run within 3 % of truth).

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

Hysteresis accumulator: gain/loss is only added once altitude moves beyond a threshold (3–4 m)
from the reference, with altitudes rejected when vertical accuracy exceeds 20 m. The reference
resets across pauses. Splits use the same filter. Barometric altitude is a planned input source.

## Policies (per sport)

`GPS_POLICIES` in `policy.ts` — acquisition hints (accuracy, distance filter, CLActivityType) and
processing thresholds for `run`, `walk`, `hike`, `ride`, `open_water_swim`. Pool swims use no GPS;
triathlon legs use their sport's policy; transitions use none.

## Auto-pause

Per-sport thresholds with hysteresis (`stopSpeed < resumeSpeed`) and a stop delay. Unknown speed
(no fix) never triggers auto-pause, so tunnels do not stop the clock.

## Native recorder (iOS)

- `CLLocationManager`, `pausesLocationUpdatesAutomatically = false`, background updates and the
  blue indicator only while recording; `CLBackgroundActivitySession` on iOS 17+.
- `SampleJournal`: JSON lines per activity in Application Support with
  `completeUntilFirstUserAuthentication` protection (writable while locked), fsync per batch, a
  persisted `ackThrough` high-water mark so sequence numbers never restart after compaction.
- Relaunch: the active activity and its policy are stored in `UserDefaults`; the module resumes
  journaling on creation.

**Not yet validated on hardware** — see TESTING.md for the physical-device plan. iOS may still
suspend or terminate apps in extreme conditions (low power, user force-quit); PACE does not claim
uninterrupted tracking in those cases, it recovers what was captured.

## Replay testing

`replaySession(config, events, samples)` rebuilds any session exactly; `runScript` drives a live
session over a sample sequence with commands at sample indices. Synthetic tracks (straight lines,
drift, jumps, gaps, noise with a seeded PRNG) live in `gps-engine/src/test-fixtures` and are used
**only** in tests. Recorded GPX files can be replayed by parsing them with `@pace/formats`.
