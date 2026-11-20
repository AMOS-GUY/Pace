# M5.0: First physical-device validation (iPhone 13)

_Prepared 2026-11-20 against `main` at `1c8fb46`._ This document describes the first PACE test on
a real iPhone: what has to be true before it, how to build and install PACE, what to test, and
where to record the results.

**Nothing in this document has been run on a physical iPhone yet.** No GPS reliability, background
recording or battery claim can be made until the device tests below are recorded.

**Click-by-click Mac and signing steps:** [FREE_IPHONE_TESTING.md](FREE_IPHONE_TESTING.md),
sections 3–6. This document adds the Xcode 27 evidence, the structured test plan and the results
tables. Where the two differ, this one is newer.

## Evidence levels

Every row in this document uses one of these:

| Level | Meaning |
|---|---|
| **Simulator-verified** | Run in CI on an iOS simulator. Real GPS, real background execution and real permissions are not exercised. |
| **Build-verified** | CI compiled and linked PACE for a physical iPhone (`iphoneos`, arm64) without signing, and checked the app bundle. Nothing was installed. |
| **Physical-device-verified** | Done on the iPhone 13 and recorded in section 9. |
| **Not tested** | No evidence yet. |
| **Blocked** | Cannot be done without something that isn't available yet (named in the row). |

## 1. Repository state for the first build

