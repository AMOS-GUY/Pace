import type { AuthStatus } from '@/stores/session';

/**
 * Who may open which part of the app. The root layout applies it with `Stack.Protected`, so a
 * route that is not allowed is never shown, however it was reached: a tap, a pace:// deep link
 * or navigation state restored at launch.
 *
 * Policy (app/index.tsx: "authentication is mandatory; onboarding follows the first sign-in"):
 * - A build without its authentication settings ('unconfigured') shows only the entry screen.
 * - Signed out: the sign-in screens and the email / password-reset link targets.
 * - Signed in: onboarding (also reused later to edit the profile and sports), and once it is
 *   complete, the rest of the app.
 * - An active recording keeps its screen in every configured state. Losing the session mid-run
 *   never takes the live recording off the screen; recording itself never depends on the session.
 */
export type RouteGuard = 'auth' | 'authLinks' | 'onboarding' | 'app' | 'recording';

export type RouteAccess = Readonly<Record<RouteGuard, boolean>>;

export interface AccessState {
  status: AuthStatus;
  onboardingComplete: boolean;
  recordingActive: boolean;
}

/**
 * Every route directly under app/ (except the entry screen, index) and the guard protecting it.
 * expo-router adds any route a layout does not declare without a guard, so a test checks this
 * table against the app/ directory.
 */
export const ROOT_ROUTE_GUARDS = {
  '(auth)': 'auth',
  'auth/callback': 'authLinks',
  'auth/reset-password': 'authLinks',
  '(onboarding)': 'onboarding',
  '(tabs)': 'app',
  'activity/[id]': 'app',
  settings: 'app',
  import: 'app',
  recording: 'recording',
} as const satisfies Record<string, RouteGuard>;

export type RootRoute = keyof typeof ROOT_ROUTE_GUARDS;

export function routeAccess({
  status,
  onboardingComplete,
  recordingActive,
}: AccessState): RouteAccess {
  const signedIn = status === 'signedIn';
  const configured = signedIn || status === 'signedOut';
  const app = signedIn && onboardingComplete;
  return {
    auth: status === 'signedOut',
    authLinks: configured,
    onboarding: signedIn,
    app,
    recording: app || (configured && recordingActive),
  };
}

/** Where the entry screen sends this state; null means stay on it (loading or unconfigured). */
export function entryHref({
  status,
  onboardingComplete,
}: Pick<AccessState, 'status' | 'onboardingComplete'>):
  '/(auth)/welcome' | '/(onboarding)/profile' | '/(tabs)' | null {
  if (status === 'signedOut') return '/(auth)/welcome';
  if (status !== 'signedIn') return null;
  return onboardingComplete ? '/(tabs)' : '/(onboarding)/profile';
}

/** A recording is in progress (same rule as the Record tab's "A recording is in progress"). */
export function isRecordingActive(status: string | undefined): boolean {
  return status !== undefined && status !== 'READY' && status !== 'SAVED';
}
