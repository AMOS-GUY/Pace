# Roadmap

Status legend: ✅ implemented & automatically tested · 🟡 implemented, needs device/service
validation · ⬜ not started.

| Milestone | Status | Notes |
|---|---|---|
| M0 Foundation | 🟡 | Monorepo, toolchain, CI, docs, tokens, DB, navigation. Exit criterion (runs on a real iPhone) needs macOS. |
| M1 Auth & onboarding | 🟡 | Sign up/in, verification, reset (deep links), session persistence, onboarding, permission explanation. Needs a Supabase project to validate. |
| M2 Native GPS engine | 🟡 | Swift recorder + journal, state machine, incremental persistence, distance, recovery — engine ✅, Swift not compiled/tested on device. |
| M3 Core activity experience | 🟡 | Run/ride/walk/hike recording UI, live metrics, summaries. |
| M4 History & analytics | ✅/🟡 | List/filter/search, detail, splits, laps, maps, weekly/monthly stats, records, GPX import/export — logic ✅, UI on device 🟡. |
| M4.5 Data portability | ✅/🟡 | TCX import, GPX cadence/power, bulk import (files, ZIP, gzip) with ZIP-bomb/path protection and a per-file report, duplicate detection across sources, full export (JSON, CSV, GPX) with privacy zone — logic ✅, iOS file handling 🟡. |
| M4.6 FIT import | ✅/🟡 | Independent FIT decoder (no Garmin SDK code), FIT activities with laps, pauses, heart rate, cadence, power and swim–bike–run triathlons, `.fit`/`.fit.gz` in bulk import, migration 3 — logic ✅; real device files, iOS and legal review 🟡. |
| M5 Backup & sync | ✅/🟡 | Encrypted local/cloud backup, restore by replay, outbox sync, conflict rules, account deletion — needs S3 + Supabase to validate end to end. |
| M6 Swimming & triathlon | ✅/🟡 | Pool laps, open-water policy + limitation notice, triathlon legs and transitions. |
| M7 Private beta | ⬜ | Device test plan, battery tuning, Sentry, TestFlight. |
| M8 Commercial release | ⬜ | Purchases → entitlements, legal docs, store assets, submission. |
| M9 Android | ⬜ | Kotlin `TrackingBridge` (Fused Location + foreground service), Health Connect. |
| M10 Wearables | ⬜ | Apple Watch, HealthKit, BLE heart rate / cadence / power. |

## Next concrete steps

1. On macOS: `expo prebuild`, compile, fix any Swift issues, add XCTests for `SampleJournal`.
2. Run the physical-device test plan (TESTING.md) for running and cycling.
3. Create the Supabase project; run Maestro auth + recording flows.
4. Deploy the API (Postgres + S3) to staging; validate cloud backup round-trip.
5. Generate OpenAPI from the Zod schemas; add Sentry with PII scrubbing.
6. HealthKit write of completed workouts (with duplicate detection by `external_id`).