**Main `1c8fb46`** contains:
- Backup V2 (PR #12);
- the UI stabilization work through `88e805c` (PRs #14 and #16);
- the fidelity and first-build docs (PR #17).

| Merged into `main`? | Branch | Effect on the device test |
|---|---|---|
| **No** | `fix/import-time-bounds-v2` (`7bbb55d`) | Without it, one GPX, TCX or FIT time outside 2000–2100 drops later points and makes the next backup unrestorable. Merge it before testing imports and backups on the device. |
| **No** | `fix/fit-same-second-v2` (`9e4553b`) | Without it, FIT records sharing a second lose sensor values and GPS points. Merge it before the FIT checklist (section 7). |

Recording tests (sections 5–6) don't depend on either fix. Build from `main` after merging them, or
record that they were absent.

## 2. Environment

### What the borrowed Mac and the iPhone need

| Item | Requirement | Status |
|---|---|---|
| Mac | macOS **27.0.1** (the borrowed Mac) | — |
| Xcode | **27.x** from the Mac App Store. Xcode 26.6 doesn't run on macOS 27. | Build-verified (section 3) |
| Swift | 6.2 or later (Expo's `ExpoModulesJSI` declares `swift-tools-version: 6.2`) | Build-verified: Xcode 27's Swift |
| Node.js | 24 (22.13+ works) | — |
| pnpm | 12.18.0 via Corepack | — |
| CocoaPods | 1.16 or later | Build-verified with the CI image's version (section 3) |
| iPhone 13 | **iOS 16.4 or later** (deployment target 16.4). iOS 17+ is better for background recording (see 2.3). | — |
| Cable | Lightning to USB-C or USB-A | — |
| Wi-Fi | Mac and iPhone on the same network, for Metro | — |
| Apple Account | **Your own**, free, as a Personal Team. Never the Mac owner's. | — |
| Supabase project | URL and **publishable** key in `apps/mobile/.env`. Sign-in is mandatory. Without it PACE shows only "PACE is not configured". The free tier is enough. | **Blocked until you create it** |

### What the app declares (checked in the code and in the CI-built device app)

| | Value | Where |
|---|---|---|
| Development variant | **PACE Dev**, bundle ID **`app.pace.ios.dev`** (`APP_VARIANT=development`) | `app.config.ts` |
| Deployment target | iOS **16.4** | `expo-build-properties`, `PaceTracking.podspec` |
| Background mode | `UIBackgroundModes: [location]` | `app.config.ts` `infoPlist` |
| Location texts | `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription` | `app.config.ts` |
| Entitlements | None that a free Personal Team can't use: no push, iCloud, App Groups or Associated Domains. Check `ios/PACEDev/PACEDev.entitlements` after prebuild. | [FREE_IPHONE_TESTING.md](FREE_IPHONE_TESTING.md) §1 |
| Native module | `PaceTracking` (Swift, Expo module, linked statically) | `apps/mobile/modules/pace-tracking` |
| Database | SQLite (`expo-sqlite`), session key in the Keychain (`expo-secure-store`) | — |

### 2.3 How location permission and background recording work (as implemented)

- **"While Using" only.** PACE asks for "While Using" during onboarding (Allow location) or when
  the first recording starts. **It never asks for "Always":** no code path requests it. If a
  checklist expects an "Always" prompt, the checklist is wrong.
- **Background recording with "While Using":**
  - the recorder starts location updates while the app is in the foreground, with
    `allowsBackgroundLocationUpdates` and `showsBackgroundLocationIndicator` on and
    `pausesLocationUpdatesAutomatically` off;
  - **on iOS 17+** it also opens a `CLBackgroundActivitySession`;
  - iOS should keep delivering locations while the screen is locked, and show the **blue location
    indicator**.
- **Requires the device test.** This background behaviour is the most important thing to verify.
  It cannot be simulated reliably.
- **iOS 16.4–16.x:** without `CLBackgroundActivitySession`, background updates depend only on the
  background mode and on the updates having started in the foreground. Record the iPhone's iOS
  version with every result.

## 3. Xcode 27 compatibility (CI evidence)

GitHub's `xcode-27` runner image runs **macOS 27.0.1**, the same OS as the borrowed Mac. The
workflow `.github/workflows/ios-xcode27.yml` does the following on it for **Xcode 27.0 and 27.2**,
without any Apple account:

1. Swift unit tests of the recorder core.
2. `APP_VARIANT=development npx expo prebuild --platform ios`, then `pod install`, exactly as on
   the Mac.
3. A **Debug build for a physical iPhone** (`-sdk iphoneos -destination 'generic/platform=iOS'`,
   unsigned). This is the build you install with your Personal Team.
4. A check of the built app (`scripts/ci/check-device-app.sh`):
   - an arm64 `iphoneos` binary;
   - bundle ID `app.pace.ios.dev` and minimum iOS 16.4;
   - `UIBackgroundModes` contains `location`, and both location texts are present;
   - `PaceTrackingModule` is compiled in.
5. A Release build for the simulator, launched on an **iOS 27 simulator**, which must keep running.

| Check | Xcode 27.0 | Xcode 27.2 |
|---|---|---|
| Swift tests | _pending run_ | _pending run_ |
| Prebuild and pods | _pending run_ | _pending run_ |
| Device build (Debug, iphoneos, arm64) | _pending run_ | _pending run_ |
| Device app checks | _pending run_ | _pending run_ |
| Release simulator build and iOS 27 launch | _pending run_ | _pending run_ |

**What this does not prove:**
- **Signing:** the Personal Team signs on the Mac, and CI can't sign.
- **Installation:** installing on the iPhone, Developer Mode, and the "Untrusted Developer" step.
- **Runtime on hardware:** GPS, permissions and background execution on real hardware.
- **Metro:** the Debug build loading its JavaScript from Metro over Wi-Fi.

## 4. Build and install on the borrowed Mac

Follow [FREE_IPHONE_TESTING.md](FREE_IPHONE_TESTING.md) §4.1–4.8. In short:

```bash
xcodebuild -version && xcrun swift --version     # Xcode 27.x, Swift 6.2 or later
```
```bash
git clone https://github.com/AMOS-GUY/Pace.git && cd Pace && git checkout main && git pull origin main
```
```bash
git rev-parse --short HEAD     # record it; it must contain 1c8fb46: git merge-base --is-ancestor 1c8fb46 HEAD && echo ok
```
```bash
corepack enable && pnpm install --frozen-lockfile && pnpm build
```
```bash
cd apps/mobile && APP_VARIANT=development npx expo prebuild --platform ios
```
Then:
1. Create `apps/mobile/.env` with the Supabase URL and publishable key, and add `pace://**` to
   Supabase's redirect URLs.
2. Open `ios/PACEDev.xcworkspace`. Under Signing & Capabilities, choose **your** Personal Team, and
   don't change the bundle ID.
3. Select the iPhone and **Run** (Debug).
4. On the iPhone, trust the developer (Settings → General → VPN & Device Management).
5. Start Metro: `APP_VARIANT=development pnpm start`.

**Stop and report, without changing anything,** if:
- the bundle ID can't be registered;
- Xcode reports a capability your team can't use;
- the build fails. Copy the first `error:` lines and the Xcode version.

Don't modify native code, dependencies, permissions or background settings to get past an error.

## 5. Recording test plan

Do these **outdoors**, with a clear sky view, at the same place each time. Note the time, iOS
version, PACE commit, battery % and conditions. **Safety first:** walking is enough, and don't
look at the phone while crossing roads.

### A. Install and first launch
| # | Test | Expected |
|---|---|---|
| A1 | Install, trust, open PACE Dev | Opens without crashing; the dev client finds Metro |
| A2 | First screen | Welcome (not "PACE is not configured") |
| A3 | Sign up or sign in | Account works; the email-verification link opens PACE Dev |
| A4 | Onboarding: profile → sports → units → location | Each step works; **Allow location** shows the system prompt with PACE's text |
| A5 | Choose "While Using" | Onboarding finishes on Home |
| A6 | Navigation: all five tabs, Profile → settings, back buttons | No crash, no redirect loop, no stuck spinner; the Activity detail back button is a chevron |
| A7 | Deep link while signed in: open `pace://activities` from Safari | Opens the Activities tab (no loop) |

### B. Recording (foreground)
| # | Test | Expected |
|---|---|---|
| B1 | Record → Start Run → Find GPS | "Getting ready" shows accuracy. **Start** appears when the fix is good. |
| B2 | Start; walk 5 minutes | Timer runs, distance grows, pace is shown, the GPS indicator is good |
| B3 | Show map | The route is drawn (on a plain background unless map tiles are configured) |
| B4 | Compare | Elapsed time matches a clock; distance is plausible against a known route or a watch |

### C. Background and screen lock
| # | Test | Expected |
|---|---|---|
| C1 | During a recording, lock the screen for **10 minutes** while walking | **Blue location indicator** while locked |
| C2 | Unlock | The timer kept running; distance covers the locked period |
| C3 | After finishing: route | **No straight-line gap** over the locked period; GPS fixes used is roughly the duration in seconds |
| C4 | Switch to another app for 5 minutes, then return | As C2 and C3 |

### D. Pause and resume
| # | Test | Expected |
|---|---|---|
| D1 | Pause; stand still 2 minutes; Resume | While paused: PAUSED state, moving time stops, elapsed time continues |
| D2 | After finishing | Moving time excludes the pause; activity detail shows the paused time; the route has no movement during the pause |

### E. Interruptions
| # | Test | Expected |
|---|---|---|
| E1 | Walk under a bridge or into a building for about 1 minute | Low-accuracy or lost period handled; no jump in the route; recovers outside |
| E2 | Incoming call or notification during a recording | The recording continues |
| E3 | Force-quit PACE Dev during a recording, then reopen | The interrupted recording is recovered and nothing captured is lost |

Don't do anything that could damage the phone or put you at risk (no extreme heat or cold, no
running in traffic).

### F. Finish and save
| # | Test | Expected |
|---|---|---|
| F1 | Finish → "Finish activity?" → Finish & save | "Activity saved" with distance and time |
| F2 | View activity | Route, totals, splits, details (start and finish times correct, time zone) |
| F3 | Activities, Home and Progress tabs | The activity appears; totals update; chart labels are readable |
| F4 | Force-quit and reopen | The activity is unchanged |

### G. Battery (one observation, not a benchmark)
| # | Record |
|---|---|
| G1 | Battery % at start, duration, battery % at finish (aim for 30 minutes or more) |
| G2 | Low Power Mode on or off; screen locked most of the time or not |
| G3 | Whether the phone became noticeably warm |

**A single short test supports no battery-efficiency claim.** Report the numbers as observed.

## 6. Backup and restore on the device

| # | Test | Expected |
|---|---|---|
| H1 | Settings → Backup & restore → passphrase (12+ characters) → Create backup file | A `.pacebackup` file is shared or saved |
| H2 | Backup version | The restore report never names the format. A format-2 backup reports "Restored N activities with M heart-rate, cadence and power samples" (when there are any). A format-1 backup (from before PR #12) adds "made by an older version of PACE", and its banner is a warning. |
| H3 | Clean install: delete PACE Dev (**this deletes its data**, so export first), reinstall, sign in | Empty app |
| H4 | Restore from file with the passphrase | Green report: "Restored N activities with M … samples", and "Your preferences and profile were replaced with the backup's" |
| H5 | Compare | Same activities, routes, distances, laps; heart rate, cadence and power present (if any were recorded or imported) |
| H6 | Profile and settings | Display name, units and preferences restored |
| H7 | Wrong passphrase | A clear error; nothing changes |
| H8 | Restore the same file again | Existing activities are skipped, not duplicated |

## 7. FIT import with real device files

**Not tested: no real device file has been imported yet.** Use your own files only, and don't
commit them or upload them anywhere.

| # | Source | Check |
|---|---|---|
| I1 | Garmin `.fit` (run with heart rate) | Imports; route, distance and time match the watch; HR present |
| I2 | COROS `.fit` | Same |
| I3 | Wahoo `.fit` (ride with power and cadence) | Power and cadence present; laps match |
| I4 | Any file | Warnings list what was not imported. With `fix/fit-same-second-v2` merged: "merged" or "conflicting" counts when records share a second. |
| I5 | Timestamps | Start time and time zone correct. No activity shows a time outside 2000–2100 (`fix/import-time-bounds-v2`). |
| I6 | Laps | Lap count and lap times match the device |
| I7 | Re-import the same file | Refused as a duplicate |
| I8 | Back up and restore after importing (section 6) | Imported sensor data survives |

## 8. Troubleshooting

See [FREE_IPHONE_TESTING.md](FREE_IPHONE_TESTING.md) §10. Additions for Xcode 27:

| Problem | What to do |
|---|---|
| Xcode 27 build fails while CI's Xcode 27 build passed | Compare `xcodebuild -version` with the CI run (section 3). Send the first `error:` lines. Don't change dependencies. |
| "iOS x.y is not supported by this Xcode" | Update Xcode from the App Store (27.x). Don't downgrade macOS. |
| "Signing for PACEDev requires a development team" | Choose your Personal Team (§4.7 of the guide) |
| Background recording stops while locked | Record the iOS version, whether the blue indicator showed, and the permission (Settings → PACE Dev → Location). Report it. **Don't switch to "Always" as a fix without discussing it:** the design uses "While Using". |

## 9. Results

Copy this table for each session and fill in every row. The status is one of PASSED, FAILED,
BLOCKED or NOT RUN, with a note.

**Session:** date · location · iPhone 13, iOS ____ · Mac macOS ____, Xcode ____ · PACE commit ____ · weather ____

| Area | Rows | Status | Notes (numbers, screenshots, exact errors) |
|---|---|---|---|
| Build on the Mac | §4 | NOT RUN | |
| Install and first launch | A1–A7 | NOT RUN | |
| Recording | B1–B4 | NOT RUN | |
| Background and screen lock | C1–C4 | NOT RUN | |
| Pause and resume | D1–D2 | NOT RUN | |
| Interruptions | E1–E3 | NOT RUN | |
| Finish and save | F1–F4 | NOT RUN | |
| Battery | G1–G3 | NOT RUN | |
| Backup and restore | H1–H8 | NOT RUN | |
| FIT import (real files) | I1–I8 | NOT RUN | |

## 10. Status summary

| Capability | Status |
|---|---|
| App launch, navigation, onboarding, sign-in (local stand-in), recording from simulated GPS, activity detail | **Simulator-verified** (UI preview workflow, iOS 26.5) |
| Signed-out access control via deep links | **Simulator-verified** |
| Device build with Xcode 27 on macOS 27 | **Build-verified** once the run in section 3 passes |
| Signing with a free Personal Team, installation | **Not tested** (needs your Apple Account on the Mac) |
| GPS on hardware, background recording while locked, interruptions, battery | **Not tested**; blocked on the device session |
| Backup and restore on a device | **Not tested** |
| Real Garmin, COROS and Wahoo FIT files | **Not tested** (needs your files) |
| Supabase sign-up and email links on a device | **Blocked** until a Supabase project exists |
