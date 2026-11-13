# Testing PACE on your iPhone with a free Apple Account

This route uses a borrowed Mac (for example a friend's) as a temporary build machine, **your own** free
Apple Account, and Xcode's **Personal Team** signing. It installs the PACE development build,
including the native Swift GPS module and the Expo dev client, on your iPhone 13.

> **Status:** prepared, **not yet done**. Nothing in this guide has been run on a physical device.
> CI builds and launches the app on an iOS *simulator* only. That proves neither installation on
> an iPhone nor that location permissions or background GPS work there. Every test in the
> checklist below is **NOT RUN** until you perform it.

**This route costs nothing.** It needs no paid Apple Developer Program membership, no EAS build,
and no rented cloud Mac, only a borrowed Mac, your free Apple Account and your iPhone. It is
the primary workflow.

A paid route (EAS Build) is described in [IPHONE_DEVELOPMENT_BUILD.md](IPHONE_DEVELOPMENT_BUILD.md)
for later. It is **not** a prerequisite for anything here.

## 1. Can this work with a free account?

**Yes, as far as the documentation and the code show.**

**Apple's free-account limits** ([developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account),
[supported capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios)):

| | Free Personal Team |
|---|---|
| App IDs | up to 10, each expiring after 7 days |
| Devices | up to 3, each expiring after 7 days |
| Apps per device | up to 3 |
| Provisioning profiles | expire after **7 days**, then rebuild and reinstall |
| Background Modes | **supported** |
| Not available | push notifications, Sign in with Apple, Associated Domains, iCloud, In-App Purchase, Apple Pay, TestFlight and others |

**What PACE needs, checked against its code on 2026-11-13:**

| PACE needs | Free account? | Evidence |
|---|---|---|
| Bundle ID `app.pace.ios.dev` (development variant) | Yes, if no one else has registered it | Xcode registers it for your Personal Team on the first build |
| Native Swift GPS module (`pace-tracking`) | Yes | Ordinary app code. CI compiles it with Xcode 26.6. |
| Location "While Using" and "Always" | Yes | Only the Info.plist texts in `app.config.ts`; no capability needed |
| Background location | Yes | `UIBackgroundModes: location`. Apple supports Background Modes for free accounts. |
| Expo dev client, SQLite, Keychain (secure storage), file picker, sharing | Yes | None of the config plugins adds a paid-only entitlement (see below) |
| Sign-in links (`pace://auth/callback`) | Yes | A custom URL scheme, not Associated Domains |
| Push notifications | Not used | `expo-notifications` is not installed |

**Entitlements audit:**
- `expo-document-picker` adds iCloud entitlements only when `ios.usesIcloudStorage` is set, and it
  is not set.
- `expo-sharing` adds an App Group only through its share-extension plugin, which is not used.
- No other plugin in use touches entitlements.
- The definitive check is the generated `ios/PACEDev/PACEDev.entitlements` on the Mac (step 6).

**Nothing is removed or changed to make signing work.** If Xcode reports a capability problem,
stop and report it (see Troubleshooting).

## 2. What the Mac and iPhone need

The minimums below come from the project's own dependencies.

