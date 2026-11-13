# Running PACE on your iPhone (development build)

This guide gets a development build of PACE onto a physical iPhone from a Windows PC. The iOS
build runs on Expo's macOS servers (EAS Build), and the JavaScript is served from your PC.

> **Status:** not yet done on a real device. CI builds and launches the app on an iOS
> *simulator* only. That does not prove the app installs on, or works on, an iPhone: location
> permissions, background GPS and the file picker are untested on a device.

## Why a development build (and not Expo Go)

PACE includes its own native Swift GPS module (`apps/mobile/modules/pace-tracking`), and Expo Go
cannot load custom native code. A development build is your own app containing that module plus
the Expo dev client. It loads the JavaScript from your PC while you develop.

## What you need

| Requirement | Why | Cost |
|---|---|---|
| **Apple Developer Program membership** | Installing on a physical iPhone from Windows needs ad hoc signing (a distribution certificate and an ad hoc provisioning profile containing your iPhone). A free Apple ID can only sign from Xcode on a Mac. | Paid yearly fee (see Apple's current pricing) |
| **Expo account** | EAS Build runs the macOS build | The free plan includes a limited number of builds; check Expo's current plan |
| **Supabase project** (URL and *publishable* key) | Signing in is mandatory, and without these settings the app stops at "PACE is not configured" | A free tier exists; check Supabase's current plan |
| iPhone 13 on iOS 16 or later, with Developer Mode | iOS refuses development and ad hoc apps without it | — |
| PC and iPhone on the same Wi-Fi, or a tunnel | The dev client loads JavaScript from your PC (Metro, port 8081) | — |

## One-time setup

All commands run from `apps/mobile` in the repository.

1. **Supabase settings for the dev server.**
   - Copy the `EXPO_PUBLIC_*` lines from `.env.example` into `apps/mobile/.env` and fill in your
     project URL and publishable key. Never use the service-role key.
   - In the Supabase dashboard (Authentication → URL configuration), add `pace://**` to the
     redirect URLs. Email verification and password reset links return to
     `pace://auth/callback` and `pace://auth/reset-password`.
2. **Link the project to your Expo account.** This adds the EAS project ID to the app config.
   Review and commit that change.
   ```bash
   npx --yes eas-cli@latest login
   npx --yes eas-cli@latest init
   ```
3. **Register your iPhone.** Open the link it prints on the iPhone and install the profile:
   ```bash
   pnpm eas:device
   ```
4. **Enable Developer Mode** on the iPhone: Settings → Privacy & Security → Developer Mode → On,
   then restart the phone.
5. **Build:**
   ```bash
   pnpm eas:build:dev
   ```
   - When asked, sign in with your Apple Developer account. EAS creates and stores the
     certificate and provisioning profile; they never enter the repository.
   - The build takes about 20–40 minutes on EAS and ends with an install link or QR code.
6. **Install** by opening that link on the iPhone. The app is called **PACE Dev** (bundle ID
   `app.pace.ios.dev`), so it can live next to a later production build.

## Every development session

1. On the PC, run `pnpm start`. If the phone cannot reach the PC (different networks, a
   firewall), use `pnpm start:tunnel` instead; Expo may offer to install `@expo/ngrok` the first
   time.
2. Open **PACE Dev** on the iPhone and choose the server it shows (or scan the QR code).
3. Rebuild with `pnpm eas:build:dev` only when native code, native dependencies or
   `app.config.ts` change. JavaScript changes reload directly.

On Windows, allow Node.js through the firewall for private networks the first time, or Metro on
port 8081 is unreachable.

## What to check on the phone (first session)

These are the items the development build lets us verify for the first time.

1. The app opens and shows the welcome screen, not "PACE is not configured".
2. Sign up, the verification email link opens the app, and sign-in works.
3. Location permission: "While Using" first, then "Always" when you start recording.
4. **Short outdoor recording:** start, lock the screen for 2 minutes, unlock, finish. The route
   should have no gap while the screen was locked.
5. **Import:** pick a `.fit` file from the Files app, then a Garmin export ZIP.
6. Export, and share the ZIP.

Write down what happens at each step. The full plan is in TESTING.md ("Physical-device test
plan").

## Known risks

- **Bundle ID:** `app.pace.ios.dev` (and `app.pace.ios`) must be free in Apple's developer
  portal. If Apple says the identifier is taken, the bundle ID has to change, and that is a
  product decision.
- **Deep links:** the development and production apps share the `pace://` scheme, so with both
  installed, iOS chooses which one opens a link.
- **Dependency versions:** `npx expo install --check` reports thirteen Expo packages one patch
  release behind SDK 58's expected versions. CI builds and launches with the current versions;
  update them in a separate change.
- **Untested build path:** EAS Build has not been run for this project yet. The configuration
  (Node 24.18.0, pnpm 12.18.0, the latest macOS/Xcode image, which the native code needs at
  Xcode 26 or later) is untested until the first build completes.
