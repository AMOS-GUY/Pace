import type { Activity, MeasurementSystem } from '@pace/domain';
import { View } from 'react-native';
import { SportBadge } from '@/components/SportBadge';
import { Text } from '@/components/Text';
import { Card } from '@/components/layout';
import { activityTimeLabel, cardMetrics } from '@/features/activity-view';
import { sportLabel } from '@/features/display';
import { useTheme } from '@/theme/ThemeProvider';

/** The most recent completed activity, opening its detail screen. */
export function LatestActivity({
  activity,
  units,
  onPress,
}: {
  activity: Activity;
  units: MeasurementSystem;
  onPress: () => void;
}) {
  const { spacing } = useTheme();
  const metrics = cardMetrics(activity, units);
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`Latest activity: ${activity.title}, ${sportLabel(activity.sportType)}, ${activityTimeLabel(activity)}. ${metrics.map((m) => `${m.label} ${m.value} ${m.unit ?? ''}`).join(', ')}`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.lg }}>
        <SportBadge sport={activity.sportType} size={44} />
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <Text variant="subheading" numberOfLines={1}>
            {activity.title}
          </Text>
          <Text variant="caption" color="secondary" numberOfLines={1}>
            {sportLabel(activity.sportType)} · {activityTimeLabel(activity)}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row' }}>
        {metrics.map((m) => (
          <View key={m.label} style={{ flex: 1 }}>
            <Text variant="caption" color="secondary">
              {m.label.toUpperCase()}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <Text variant="metricSmall">{m.value}</Text>
              {m.unit ? (
                <Text variant="caption" color="secondary" style={{ marginLeft: 2 }}>
                  {m.unit}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </Card>
  );
}