| Item | Requirement | Where it comes from |
|---|---|---|
| **Xcode** | **26.0 or later**; **26.6 recommended** (validated in CI) | `expo-modules-jsi` declares `swift-tools-version: 6.2`, which only Xcode 26's Swift 6.2 or later can build |
| **macOS** | **Tahoe 26.2 or later** for Xcode 26.4.1–26.6. Sequoia 15.6 or later runs Xcode 26.0–26.3 (not validated). | [Xcode system requirements](https://developer.apple.com/xcode/system-requirements/) |
| **Mac model** | One that runs the macOS version above. An older Mac that cannot run Sequoia 15.6 **cannot build PACE**. | — |
| **Disk space** | **At least 50 GB free** (estimate: Xcode about 15–20 GB installed, plus the iOS platform, project dependencies, CocoaPods and build data) | Estimate, not measured on a Mac |
| **Node.js** | **22.13+ or 24.3+** (24 recommended, as in CI) | `react-native` 0.88.1 and `expo` 58 `engines` |
| **pnpm** | **12.18.0**, through Corepack | `packageManager` in the root `package.json` |
| **CocoaPods** | A current release (1.16 or later recommended; the only explicit reference is ≥ 1.13) | `expo-modules-autolinking` |
| **iPhone 13** | **iOS 16.4 or later** | Deployment target 16.4 (`expo-build-properties`, `ExpoModulesCore`) |
| **iOS vs Xcode** | Xcode must support the iPhone's iOS version | If the iPhone runs an iOS newer than Xcode 26.6 supports, Xcode needs an update, and **that combination with Expo SDK 58 is not validated** |
| **Connection** | **USB cable** (iPhone 13: Lightning to USB-C or USB-A, to match the Mac) for first pairing and installs. Wi-Fi debugging is possible after pairing. | — |
| **Network** | Mac and iPhone on the **same Wi-Fi** for Metro | — |
| **Supabase project** | Project URL and **publishable** key. Signing in is mandatory, or PACE stops at "PACE is not configured". | `apps/mobile/src/config/env.ts` |

**Check the Mac before starting** (Terminal):
```bash
sw_vers -productVersion
```
```bash
df -h ~
```
After Xcode is installed:
```bash
xcodebuild -version && xcrun swift --version
```
Swift must report **6.2 or later**.

## 3. Accounts, passwords and the borrowed Mac

- **Sign with your own Apple Account only.**
  - In Xcode you sign in with **your** Apple Account, and the app is signed by **your** Personal
    Team.
  - **Never use the Mac owner's Apple Account or team for signing**, even if Xcode offers it
    because they are already signed in. Their account would then own the App ID and the 7-day
    profile, and renewals would depend on them.
  - **Never share your Apple password** with the Mac's owner, with Claude or with anyone. Type
    it into Xcode yourself, and approve the two-factor prompt on your own device.
- **Recommended, if possible: a separate macOS user for you.**
  - The Mac's owner creates it (System Settings → Users & Groups → Add User; a standard account is
    enough).
  - Your Apple Account, signing certificate and the project then stay out of his account, and
    cleanup is "delete that user".
  - The Mac's owner, as an admin, installs the shared tools once: Xcode, Homebrew, Node.js and CocoaPods
    (step 4.1).
- **Nothing goes into Git:**
  - No certificates, provisioning profiles, keys or `.env` files are ever committed. `ios/` and
    `.env` are git-ignored.
  - The Supabase key in `.env` is the public *publishable* key. Never put the service-role key
    there.

## 4. On the Mac: step by step

### 4.1 One-time tools (the Mac's owner, as admin)

1. **Xcode:** install from the Mac App Store, open it once and let it install its components.
   Choose the iOS platform when asked; a physical device does not need simulator runtimes.
2. **Command-line tools:**
   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   ```
   ```bash
   sudo xcodebuild -license accept
   ```
3. **Homebrew** (see [brew.sh](https://brew.sh)), then Node.js 24 and CocoaPods:
   ```bash
   brew install node@24 cocoapods
   ```
   Follow brew's note to put `node@24` on the PATH, then check:
   ```bash
   node --version && pod --version
   ```

### 4.2 Your Apple Account in Xcode (you, personally)

1. Xcode → Settings → **Accounts** → **+** → Apple Account.
2. Sign in with **your own** Apple Account, and confirm with two-factor authentication on your own
   device.
3. Xcode then lists **"<Your Name> (Personal Team)"**.

If you use the Mac owner's macOS user and their Apple Account is already listed, leave it alone:
add yours, and sign only with yours (step 4.7).

### 4.3 Get the code: the `feature/ios-development-build` branch (you, in your macOS user)

Build the branch that contains this workflow, **not** the default `main` branch:

```bash
git clone https://github.com/AMOS-GUY/Pace.git
```
```bash
cd Pace
```
```bash
git fetch origin
```
```bash
git checkout feature/ios-development-build
```
```bash
git pull origin feature/ios-development-build
```

**Verify the commit before building.** This prints the commit you have, then the latest commit on
GitHub:

```bash
git rev-parse HEAD && git ls-remote origin refs/heads/feature/ios-development-build
```

- The two SHAs must be identical, and `git status` must say "up to date" with nothing modified.
- Write down the short SHA (`git rev-parse --short HEAD`): you need it for the test results, and
  to run the same commit on Windows later.
- Once this branch is merged into `main`, build `main` instead. Its commit should then contain
  this guide.

**Install the dependencies** (the frozen lockfile, exactly as CI):

```bash
corepack enable
```
```bash
pnpm install --frozen-lockfile
```
```bash
pnpm build
```

If `corepack enable` fails with a permissions error, run `npm install -g corepack@latest` first,
or ask the Mac's owner to run `corepack enable` once as admin.

**Confirm the development configuration** that the build will use:

```bash
cd apps/mobile && APP_VARIANT=development npx expo config --type public --json | node -e "const c=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(c.name,c.ios.bundleIdentifier,c.ios.infoPlist.UIBackgroundModes)"; cd ../..
```

It must print exactly:

```
PACE Dev app.pace.ios.dev [ 'location' ]
```

Then check that the native GPS module and the development scripts are present:

```bash
ls apps/mobile/modules/pace-tracking/ios/PaceTrackingModule.swift && grep -E '"(start|start:tunnel)"' apps/mobile/package.json
```

It must list the Swift file and the `start` and `start:tunnel` scripts. If anything differs, stop
and report it; don't edit the configuration to make it match.

### 4.4 Supabase settings

1. Create `apps/mobile/.env` with the two mobile lines from `.env.example`, filled in:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your publishable key>
   ```
