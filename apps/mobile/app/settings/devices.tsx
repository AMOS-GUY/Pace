import { Text } from '@/components/Text';
import { Card, ListRow, Screen } from '@/components/layout';
import { useTheme } from '@/theme/ThemeProvider';

/** Every row here is intentionally disabled and labelled: these integrations are future milestones (M10). */
export default function DevicesSettings() {
  const { spacing } = useTheme();
  return (
    <Screen edges={[]}>
      <Card>
        <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.sm }}>
          Sensor and watch support is planned. Your iPhone’s GPS is used for every activity today.
        </Text>
        <ListRow
          icon="heart-outline"
          label="Bluetooth heart-rate monitor"
          value="Future release"
          disabled
        />
        <ListRow
          icon="bicycle-outline"
          label="Cycling speed & cadence"
          value="Future release"
          disabled
        />
        <ListRow icon="flash-outline" label="Power meter" value="Future release" disabled />
        <ListRow icon="watch-outline" label="Apple Watch" value="Future release" disabled />
        <ListRow icon="fitness-outline" label="Apple Health sync" value="Future release" disabled />
      </Card>
    </Screen>
  );
}
