import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Banner, Card, Screen, ToggleRow } from '@/components/layout';
import { useInvalidateAll } from '@/hooks/queries';
import { api, isApiConfigured } from '@/services/api';
import { signOut } from '@/services/auth';
import { getServices } from '@/services/container';
import { useTheme } from '@/theme/ThemeProvider';

const LOCAL_TABLES = [
  'route_points',
  'recording_events',
  'processed_routes',
  'laps',
  'activity_segments',
  'activity_splits',
  'sensor_samples',
  'record_candidates',
  'personal_records',
  'training_goals',
  'devices',
  'sync_outbox',
  'activities',
  'settings',
];

export default function AccountSettings() {
  const router = useRouter();
  const { spacing } = useTheme();
  const invalidate = useInvalidateAll();
  const [confirm, setConfirm] = useState('');
  const [wipeLocal, setWipeLocal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Server deletes the auth user, profile, synced activities and cloud backups.
      await api('/account', { method: 'DELETE' });
      if (wipeLocal) {
        const { ctx, coordinator } = await getServices();
        await coordinator.discard().catch(() => undefined);
        await ctx.db.transaction(async (tx) => {
          for (const t of LOCAL_TABLES) await tx.run(`DELETE FROM ${t}`);
        });
        await invalidate();
      }
      await signOut();
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (): void => {
    if (confirm.trim().toUpperCase() !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }
    Alert.alert(
      'Delete your PACE account?',
      'Your account, cloud data and cloud backups will be permanently deleted. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: () => void run() },
      ],
    );
  };

  return (
    <Screen edges={[]}>
      {error ? <Banner tone="error" message={error} /> : null}
      {!isApiConfigured() ? (
        <Banner
          tone="warning"
          message="Account deletion requires the PACE API, which is not configured in this build."
        />
      ) : null}
      <Card>
        <Text variant="body" style={{ marginBottom: spacing.md }}>
          Deleting your account permanently removes your login, profile, synchronised activities and
          all cloud backups from PACE servers.
        </Text>
        <Text variant="bodySmall" color="secondary">
          Consider exporting your data first (Profile → Export data or Backup & restore).
        </Text>
      </Card>
      <Card>
        <ToggleRow
          label="Also erase all data on this iPhone"
          value={wipeLocal}
          onValueChange={setWipeLocal}
          hint="If off, your activities stay on this phone after the account is deleted."
        />
      </Card>
      <Input
        label='Type "DELETE" to confirm'
        value={confirm}
        onChangeText={setConfirm}
        autoCapitalize="characters"
      />
      <Button
        label="Delete account"
        variant="danger"
        onPress={submit}
        loading={busy}
        disabled={!isApiConfigured()}
      />
    </Screen>
  );
}