2. In Supabase → Authentication → URL configuration, add **`pace://**`** to the redirect URLs.

### 4.5 Connect and prepare the iPhone

1. Connect the iPhone with the cable, unlock it and tap **Trust This Computer**.
2. Open Xcode → Window → **Devices and Simulators** and wait until the iPhone appears and is
   prepared.
3. On the iPhone: Settings → Privacy & Security → **Developer Mode** → On, then restart. Apple
   shows the switch only after the iPhone has been paired with a Mac.

### 4.6 Generate the iOS project

From the `Pace` folder:
```bash
cd apps/mobile && APP_VARIANT=development npx expo prebuild --platform ios
```

- **`APP_VARIANT=development` is required.** It produces the development variant: app **PACE
  Dev**, bundle ID **`app.pace.ios.dev`**, Xcode project **`PACEDev`**.
- **What it does:** generates `apps/mobile/ios` (git-ignored) from `app.config.ts` and runs
  `pod install`.
- **If it was ever run without the variant,** add `--clean` to regenerate.
- **Check the entitlements** with `cat ios/PACEDev/PACEDev.entitlements`. It should contain no
  push, iCloud, App Groups or Associated Domains entries. If it does, stop and report.

### 4.7 Sign with your Personal Team and install

1. Open the workspace (not the `.xcodeproj`):
   ```bash
   xed ios/PACEDev.xcworkspace
   ```
2. In Xcode, select the **PACEDev** project → target **PACEDev** → **Signing & Capabilities**:
   - tick **Automatically manage signing**;
   - **Team:** choose **"<Your Name> (Personal Team)"**, the team of **your** Apple Account.
     If the Mac owner's team also appears, don't choose it;
   - leave the **Bundle Identifier** as `app.pace.ios.dev`. **Do not change it.**
   - **Background Modes → Location updates** should already be listed; leave it.
3. At the top, choose your **iPhone** as the run destination and the **Debug** configuration
   (the default), then press **Run** (⌘R). The first build takes a while (CI's take about 20–30
   minutes).
4. If macOS asks whether `codesign` may use a key in your keychain, enter your macOS user's
   password and choose **Always Allow**.
5. The first time, the iPhone refuses to open the app ("Untrusted Developer"). On the iPhone:
   Settings → General → **VPN & Device Management** → under "Developer App" your Apple Account →
   **Trust**.

**Shortcut** for later rebuilds: the same build, signing and install in one command (it uses
the team selected in Xcode):
```bash
APP_VARIANT=development npx expo run:ios --device
```

### 4.8 Start Metro and connect

PACE Dev contains the native code; the JavaScript comes from Metro. **For the first test, run
Metro on the Mac.** It is the simplest and most reliable option.

```bash
cd apps/mobile && APP_VARIANT=development pnpm start
```

- The first time, iOS asks whether **PACE Dev may find devices on your local network**: tap
  **Allow**. The dev client needs it to find Metro.
