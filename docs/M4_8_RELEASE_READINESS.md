# M4.8 release readiness: data integrity, backup security, import reliability

_Status as of 2026-11-14._ **No feature has been tested on a physical iPhone or with real device
recordings.** Nothing below is production-ready on the strength of automated tests alone.

**Evidence levels:**
- **U:** unit-tested.
- **I:** integration-tested: real services and real SQLite (`node:sqlite`) in Node.
- **S:** simulator-tested: CI builds the app and launches it on an iOS simulator, and Maestro
  checks the first screen.
- **D:** tested on a physical iPhone.
- **R:** tested with real device recordings (Garmin, COROS, Wahoo files).

## 1. Feature readiness

| Area | U | I | S | D | R | Notes |
|---|---|---|---|---|---|---|
| App launch, first screen | — | — | ✅ | ❌ | — | CI: the simulator build launches and stays up; Maestro sees the first screen |
| Sign-up, sign-in, email verification | ✅ | — | ❌ | ❌ | — | Needs a Supabase project. Not exercised end to end. |
| Onboarding, permissions screens | ✅ (logic) | — | ❌ | ❌ | — | |
| GPS recording (foreground) | ✅ | ✅ (replay suite) | ❌ | ❌ | — | Engine verified with synthetic GPS only |
| Background recording, screen lock | ✅ (Swift XCTests) | — | ❌ | ❌ | — | The biggest open risk |
| GPS interruption and recovery, app termination | ✅ | ✅ | ❌ | ❌ | — | Journal recovery tested in Swift and TypeScript |
| Pause and resume, laps, triathlon legs | ✅ | ✅ | ❌ | ❌ | — | |
| Activity detail, splits, laps, records | ✅ | ✅ | ❌ | ❌ | — | UI never rendered on a device |
| Local persistence, restart recovery | ✅ | ✅ | ❌ | ❌ | — | |
| GPX, TCX, FIT import | ✅ | ✅ | ❌ | ❌ | ❌ | FIT validated with synthetic files and a harness only |
| ZIP and gzip archives, bulk import, cancellation | ✅ | ✅ | ❌ | ❌ | ❌ | |
| GPX export, portable export | ✅ | ✅ | ❌ | ❌ | — | |
| Encrypted backup and restore | ✅ | ✅ | ❌ | ❌ | — | Format 2 is on `feature/backup-v2` (not merged) |
| Privacy zone on export | ✅ | ✅ | ❌ | ❌ | — | |
| Empty states (new athlete) | ✅ | ✅ | ❌ | ❌ | — | |
| Battery behaviour | — | — | — | ❌ | — | Not measured anywhere |
| Offline recording | ✅ (design: local-first) | ✅ | ❌ | ❌ | — | |

## 2. Data-integrity readiness

| Path | Status | Evidence |
|---|---|---|
| FIT → PACE | ✅ synthetic | Decoder fuzzing, mapping tests, M4.7 harness |
| FIT records sharing a second | 🟡 Fixed on `fix/fit-same-second-records` (R4), not merged | Synthetic; whether devices produce them is unverified |
| Timestamps outside 2000–2100 | 🟡 Fixed on `fix/import-time-bounds`, not merged | **On main, one such GPX or TCX point makes every later backup unrestorable** |
| PACE → GPX → PACE | ✅ points, times, pauses, heart rate, cadence (R6), power (R1). ❌ laps (R2), legs (R3). | Merged |
| PACE → backup → restore | Format 1 (main): ❌ heart rate, cadence and power lost (R7). Format 2 (branch): ✅ exact. | `backup-v2.test.ts`, `backup-v2-audit.test.ts` |
| FIT, TCX, GPX and a triathlon → backup format 2 → restore | ✅ exact: points, events, laps, legs, splits, sensors in stored order | Audit test, encrypted and plain |
| Existing data with bad timestamps | ❌ not repaired | Only new imports are guarded |

Details: [DATA_FIDELITY.md](DATA_FIDELITY.md), [EXPORT_FORMATS.md](EXPORT_FORMATS.md), and
BACKUP_FORMAT.md on `feature/backup-v2`.

## 3. Security readiness

| Item | Status |
|---|---|
| Archive limits, unsafe paths, ZIP bombs, nested archives, damaged gzip | ✅ tested |
| FIT decoder: bounds, checksums, fuzzing | ✅ tested |
| GPX/TCX: DTD and entities refused; NaN, Infinity and out-of-range coordinates and sensors skipped | ✅ probed |
| Backup decompression cap | 🟡 Format 2 branch: 512 MB, enforced while decompressing. **Main has no cap.** |
| Backups containing auth-session rows | **Main: format-1 backups include the encrypted `secure:*` rows and restore can write them back.** Format 2 branch: never backed up or restored. |
| Unknown or relabelled backup content | 🟡 Format 2 branch: strict, refused. Main: unknown fields dropped. |
| Restore atomicity | ✅ per activity. Goals and settings are reported (format 2 branch), not all-or-nothing overall by design. |

## 4. Device validation readiness

- **Guide:** [FREE_IPHONE_TESTING.md](FREE_IPHONE_TESTING.md). It builds `main`, uses free Personal
  Team signing, and has a 21-item checklist, all NOT RUN.
- **The borrowed Mac reports macOS 27.0.1.** Apple lists Xcode 26.6 (the version CI validates)
  only up to macOS Tahoe 26.x, so that Mac needs Xcode 27. PACE has **never** been built with
  Xcode 27. The exact installed Xcode is not confirmed.
- **Accounts:** the owner's Apple Account, and a Supabase URL and publishable key.

## 5. Known limitations

- GPX has no laps or legs.
- PACE does not import `data.json`.
- There is no TCX or FIT export.
- Indoor activities without GPS are refused.
- Backups are built and read entirely in memory. Synthetic restore of about 180,000 sensor
  samples grew the Node heap by up to about 200 MB; very large histories are a phone memory
  risk.
- Format-2 backups cannot be read by older app versions.
- Imported activities get the phone's timezone.

## 6. Critical blockers for a first beta

1. **No physical-device run:** recording, background GPS and permissions are unproven on an
   iPhone.
2. **Unmerged data-integrity fixes:** backup format 2 (sensor loss, auth-session rows,
   decompression cap) and the timestamp bounds (unrestorable backups).
3. **Xcode 27 compatibility** is unknown, and it is the only Xcode the borrowed Mac supports.

**Medium:**
- Real device recordings (FIT from Garmin, COROS, Wahoo) not yet validated.
- Battery behaviour not measured.
- R4 needs review.
- Settings restore replaces local preferences (by design; confirm it's what you want).

## 7. Recommended next milestone

**M5.0 — First physical-device session.** After merging the data-integrity branches:
1. Build `main` with Xcode 27 on the borrowed Mac. That build is also the Xcode 27
   compatibility test.
2. Install on the iPhone 13 and run the 21-item checklist, including a locked-screen outdoor
   recording and a battery reading.
3. Export and back up, then restore onto a clean install, to check the data path on a device.

Only after that should real FIT recordings be validated (M4.7 guide).
