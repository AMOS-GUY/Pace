import { Text } from '@/components/Text';
import { Card, Screen } from '@/components/layout';

/** Shown instead of every screen when the build has no authentication settings. */
export function Unconfigured() {
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
