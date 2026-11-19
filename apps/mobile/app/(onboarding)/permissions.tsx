import { useRouter } from 'expo-router';
import { isTrackingAvailable } from 'pace-tracking';
import { useState } from 'react';
import { Linking } from 'react-native';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Banner, Card, Screen } from '@/components/layout';
import { api, isApiConfigured } from '@/services/api';
import { getServices } from '@/services/container';
import { reportError } from '@/services/monitoring';
import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';

export default function OnboardingPermissions() {
  const router = useRouter();
  const completeOnboarding = useSession((s) => s.completeOnboarding);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (): Promise<void> => {
    setBusy(true);
    try {
      const { bridge } = await getServices();
      setStatus(await bridge.requestAuthorization('when_in_use'));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (): Promise<void> => {
    await completeOnboarding();
    // Best effort: the cloud profile is optional and never blocks using the app offline.
    const { profile, prefs } = usePreferences.getState();
    if (isApiConfigured() && profile) {
      void api('/auth/profile', {
        method: 'POST',
        body: {
          displayName: profile.displayName,
          measurementSystem: prefs.measurementSystem,
          preferredSports: profile.preferredSports,
        },
      }).catch((e: unknown) => reportError(e, { area: 'profile' }));
    }
    router.replace('/(tabs)');
  };

  const denied = status === 'denied' || status === 'restricted';
  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 96 }}>
      <Text variant="label" color="accent">
        STEP 4 OF 4
      </Text>
      <Text variant="title" accessibilityRole="header" style={{ marginVertical: 12 }}>
        Location access
      </Text>
      <Card>
        <Text variant="subheading" style={{ marginBottom: 8 }}>
          Why PACE needs your location
        </Text>
        <Text variant="bodySmall" color="secondary">
          • Measure distance, pace and speed, and draw your route.{'\n'}• Only while you are
          recording — PACE never tracks you in the background otherwise.{'\n'}• Your route stays on
          this phone unless you back it up or export it.
        </Text>
      </Card>
      <Card>
        <Text variant="bodySmall" color="secondary">
          Choose “Allow While Using App”. While a recording is active iOS keeps PACE running with
          the screen locked and shows the blue location indicator. PACE asks for “Always” only if
          you later opt in.
        </Text>
      </Card>
      {!isTrackingAvailable() ? (
        <Banner
          tone="warning"
          message="GPS recording requires the PACE development or release build (not Expo Go)."
        />
      ) : null}
      {status === 'when_in_use' || status === 'always' ? (
        <Banner tone="success" message="Location access granted." />
      ) : null}
      {denied ? (
        <Banner
          tone="warning"
          message="Location is off for PACE. You can enable it in Settings before recording."
          action={{ label: 'Settings', onPress: () => void Linking.openSettings() }}
        />
      ) : null}
      {status === null && isTrackingAvailable() ? (
        <Button label="Allow location" size="lg" onPress={request} loading={busy} />
      ) : null}
      <Button
        label={status === null ? 'Not now' : 'Finish'}
        size="lg"
        variant={status === null ? 'ghost' : 'primary'}
        onPress={finish}
        style={{ marginTop: 12 }}
      />
      <Text variant="caption" color="secondary" align="center" style={{ marginTop: 16 }}>
        Apple Health access is requested separately when you turn that integration on (future
        release).
      </Text>
    </Screen>
  );
}
