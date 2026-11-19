import { Redirect } from 'expo-router';
import { Unconfigured } from '@/components/Unconfigured';
import { entryHref } from '@/features/route-access';
import { useSession } from '@/stores/session';

/**
 * Entry gate: authentication is mandatory; onboarding follows the first sign-in. Every other
 * route checks the same policy itself with <Guard> (src/features/route-access.ts).
 */
export default function Index() {
  const { status, onboardingComplete } = useSession();
  const href = entryHref({ status, onboardingComplete });
  if (href) return <Redirect href={href} />;
  return status === 'unconfigured' ? <Unconfigured /> : null;
}
