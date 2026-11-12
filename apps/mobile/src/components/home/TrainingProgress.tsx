import { Ionicons } from '@expo/vector-icons';
import type { Dashboard } from '@pace/core';
import type { MeasurementSystem } from '@pace/domain';
import { distanceUnitLabel, formatDistanceValue } from '@pace/domain';
import { View } from 'react-native';
import { BarChart } from '@/components/BarChart';
import { Text } from '@/components/Text';
import { Card } from '@/components/layout';
import { consistencyText, weeklyDistanceChart } from '@/features/dashboard-view';
import { useTheme } from '@/theme/ThemeProvider';

/** Eight-week distance chart with consistency and, when history allows, a 4-week average. */
export function TrainingProgress({ data, units }: { data: Dashboard; units: MeasurementSystem }) {
  const { colors, spacing } = useTheme();
  const c = consistencyText(data.consistency);
  const unit = distanceUnitLabel(units);
  return (
    <Card>
      <Text variant="label" color="secondary" style={{ marginBottom: spacing.md }}>
        WEEKLY DISTANCE · {unit.toUpperCase()}
      </Text>
      <BarChart
        data={weeklyDistanceChart(data.weeks, units)}
        formatValue={(v) => formatDistanceValue(v, units, 1)}
        height={120}
      />
      <View
        style={{
          marginTop: spacing.lg,
          paddingTop: spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.divider,
          gap: spacing.sm,
        }}
      >
        <Line icon="calendar-outline" text={c.summary} />
        {c.streak ? <Line icon="flame-outline" text={c.streak} accent /> : null}
        {data.trailingAverage ? (
          <Line
            icon="analytics-outline"
            text={`${data.trailingAverage.weeks}-week average: ${formatDistanceValue(data.trailingAverage.distanceMeters, units, 1)} ${unit} per week`}
          />
        ) : null}
      </View>
    </Card>
  );
}

function Line({
  icon,
  text,
  accent,
}: {
  icon: 'calendar-outline' | 'flame-outline' | 'analytics-outline';
  text: string;
  accent?: boolean;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Ionicons name={icon} size={16} color={accent ? colors.accent : colors.textSecondary} />
      <Text
        variant="bodySmall"
        color={accent ? 'accent' : 'primary'}
        style={{ marginLeft: spacing.sm }}
      >
        {text}
      </Text>
    </View>
  );
}
