import { useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { Text } from '@/components/Text';
import { Card, ListRow, Screen, SectionHeader } from '@/components/layout';
import { sportLabel } from '@/features/display';
import { signOut } from '@/services/auth';
import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme/ThemeProvider';

export default function Profile() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { profile, prefs } = usePreferences();
  const email = useSession((s) => s.session?.user.email);

  const confirmSignOut = (): void => {
    Alert.alert(
      'Sign out?',
      'Your activities stay on this iPhone. You can sign back in at any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () =>
            void signOut().catch((e: unknown) => Alert.alert('Sign out failed', String(e))),
        },
      ],
    );
  };

  return (
    <Screen>
      <Text variant="title" accessibilityRole="header">
        {profile?.displayName ?? 'Profile'}
      </Text>
      <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.lg }}>
        {email ?? ''}
      </Text>
      <Card>
        <ListRow
          icon="person-outline"
          label="Edit profile"
          onPress={() => router.push({ pathname: '/(onboarding)/profile', params: { edit: '1' } })}
        />
        <ListRow
          icon="speedometer-outline"
          label="Units"
          value={prefs.measurementSystem === 'metric' ? 'Metric' : 'Imperial'}
          onPress={() => router.push('/settings/units')}
        />
        <ListRow
          icon="flag-outline"
          label="Training goals"
          onPress={() => router.push('/settings/goals')}
        />
        <ListRow
          icon="heart-outline"
          label="Preferred sports"
          value={profile?.preferredSports.map(sportLabel).join(', ') || 'None'}
          onPress={() => router.push({ pathname: '/(onboarding)/sports', params: { edit: '1' } })}
        />
      </Card>

      <SectionHeader title="Data" />
      <Card>
        <ListRow
          icon="cloud-upload-outline"
          label="Backup & restore"
          onPress={() => router.push('/settings/backup')}
        />
        <ListRow
          icon="download-outline"
          label="Export data"
          onPress={() => router.push('/settings/export')}
        />
        <ListRow
          icon="shield-checkmark-outline"
          label="Privacy"
          onPress={() => router.push('/settings/privacy')}
        />
      </Card>

      <SectionHeader title="Devices & health" />
      <Card>
        <ListRow
          icon="bluetooth-outline"
          label="Connected devices"
          onPress={() => router.push('/settings/devices')}
        />
        <ListRow icon="fitness-outline" label="Apple Health" value="Future release" disabled />
      </Card>

      <SectionHeader title="Account" />
      <Card>
        <ListRow icon="ribbon-outline" label="Plan" value="PACE Free — all core features" />
        <ListRow icon="log-out-outline" label="Sign out" onPress={confirmSignOut} />
        <ListRow
          icon="trash-outline"
          label="Delete account"
          destructive
          onPress={() => router.push('/settings/account')}
        />
      </Card>
    </Screen>
  );
}
