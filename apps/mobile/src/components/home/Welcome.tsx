import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Pressable, View } from 'react-native';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Card } from '@/components/layout';
import { useTheme } from '@/theme/ThemeProvider';

type IconName = ComponentProps<typeof Ionicons>['name'];

/**
 * Home for an athlete with no activities yet. Shows what to do next instead of a dashboard of
 * zeros; every statistic appears only once there is a recorded or imported activity.
 */
export function Welcome({
  onRecord,
  onImport,
  onSetGoal,
}: {
  onRecord: () => void;
  onImport: () => void;
  onSetGoal: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Card style={{ borderWidth: 1, borderColor: colors.divider, padding: spacing.xl }}>
      <Text variant="heading" accessibilityRole="header">
        Your training starts here
      </Text>
      <Text variant="bodySmall" color="secondary" style={{ marginTop: spacing.xs }}>
        Your weekly totals, trends and records build up from the activities you record. Nothing is
        shown until it has been measured.
      </Text>

      <View style={{ marginTop: spacing.lg, gap: spacing.xs }}>
        <Step
          icon="navigate-outline"
          title="Record your first activity"
          detail="Run, ride, walk, hike, swim or triathlon — GPS works offline."
          onPress={onRecord}
        />
        <Step
          icon="document-attach-outline"
          title="Import your history"
          detail="FIT, GPX, TCX or a whole ZIP export from Garmin, Strava and others."
          onPress={onImport}
        />
        <Step
          icon="flag-outline"
          title="Set a weekly goal"
          detail="Distance, time or number of activities."
          onPress={onSetGoal}
        />
      </View>

      <Button
        label="Start your first activity"
        icon="play"
        size="lg"
        onPress={onRecord}
        style={{ marginTop: spacing.lg }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.lg }}>
        <Ionicons name="lock-closed-outline" size={14} color={colors.textSecondary} />
        <Text variant="caption" color="secondary" style={{ flex: 1, marginLeft: spacing.xs }}>
          Activities are saved on this iPhone first and stay yours: export them as GPX at any time.
        </Text>
      </View>
    </Card>
  );
}

function Step({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: IconName;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  const { colors, spacing, touchTarget } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: touchTarget.min + 8,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: colors.primaryMuted,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={18} color={colors.accent} />
      </View>
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text variant="subheading">{title}</Text>
        <Text variant="caption" color="secondary">
          {detail}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </Pressable>
  );
}
