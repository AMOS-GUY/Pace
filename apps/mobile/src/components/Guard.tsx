import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import {
  type RouteGuard,
  entryHref,
  isRecordingActive,
  routeAccess,
} from '@/features/route-access';
import { useRecording } from '@/stores/recording';
import { useSession } from '@/stores/session';
import { Unconfigured } from './Unconfigured';

/**
 * Renders a protected route only when the policy allows it (src/features/route-access.ts).
 * Every route under app/ except the entry screen renders through one of these (a test checks),
 * so a route opened by a tap, a pace:// link or restored navigation state is checked the same
 * way. The children are not rendered at all when the route is not allowed, so they never load
 * data first.
 *
 * A denied route redirects straight to where the state belongs (Welcome, onboarding or the
 * tabs), never to "/": app/index.tsx and app/(tabs)/index.tsx share that path, so a redirect
 * to "/" can land on the Home tab and, signed out, loop between the tabs and this guard.
 */
export function Guard({ guard, children }: { guard: RouteGuard; children: ReactNode }) {
  const status = useSession((s) => s.status);
  const onboardingComplete = useSession((s) => s.onboardingComplete);
  const recordingActive = useRecording((s) => isRecordingActive(s.snapshot?.state.status));
  if (routeAccess({ status, onboardingComplete, recordingActive })[guard]) return <>{children}</>;
  if (status === 'loading') return null;
  const href = entryHref({ status, onboardingComplete });
  return href ? <Redirect href={href} /> : <Unconfigured />;
}
