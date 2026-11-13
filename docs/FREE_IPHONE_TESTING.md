# Testing PACE on your iPhone with a free Apple Account

This is the no-cost route: a free Apple Account, a Mac with Xcode for the build, and Xcode's
**Personal Team** signing. It installs a development build of PACE, with its native Swift GPS
module, on your iPhone 13.

> **Status:** prepared, not yet done. Nothing in this guide has been run on a physical device.
> CI builds and launches the app on an iOS *simulator* only. Install, location permissions and
> background GPS on the iPhone are untested until you do it.

The paid route (EAS Build, no Mac needed, profiles valid for a year) is in
[IPHONE_DEVELOPMENT_BUILD.md](IPHONE_DEVELOPMENT_BUILD.md). The two routes are compared there.

## Is a Mac required?

**Yes, for this route.** Apple signs apps for a free Personal Team only through Xcode, and Xcode
runs only on macOS. Expo's iOS build (`expo prebuild` for iOS) also refuses to run on Windows. The
Mac can be borrowed: you need it for the first build and again about once a week (see "Every 7
days").

Your Windows PC can still serve the JavaScript while you develop (see "Using Metro on Windows").

## What Apple allows a free account (Personal Team)

From Apple's [developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account)
and [supported capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios):

| Limit | Free Personal Team |
|---|---|
| App IDs | Up to 10, each expiring after 7 days |
| Devices | Up to 3, each expiring after 7 days |
| Apps installed per device | Up to 3 |
| Provisioning profile lifetime | 7 days, then rebuild and reinstall |
| Background Modes (background location) | **Supported** |
| Push notifications, Sign in with Apple, Associated Domains, iCloud, App Groups for sharing, In-App Purchase, Apple Pay, HealthKit Estimate Recalibration, … | Not available |
| TestFlight, App Store, EAS internal distribution | Not available |

### What this means for PACE

| PACE needs | Available on a free account? | Notes |
|---|---|---|
| Native Swift GPS module (`pace-tracking`) | Yes | It is ordinary app code. It compiles with Xcode 26.6 in CI, and needs Xcode 26 or later (Swift tools 6.2). |
| Location: "While Using" and "Always" | Yes | Info.plist descriptions only; no capability needed |
| Background location (`UIBackgroundModes: location`) | Yes | Background Modes is supported for free accounts |
| SQLite, secure storage (Keychain), file picker, sharing | Yes | PACE uses none of the entitlement-gated options (no iCloud, no App Groups) |
| Sign-in links (`pace://auth/callback`) | Yes | A custom URL scheme; no Associated Domains needed |
| Push notifications | Not used by PACE | — |

**Audit of the current code** (2026-11-13):
- The Expo config plugins in use add no entitlements that a Personal Team cannot sign.
- `expo-document-picker` adds iCloud only when `ios.usesIcloudStorage` is set, and it is not set.
- `expo-sharing`'s App Group applies only to its share-extension plugin, which is not used.

The final proof is the entitlements file Expo generates on the Mac (`ios/PACEDev/PACEDev.entitlements`
or similar). It should hold no entries, or none from the "not available" row above.

## What you need

| Item | Detail |
|---|---|
| **Apple Account** | Free. Sign in to Xcode with it. |
| **A Mac** | Apple silicon recommended. **macOS Tahoe 26.2 or later** runs Xcode 26.6, the version CI validates. On macOS Sequoia 15.6 or later, Xcode 26.0–26.3 should work (they include Swift 6.2), but they are not validated. |
| **Xcode 26.x** | From the Mac App Store or developer.apple.com, including the iOS platform. Open it once to finish installing components. |
| **Node.js 24** (22.13 or later works) and Git | [nodejs.org](https://nodejs.org); Git comes with Xcode's command-line tools |
| **CocoaPods** | `brew install cocoapods` (Homebrew) or `sudo gem install cocoapods` |
| **iPhone 13** and a USB cable | iOS 16 or later. If the iPhone runs a newer iOS than your Xcode supports, Xcode asks for an update. A newer Xcode with Expo SDK 58 is not validated. |
| **Supabase project** (URL and *publishable* key) | Signing in is mandatory. Without it, PACE stops at "PACE is not configured". A free tier exists. |

## First build (on the Mac)

1. **Sign in to Xcode:** Xcode → Settings → Accounts → **+** → Apple Account. Xcode lists a
   **Personal Team** under your name.
2. **Prepare the iPhone:**
   - Connect it with the cable, unlock it and tap **Trust This Computer**.
   - Then on the iPhone: Settings → Privacy & Security → **Developer Mode** → On, and restart.
   - Apple notes the switch appears only after the iPhone has been paired with a Mac. If it is
     missing, open Xcode → Window → Devices and Simulators once with the iPhone connected.
3. **Get the code and install** (in Terminal):
   ```bash
   git clone https://github.com/AMOS-GUY/Pace.git
   ```
   ```bash
   cd Pace
   ```
   ```bash
   corepack enable
   ```
   ```bash
   pnpm install --frozen-lockfile
   ```
   ```bash
   pnpm build
   ```
4. **Supabase settings:**
   - Copy the `EXPO_PUBLIC_*` lines from `.env.example` into `apps/mobile/.env` and fill in your
     project URL and publishable key. Never use the service-role key.
   - In Supabase → Authentication → URL configuration, add `pace://**` to the redirect URLs.
5. **Build and install the development build** on the connected iPhone:
   ```bash
   cd apps/mobile && APP_VARIANT=development npx expo run:ios --device
   ```
   - Choose your iPhone when asked. Expo generates the iOS project (`apps/mobile/ios`, which is
     not committed), installs the CocoaPods dependencies, signs with your Personal Team, installs
     **PACE Dev** (`app.pace.ios.dev`) and starts Metro.
   - The first build takes a while (CI's builds take about 20–30 minutes on a cloud Mac).
6. **Trust the app on the iPhone** the first time: Settings → General → **VPN & Device
   Management** → your Apple Account under "Developer App" → **Trust**. Then open PACE Dev.

**If Expo cannot choose a signing team:**
1. Open the project in Xcode with `xed ios` (from `apps/mobile`).
2. Select the **PACEDev** target → **Signing & Capabilities**.
3. Tick **Automatically manage signing** and choose your **Personal Team**.
4. Press Run (⌘R) with the iPhone selected.

Do not change the bundle identifier there (see Troubleshooting).

## Using Metro on Windows (optional)

The development build needs native code from the Mac, but its JavaScript can come from your
Windows PC:
1. On Windows, check out **the same commit** that was built on the Mac. Native code and JavaScript
   must match.
2. Create the same `apps/mobile/.env`.
3. On Windows, in `apps/mobile`, run `pnpm start`. Allow Node.js through the Windows firewall on
   private networks when asked.
4. With the iPhone on the same Wi-Fi, open PACE Dev → **Enter URL manually** →
   `http://<your-PC's-IP>:8081`. Find the IP with `ipconfig` (IPv4 address).
5. If the networks differ or a firewall blocks it, use `pnpm start:tunnel`. Expo may offer to
   install `@expo/ngrok` the first time.

You can also run Metro on the Mac; `expo run:ios` starts it. JavaScript changes then reload
without a rebuild. A rebuild on the Mac is needed only after native changes: native packages,
`app.config.ts`, the Swift module.

## Every 7 days

The free provisioning profile expires 7 days after it was issued, and the app then stops opening.
To renew it:
1. Connect the iPhone to the Mac.
2. In the same checkout, run again:
   ```bash
   cd apps/mobile && APP_VARIANT=development npx expo run:ios --device
   ```

This re-signs and installs over the existing app. Installing over the app normally keeps its
data; **deleting the app deletes its data**, including recordings not yet exported. Export
(Settings → Export) before anything risky. Run without `--clean`, so the generated project is
reused and the build is faster.

## What to test first

1. The app opens on the welcome screen, not "PACE is not configured".
2. Sign up; the verification email opens the app (`pace://auth/callback`); sign in works.
3. **Location:** "While Using" first, then "Always" when you start recording.
4. **Short outdoor recording:** start, lock the screen for 2 minutes, unlock, finish. The route
   should have no gap while the screen was locked. This is the first real check of background GPS.
5. **Import:** a `.fit` file from the Files app, then a Garmin export ZIP.
6. **Export** and share the ZIP.

Write down the result of each step. TESTING.md ("Physical-device test plan") has the full list.

## Known limitations of the free route

- **Weekly re-signing, with the Mac:** every 7 days, and the Mac is needed each time.
- **Account limits:** at most 3 registered devices and 10 App IDs per 7 days, and at most 3 apps
  installed per device with free profiles.
- **No distribution:** no TestFlight and no installs for other people.
- **No cloud builds:** EAS Build cannot sign for a free account, so there is no EAS internal
  distribution.
- **Personal Team only:** capabilities that need a paid team are unavailable. PACE uses none of
  them today.

## Troubleshooting

| Problem | What to do |
|---|---|
| "Failed to register bundle identifier" / "The app identifier … is not available" | Someone else already uses `app.pace.ios.dev`. **Stop and report it.** Changing the bundle ID is a product decision. Do not change it in Xcode or `app.config.ts`. |
| "Untrusted Developer" when opening the app | Settings → General → VPN & Device Management → Trust (step 6) |
| No Developer Mode switch | Pair the iPhone with the Mac first (cable, Trust, Xcode → Devices and Simulators), then look again |
| "…maximum number of apps for free development profiles" | Delete another self-signed development app from the iPhone (3-app limit) |
| "Unable to … device support" / iOS version not supported | The iPhone's iOS is newer than your Xcode supports: update Xcode (this combination with Expo SDK 58 is not yet validated) |
| `swift-tools-version 6.2` / Swift compiler errors in `ExpoModulesJSI` | Xcode is older than 26; install Xcode 26.x |
| CocoaPods errors | `cd ios && pod install --repo-update`, then run the build command again |
| App shows "PACE is not configured" | `apps/mobile/.env` is missing or wrong on the machine running Metro; restart Metro after fixing it |
| The phone cannot reach Metro on Windows | Same Wi-Fi? Correct IP? Firewall prompt allowed? Otherwise use `pnpm start:tunnel` |
| The app stopped opening after a week | The 7-day profile expired; see "Every 7 days" |

## Without a Mac: options and their risks

None of these is set up or recommended without your decision:
- **Rent a cloud Mac:** works like a borrowed Mac, but it is a paid service.
- **Third-party signing tools on Windows** (for example AltStore or Sideloadly) can sign an app
  with a free Apple Account:
  - They need your Apple Account credentials entered into third-party software.
  - They need an unsigned device build (an `.ipa`), which PACE's CI does not produce today; it
    builds for the simulator only.
  - The same 7-day limit applies.
  - Not evaluated for PACE.
- **Apple Developer Program:** no Mac needed, using EAS Build
  ([IPHONE_DEVELOPMENT_BUILD.md](IPHONE_DEVELOPMENT_BUILD.md)).
