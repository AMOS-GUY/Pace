# Architecture

## Principles

1. **Local-first.** Recording, history and analytics work with no network. SQLite on the phone is
   the source of truth for activity data; the cloud is a supplement.
2. **Native owns recording.** Location capture and persistence happen in Swift, independent of the
   JavaScript runtime. JavaScript observes, processes and displays.
3. **Deterministic domain core.** GPS processing, the recording session and metrics are pure
   TypeScript with an injected clock — the same inputs always give the same outputs, which makes
   them testable on any machine and replayable after a crash.
4. **Ports and adapters.** Domain packages define interfaces (`TrackingBridge`, `RecordingStore`,
   `SqlDriver`, `SyncTransport`, `ObjectStorage`); apps provide implementations.

## Layers

```text
┌──────────────────────── apps/mobile ────────────────────────┐
│ Screens (Expo Router) → stores (Zustand) / queries (TanStack)│
│        │                         │                           │
│        ▼                         ▼                           │
│  RecordingCoordinator      core services (import, backup…)   │
│   (activity-engine)              │                           │
│     │            │               ▼                           │
│     │            └──────► database (SqliteRecordingStore,    │
│     │                     repositories) ─► expo-sqlite       │
│     ▼                                                        │
│  TrackingBridge ──► modules/pace-tracking (Swift)            │
│                       CLLocationManager → SampleJournal      │
└──────────────────────────────────────────────────────────────┘
                 │ optional (outbox sync, encrypted backups)
                 ▼
┌──────────────────────── apps/api ───────────────────────────┐
│ AuthGuard (Supabase JWT) → modules → Drizzle → PostgreSQL     │
│                                    └→ ObjectStorage (S3)      │
└──────────────────────────────────────────────────────────────┘
```

## Package dependency graph

```text
domain ◄── gps-engine ◄── sports
   ▲            ▲            ▲
   │            └─ metrics-engine
   │                    ▲
   └──────── activity-engine ◄── database ◄── core ◄── apps/mobile
validation ◄── formats, backup, api           sync ◄── apps/mobile
design-system ◄── apps/mobile
```

No package depends on an app; no domain package depends on infrastructure.

## Recording data flow

1. **Prepare** – `coordinator.prepare(sport)` checks location authorisation and starts
   *acquisition-only* updates (foreground, not journaled, not persisted) to show GPS quality.
2. **Start** – creates exactly one activity row (with the full `SessionConfig` for replay), records
   a `started` event and calls `bridge.startRecording(activityId, policy)`. Native enables
   background updates (`allowsBackgroundLocationUpdates`, `CLBackgroundActivitySession` on iOS 17+).
3. **Capture** – for every fix, native appends to an fsync'd per-activity JSON-lines journal
   (gap-free sequence numbers) *before* emitting `onSamples` to JS.
4. **Persist** – the coordinator feeds each sample to the `RecordingSession` (GPS processing,
   auto-pause), then writes raw samples + control events + live metrics to SQLite in one
   transaction, and only then acknowledges the journal sequence to native.
5. **Commands** (pause/resume/lap/next leg/finish) first *drain* the journal so the event lands in
   exact sample order (`afterSampleCount`).
6. **Finish** – the session summary (metrics, laps, legs, splits, processed route, record
   candidates) is written in one transaction; personal records are recomputed; an outbox entry is
   queued for sync; the native journal is deleted.

### Recovery

The native recorder is a process-wide singleton: reloading the JavaScript runtime keeps recording,
and the next coordinator instance continues from the journal. After a *process* restart nothing
restarts automatically.

On launch the coordinator looks for an activity in `recording/paused/interrupted`. It rebuilds the
session by **deterministic replay** of the persisted events and samples, then drains anything the
native journal captured while JS was not running. If native is no longer recording (e.g. device
restart), the session becomes `INTERRUPTED` with moving time stopped at the last known data; the
user can resume or finish. A session found in `FINALIZING` (crash during save) is completed. A
failing native bridge never blocks recovery of what SQLite already holds. Nothing is discarded
without an explicit user action.

## State machine

`READY → ACQUIRING_GPS → RECORDING ⇄ PAUSED → FINALIZING → SAVED`, plus `PERMISSION_DENIED`,
`LOCATION_UNAVAILABLE`, `RECOVERING`, `INTERRUPTED`, `FAILED`. Implemented as a pure `transition()`
function (packages/activity-engine/src/state-machine.ts); invalid events are rejected, never
silently ignored. A failed save is `FAILED{recoverable}` and can be retried — raw data is already
on disk.

## Multisport

A triathlon is one activity with five legs (swim, T1, bike, T2, run). Each GPS leg has its own
`RouteProcessor` and GPS policy; transitions are timed but not distance-measured. Legs are stored
in `activity_segments`; parent totals are the sum of legs.

## Android readiness

All shared code is platform-neutral. Android needs a Kotlin implementation of the same
`TrackingBridge` (Fused Location Provider + foreground service + the same journal contract) and a
module entry in `expo-module.config.json`. No TypeScript changes are expected.
