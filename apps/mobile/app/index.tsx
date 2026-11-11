import { Redirect } from 'expo-router';
import { Text } from '@/components/Text';
import { Card, Screen } from '@/components/layout';
import { useSession } from '@/stores/session';

/** Entry gate: authentication is mandatory; onboarding follows the first sign-in. */
export default function Index() {
  const { status, onboardingComplete } = useSession();
  if (status === 'loading') return null;
  if (status === 'unconfigured') return <Unconfigured />;
  if (status === 'signedOut') return <Redirect href="/(auth)/welcome" />;
  if (!onboardingComplete) return <Redirect href="/(onboarding)/profile" />;
  return <Redirect href="/(tabs)" />;
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