- With the iPhone on the **same Wi-Fi** as the Mac, open PACE Dev. It lists the Mac's server;
  tap it, or choose **Enter URL manually** → `http://<Mac's IP>:8081`. Find the Mac's IP in
  System Settings → Wi-Fi → Details.
- Set `APP_VARIANT=development` for Metro too, so the development server serves the same app
  configuration that was built.
- Guest or office Wi-Fi often blocks devices from seeing each other. In that case use
  `APP_VARIANT=development pnpm start:tunnel`. Expo may offer to install `@expo/ngrok` the first
  time.

## 5. Running Metro on your Windows PC instead (later)

**Yes, Windows can host Metro**, because the development build only fetches JavaScript from it.
It is optional and best tried after the first successful test on the Mac.

**Requirements:**
1. **The same commit** checked out on Windows as was built on the Mac. Native code and JavaScript
   must match.
2. The same `apps/mobile/.env`.
3. **The same Wi-Fi** for the PC and the iPhone. The Mac is not needed for this.
4. Windows firewall: allow Node.js on private networks when prompted (port 8081).

**On Windows**, in `apps/mobile`, set the variant in PowerShell first:
```powershell
$env:APP_VARIANT = 'development'
```
Then start Metro:
```powershell
pnpm start
```
On the iPhone, open PACE Dev → **Enter URL manually** → `http://<PC's IPv4 address>:8081` (from
`ipconfig`). If the network blocks it, use `pnpm start:tunnel`.

## 6. Every 7 days: renewal

The free provisioning profile **expires 7 days after it was issued**, and PACE Dev then stops
opening. Renewal needs the Mac:
1. Sign in to your macOS user on the Mac and connect the iPhone.
2. In `Pace/apps/mobile`, at the same commit, run:
   ```bash
   APP_VARIANT=development npx expo run:ios --device
   ```
   Or press Run in Xcode.

To renew **and** pick up new work, first update the branch:
1. Run `git pull origin feature/ios-development-build`.
2. Repeat the commit check from 4.3.
3. Run `pnpm install --frozen-lockfile && pnpm build`.

Then run the build command above. Either way, this re-signs and installs **over** the existing app, which normally keeps its data. **Deleting
PACE Dev deletes its data**, including recordings not yet exported, so export first (Settings →
Export).

## 7. Physical-device test checklist

Record the result of each test, the date, the iOS version and the PACE commit. Every row stays
**NOT RUN** until performed.

| # | Test | How | Expected | Result |
|---|---|---|---|---|
| 1 | Installation and launch | Install (4.7), trust, open | Welcome screen, no crash | NOT RUN |
| 2 | Configuration | Open with Metro connected | No "PACE is not configured" | NOT RUN |
| 3 | Sign-up | Create an account | Verification email arrives | NOT RUN |
| 4 | Email link | Tap the link on the iPhone | PACE Dev opens and the account is verified | NOT RUN |
| 5 | Sign-in and onboarding | Sign in, complete onboarding | Reaches the Home tab | NOT RUN |
| 6 | Location permission | Grant "While Using" | System prompt shows PACE's text | NOT RUN |
| 7 | "Always" permission | Start a recording | "Always" prompt appears; choose it | NOT RUN |
| 8 | Start recording | Outdoors, start a run | GPS status settles and the timer starts | NOT RUN |
| 9 | GPS samples | Walk or run 5 minutes | Route is drawn and distance increases | NOT RUN |
| 10 | Distance and elapsed time | Compare with a known distance or a watch | Distance plausible; elapsed time matches a clock | NOT RUN |
| 11 | Pause and resume | Pause 1 minute, resume | Moving time excludes the pause; route continues | NOT RUN |
| 12 | Stop and save | Finish and save | Activity appears in Activities with route and metrics | NOT RUN |
| 13 | Restart and persistence | Force-quit PACE Dev, reopen | Saved activity still there, unchanged | NOT RUN |
| 14 | Lock screen and background | Record, lock the screen 5–10 minutes, unlock | Blue location indicator while locked; **no gap in the route** | NOT RUN |
| 15 | App in background | Record, switch to another app for 5 minutes | Recording continues; no gap | NOT RUN |
| 16 | GPS interruption and recovery | Walk into a building or under a bridge for a minute | Gap or low-accuracy period handled; route recovers outside; no jump | NOT RUN |
| 17 | Termination during recording | Record, then force-quit PACE Dev | On reopening, the recording is recovered (interrupted) and nothing captured is lost | NOT RUN |
| 18 | Battery drain | 30-minute recording, note battery % before and after | Record % per hour | NOT RUN |
| 19 | Heating | During test 18 | Note whether the iPhone becomes noticeably warm | NOT RUN |
| 20 | FIT import | Files app → a `.fit` file | Imports, or is refused with a clear reason | NOT RUN |
| 21 | Export | Settings → Export, share the ZIP | ZIP is created and shareable | NOT RUN |

