import { useRouter } from 'expo-router';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Card, Segmented, Screen } from '@/components/layout';
import { usePreferences } from '@/stores/preferences';

export default function OnboardingUnits() {
  const router = useRouter();
  const { prefs, update } = usePreferences();
  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 96 }}>
      <Text variant="label" color="accent">
        STEP 3 OF 4
      </Text>
      <Text variant="title" accessibilityRole="header" style={{ marginVertical: 12 }}>
        Units
      </Text>
      <Segmented
        options={[
          { value: 'metric', label: 'Metric (km, m)' },
          { value: 'imperial', label: 'Imperial (mi, ft)' },
        ]}
        value={prefs.measurementSystem}
        onChange={(v) => void update({ measurementSystem: v })}
      />
      <Card>
        <Text variant="bodySmall" color="secondary">
          You can change this any time in Profile → Units. Activities are always stored in metres
          and milliseconds, so switching never alters your data.
        </Text>
      </Card>
      <Button label="Continue" size="lg" onPress={() => router.push('/(onboarding)/permissions')} />
    </Screen>
  );
}
