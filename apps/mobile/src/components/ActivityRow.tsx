import type { Activity, MeasurementSystem } from '@pace/domain';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { activityTimeLabel, cardMetrics } from '@/features/activity-view';
import { sportLabel } from '@/features/display';
import { useTheme } from '@/theme/ThemeProvider';
import { SportBadge } from './SportBadge';
import { Text } from './Text';
import { Card } from './layout';

/** Activity card used in history lists: sport, title, local start time and measured metrics. */
export function ActivityRow({ activity, units }: { activity: Activity; units: MeasurementSystem }) {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const metrics = cardMetrics(activity, units);
  const when = activityTimeLabel(activity);
  const imported = activity.source !== 'recorded';
  return (
    <Card
      onPress={() => router.push({ pathname: '/activity/[id]', params: { id: activity.id } })}
      accessibilityLabel={`${activity.title}, ${sportLabel(activity.sportType)}, ${when}. ${metrics.map((m) => `${m.label} ${m.value} ${m.unit ?? ''}`).join(', ')}`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
        <SportBadge sport={activity.sportType} size={36} />
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <Text variant="subheading" numberOfLines={1}>
            {activity.title}
          </Text>
          <Text variant="caption" color="secondary" numberOfLines={1}>
            {sportLabel(activity.sportType)} · {when}
          </Text>
        </View>
        {imported ? (
          <View
            style={{
              marginLeft: spacing.sm,
              paddingHorizontal: spacing.sm,
              paddingVertical: spacing.xxs,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: colors.divider,
            }}
          >
            <Text variant="caption" color="secondary">
              Imported
            </Text>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row' }}>
        {metrics.map((m) => (
          <View key={m.label} style={{ flex: 1 }}>
            <Text variant="caption" color="secondary">
              {m.label.charAt(0).toUpperCase() + m.label.slice(1)}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <Text variant="metricSmall" numberOfLines={1}>
                {m.value}
              </Text>
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
