import { Text } from '@/components/Text';
import { Card, Screen, Segmented } from '@/components/layout';
import { usePreferences } from '@/stores/preferences';

export default function UnitsSettings() {
  const { prefs, update } = usePreferences();
  return (
    <Screen edges={[]}>
      <Segmented
        options={[
          { value: 'metric', label: 'Metric' },
          { value: 'imperial', label: 'Imperial' },
        ]}
        value={prefs.measurementSystem}
        onChange={(v) => void update({ measurementSystem: v })}
      />
      <Card>
        <Text variant="bodySmall" color="secondary">
          Metric shows kilometres, metres and min/km. Imperial shows miles, feet and min/mi. Stored
          data is unchanged.
        </Text>
      </Card>
    </Screen>
  );
}