TESTING.md ("Physical-device test plan") has the longer recording plan.

## 8. After testing: cleanup

**On the iPhone:**
- **Remove the app:** touch and hold PACE Dev → Remove App → **Delete App**. This deletes its data;
  export first if you need it.
- **Optional:** turn off Developer Mode (Settings → Privacy & Security).

**On the borrowed Mac:**
- **If you used a separate macOS user:** the Mac's owner deletes that user (System Settings → Users &
  Groups). That removes your Apple Account sign-in, keychain, certificates, profiles and the
  project.
- **If you used the Mac owner's own macOS user:**
  1. Xcode → Settings → Accounts → select your Apple Account → **−**.
  2. Keychain Access → login keychain → **My Certificates** → delete **"Apple Development:
     <you>"**, including its private key.
  3. Delete the provisioning profiles:
     ```bash
     rm -rf ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles ~/Library/MobileDevice/Provisioning\ Profiles
     ```
  4. Delete the project folder, including `apps/mobile/.env`, and its build data:
     ```bash
     rm -rf ~/Library/Developer/Xcode/DerivedData/PACEDev-*
     ```
  5. **Optional:** Xcode → Devices and Simulators → right-click your iPhone → **Unpair Device**.

## 9. Known limitations of the free route

- **Weekly renewal, with the Mac:** the app must be re-signed every 7 days.
- **Account limits:** at most 3 devices and 10 App IDs per 7 days, and at most 3 free-signed apps
  per device.
- **No distribution:** no TestFlight, no installs for other people, no EAS cloud builds.
- **Mac-only native rebuilds:** native changes (native packages, `app.config.ts`, the Swift
  module) need a rebuild on the Mac. JavaScript changes only need Metro.
- **Development build only:** this is not a Release build. Performance and battery figures can
  differ from a store build.

## 10. Troubleshooting

| Problem | What to do |
|---|---|
| "Failed to register bundle identifier" / "…is not available" | Someone else uses `app.pace.ios.dev`. **Stop and report it.** The bundle ID is a product decision. Don't change it in Xcode or `app.config.ts`. |
| Xcode reports a capability or entitlement your team can't use | **Stop and report it** with the exact message. Don't remove the capability. |
| `swift-tools-version 6.2` errors / Swift build errors in `ExpoModulesJSI` | Xcode is older than 26: install Xcode 26.x and run `sudo xcode-select -s /Applications/Xcode.app` |
| iOS version not supported by Xcode | The iPhone's iOS is newer than Xcode: update Xcode (this combination with SDK 58 is not yet validated) and report it |
| `pod install` errors | `cd ios && pod install --repo-update`, then build again |
| "Untrusted Developer" | Settings → General → VPN & Device Management → Trust |
| No Developer Mode switch | Pair first (4.5), then look again |
| "…maximum number of apps for free development profiles" | Delete another free-signed app from the iPhone |
| `codesign` keychain prompt keeps returning | Enter the password of the macOS user you're logged into and choose **Always Allow** |
| App shows "PACE is not configured" | `apps/mobile/.env` is missing or wrong on the machine running Metro; fix it and restart Metro |
| Dev client lists no server | Settings → Privacy & Security → **Local Network** → allow PACE Dev; or enter the URL manually |
| App can't find Metro | Same Wi-Fi? Correct IP? Firewall? Otherwise use the tunnel (`pnpm start:tunnel`) |
| App stopped opening after a week | The 7-day profile expired: renew (section 6) |
| Wrong app name or bundle ID (`PACE` / `app.pace.ios`) | Prebuild ran without `APP_VARIANT=development`; run `APP_VARIANT=development npx expo prebuild --platform ios --clean` |
