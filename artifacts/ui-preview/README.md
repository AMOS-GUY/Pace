# PACE UI preview

These are screenshots of the real PACE app as it is on this branch. They are not mock-ups or a
redesign. `.github/workflows/ui-preview.yml` makes a Release build for the iOS simulator and
installs it on a simulated iPhone 17 (iOS 26.5). Maestro then walks through the app
(`apps/mobile/maestro/ui-preview/ui-preview.yaml`) and saves a screenshot of each screen. The app
code is unchanged.

The images are not committed to `main`. Each run publishes them, with `contact-sheet.png`, to its
own branch `ui-preview-run-<run id>`, and also uploads them as the `ui-preview` CI artifact.

## How the walk gets around

- **No sign-in settings.** The CI build has no Supabase settings, so the app opens on "PACE is not
  configured".
- **Deep links.** The walk opens the sign-in and onboarding screens through the app's own `pace://`
  links and confirms iOS's "Open in PACE?" prompt each time.
- **Reaching the tabs.** Finishing onboarding opens the tabs. This works without signing in
  because the tab and onboarding guards only redirect when the status is `signedOut`, and an
  unconfigured build reports `unconfigured`.
- **No mock data.** The one activity is a real recording made by the app. Maestro moves the
  simulated GPS about 0.5 km along a made-up path (Zurich, at 6 m/s), and the app records, saves
  and analyses it as usual.

## Screens

| #   | Screen                                                     | State in this build                                                                                                        |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 01  | "PACE is not configured"                                   | Expected when the Supabase settings are missing.                                                                           |
| 02  | Welcome                                                    | Layout complete.                                                                                                           |
| 03  | Create your account                                        | Form shown. Submitting needs Supabase (blocked).                                                                           |
| 04  | Sign in                                                    | Form shown. Signing in needs Supabase (blocked).                                                                           |
| 05  | Reset password                                             | Form shown. Sending the link needs Supabase (blocked).                                                                     |
| 05b | Choose a new password (opened from a link) | Shows "This reset link is incomplete" when opened without a recovery session. |
| 05c | Onboarding step 1, set up your profile | Works. Display name, height and weight, all optional. |
| 06  | Onboarding step 2, sports                                  | Works.                                                                                                                     |
| 07  | Onboarding step 2, Run selected                            | Works.                                                                                                                     |
| 08  | Onboarding step 3, units                                   | Works.                                                                                                                     |
| 09  | Onboarding step 4, location access                         | Works ("Not now" was used).                                                                                                |
| 10  | Home, no activities                                        | Works. Quick start buttons and a first-activity checklist.                                                                 |
| 11  | Activities, empty                                          | Works. Search and filters shown.                                                                                           |
| 12  | Progress, empty                                            | Works. "Nothing to analyse yet".                                                                                           |
| 13  | Profile                                                    | Works.                                                                                                                     |
| 14  | Profile, scrolled                                          | Shows Plan "PACE Free — all core features", Sign out and Delete account. Apple Health is marked "Future release".          |
| 15  | Record                                                     | Works. Sport picker and Start Run.                                                                                         |
| 16  | New Run                                                    | Works. Auto-pause switch and Find GPS.                                                                                     |
| 17  | Getting ready                                              | Works. "GPS ready, accuracy ±5 m" from the simulated location.                                                             |
| 18  | Recording                                                  | Works. Live time, distance, pace, average pace, climb and lap.                                                             |
| 19  | Paused                                                     | Works. Resume, Finish and Discard.                                                                                         |
| 20a | "Finish activity?" dialog                                  | Works.                                                                                                                     |
| 20  | Activity saved                                             | Works. 0.50 km.                                                                                                            |
| 21  | Activity detail                                            | Works. The route is drawn without a map ("Map tiles not configured"). Shows totals and "1 personal record in this activity". |
| 22  | Activity detail, splits and details                        | Works.                                                                                                                     |
| 23  | Activity detail, GPS route and Manage                      | Works. Edit, Export GPX and Delete.                                                                                        |
| 24  | Home with one activity | Works. "This week 0.50 km", per-sport totals, week dots, latest activity, weekly-distance chart. |
| 24b | Home with one activity, scrolled | Works. Latest activity and the Training chart ("Active in 1 of the last 8 weeks"). |
| 25  | Activities with one activity | Works. "Morning Run" listed under November 2026. A loading spinner is still showing above the list. |
| 26  | Progress with one activity | Works. Weekly distance chart and all-time totals. |
| 26b | Progress, scrolled | Works. By sport, personal records ("Run · Longest run 0.50 km"), highlights. |
| 27  | Import activities                                          | The screen works. The iOS file picker was not opened.                                                                      |
| 28  | Settings: Units                                            | Works.                                                                                                                     |
| 29  | Settings: Training goals                                   | Works. "No goals yet" and the new-goal form.                                                                               |
| 30  | Settings: Privacy                                          | Works. Export privacy zone setting.                                                                                        |
| 31  | Settings: Connected devices                                | Every sensor is marked "Future release" (not built yet).                                                                   |
| 32  | Settings: Export data                                      | The screen works. No export was created.                                                                                   |
| 33  | Settings: Backup & restore                                 | The backup file part works. PACE Cloud reads "not configured in this build" (no `EXPO_PUBLIC_API_URL`).                    |
| 34  | Settings: Delete account                                   | Disabled: "requires the PACE API, which is not configured in this build".                                                  |

The settings screens were opened one after another by deep link, so each back button names the
screen opened before it. That comes from the walk, not from the app.

## Blocked or not shown

- **Account features need Supabase or the PACE API.** Real sign-up and sign-in, email
  verification, password reset, cloud backup and account deletion. This build has no Supabase or
  API settings, and no credentials were used.
- **Map.** The route is drawn on a plain background because map tiles are not configured.
- **Sensors and Apple Health.** Shown as "Future release".
- **System sheets.** The iOS file picker (import, restore) and share sheet (export, GPX) were not
  opened.
- **Physical iPhone.** Not tested. These are simulator screenshots only.

## Things noticed in the screenshots

- **"(tabs)" back button.** The back button on Activity detail reads "(tabs)", which is the route
  group's name.
- **Overlapping text.** On Connected devices, "Bluetooth heart-rate monitor" runs into its "Future
  release" label.
- **Spinner stays up.** Activities still shows a loading spinner above a list that has already
  loaded (screenshot 25).
- **Cut-off chart labels.** The Progress chart's x-axis labels are cut off ("2… 31… 07…").
- **Tabs reachable while unconfigured.** An unconfigured build reaches the tabs through the
  onboarding deep link (see above). It needs a build without its sign-in settings, so it is not a
  problem in a properly configured build.
