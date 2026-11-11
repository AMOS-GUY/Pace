import { Ionicons } from '@expo/vector-icons';
import type { Activity, MeasurementSystem } from '@pace/domain';
import { formatDuration } from '@pace/domain';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import {
  averageMetric,
  distanceMetric,
  formatDate,
  sportIcon,
  sportLabel,
} from '@/features/display';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';
import { Card } from './layout';

export function ActivityRow({ activity, units }: { activity: Activity; units: MeasurementSystem }) {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const d = distanceMetric(activity.distanceMeters, units);
  const avg = averageMetric(activity.sportType, activity, units);
  return (
    <Card
      onPress={() => router.push({ pathname: '/activity/[id]', params: { id: activity.id } })}
      accessibilityLabel={`${activity.title}, ${sportLabel(activity.sportType)}, ${formatDate(activity.startedAt, activity.timezone)}, ${d.value} ${d.unit}`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
        <Ionicons name={sportIcon(activity.sportType) as never} size={18} color={colors.accent} />
        <Text variant="subheading" numberOfLines={1} style={{ flex: 1, marginLeft: spacing.sm }}>
          {activity.title}
        </Text>
        <Text variant="caption" color="secondary">
          {formatDate(activity.startedAt, activity.timezone)}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: spacing.xl }}>
        <Stat label="Distance" value={`${d.value} ${d.unit}`} />
        <Stat label="Time" value={formatDuration(activity.movingDurationMs)} />
        <Stat label={avg.label} value={`${avg.value}${avg.unit ? ` ${avg.unit}` : ''}`} />
      </View>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text variant="caption" color="secondary">
        {label}
      </Text>
      <Text variant="metricSmall">{value}</Text>
    </View>
  );
}
