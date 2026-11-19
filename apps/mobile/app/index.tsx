import { Redirect } from 'expo-router';
import { Text } from '@/components/Text';
import { Card, Screen } from '@/components/layout';
import { entryHref } from '@/features/route-access';
import { useSession } from '@/stores/session';

/**
 * Entry gate: authentication is mandatory; onboarding follows the first sign-in. The root layout
 * guards every other route with the same policy (src/features/route-access.ts).
 */
export default function Index() {
  const { status, onboardingComplete } = useSession();
  const href = entryHref({ status, onboardingComplete });
  if (href) return <Redirect href={href} />;
  return status === 'unconfigured' ? <Unconfigured /> : null;
}

function Unconfigured() {
  return (
    <Screen>
      <Text variant="title" style={{ marginBottom: 12 }}>
        PACE is not configured
      </Text>
      <Card>
        <Text variant="body" color="secondary">
          This build is missing its authentication settings. Copy .env.example to .env in
          apps/mobile, set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, then
          rebuild. See README → Setup.
        </Text>
      </Card>
    </Screen>
  );
}
