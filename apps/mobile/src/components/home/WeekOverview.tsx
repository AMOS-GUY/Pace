import { Ionicons } from '@expo/vector-icons';
import type { Dashboard } from '@pace/core';
import type { MeasurementSystem, SportType } from '@pace/domain';
import { formatDuration, localDateKey } from '@pace/domain';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/Text';
import { Card, ProgressBar } from '@/components/layout';
import { distanceMetric, sportLabel } from '@/features/display';
import { formatChange, primaryWeeklyGoal, weekdayInitial } from '@/features/dashboard-view';
import { goalDescription } from '@/features/goals';
import { useTheme } from '@/theme/ThemeProvider';

/** Running and cycling are always listed (a zero is a real value); other sports when present. */
const ALWAYS_LISTED: readonly SportType[] = ['running', 'cycling'];

export function WeekOverview({
  data,
  units,
  now,
  timeZone,
  onSetGoal,
}: {
  data: Dashboard;
  units: MeasurementSystem;
  now: number;
  timeZone: string;
  onSetGoal: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const total = distanceMetric(data.thisWeek.distanceMeters, units);
  const change = formatChange(data.comparison.distanceChange);
  const goal = primaryWeeklyGoal(data.goals);
  const today = localDateKey(now, timeZone);
  const bySport = new Map(data.thisWeekBySport.map((s) => [s.sportType, s]));
  const listed = [
    ...ALWAYS_LISTED,
    ...data.thisWeekBySport.map((s) => s.sportType).filter((s) => !ALWAYS_LISTED.includes(s)),
  ];

  return (
    <Card style={{ borderWidth: 1, borderColor: colors.divider, padding: spacing.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="label" color="secondary" accessibilityRole="header">
          THIS WEEK
        </Text>
        {change ? (
          <View
            accessible
            accessibilityLabel={`${change.text} distance versus last week`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing.sm,
              paddingVertical: spacing.xxs,
              borderRadius: radius.pill,
              backgroundColor: colors.primaryMuted,
            }}
          >
            {change.direction !== 'flat' ? (
              <Ionicons
                name={change.direction === 'up' ? 'arrow-up' : 'arrow-down'}
                size={12}
                color={colors.accent}
              />
            ) : null}
            <Text variant="caption" color="accent" style={{ marginLeft: spacing.xxs }}>
              {change.text} vs last week
            </Text>
          </View>
        ) : null}
      </View>

      <View
        accessible
        accessibilityLabel={`Distance this week ${total.value} ${total.unit}`}
        style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: spacing.sm }}
      >
        <Text variant="metricLarge">{total.value}</Text>
        <Text variant="subheading" color="secondary" style={{ marginLeft: spacing.xs }}>
          {total.unit}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.xl, marginTop: spacing.md }}>
        <Figure label="Activities" value={String(data.thisWeek.activityCount)} />
        <Figure label="Moving time" value={formatDuration(data.thisWeek.movingDurationMs)} />
      </View>

      <View
        style={{
          marginTop: spacing.lg,
          paddingTop: spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.divider,
          gap: spacing.xs,
        }}
      >
        {listed.map((s) => {
          const d = distanceMetric(bySport.get(s)?.distanceMeters ?? 0, units);
          return (
            <View
              key={s}
              accessible
              accessibilityLabel={`${sportLabel(s)} ${d.value} ${d.unit}`}
              style={{ flexDirection: 'row', justifyContent: 'space-between' }}
            >
              <Text variant="bodySmall" color="secondary">
                {sportLabel(s)}
              </Text>
              <Text variant="bodySmall" style={{ fontVariant: ['tabular-nums'] }}>
                {d.value} {d.unit}
              </Text>
            </View>
          );
        })}
      </View>

      <View
        accessibilityLabel={`Active on ${data.consistency.activeDaysThisWeek} of 7 days this week`}
        accessible
        style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.lg }}
      >
        {data.days.map((d) => {
          const active = d.activityCount > 0;
          const isToday = d.dateKey === today;
          return (
            <View key={d.dateKey} style={{ alignItems: 'center', gap: spacing.xs }}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: active ? colors.primary : colors.surfaceElevated,
                  borderWidth: isToday ? 2 : 0,
                  borderColor: colors.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {active ? (
                  <Ionicons name="checkmark" size={14} color={colors.textOnPrimary} />
                ) : null}
              </View>
              <Text variant="caption" color={isToday ? 'accent' : 'secondary'}>
                {weekdayInitial(d.dateKey)}
              </Text>
            </View>
          );
        })}
      </View>

      {goal ? (
        <View style={{ marginTop: spacing.lg }}>
          <Text variant="bodySmall" style={{ marginBottom: spacing.sm }}>
            {goalDescription(goal.goal, goal.progress, units)}
          </Text>
          <ProgressBar
            ratio={goal.progress.ratio}
            color={goal.progress.achieved ? colors.success : undefined}
          />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={onSetGoal}
          hitSlop={8}
          style={{ marginTop: spacing.lg, flexDirection: 'row', alignItems: 'center' }}
        >
          <Ionicons name="flag-outline" size={16} color={colors.accent} />
          <Text variant="label" color="accent" style={{ marginLeft: spacing.xs }}>
            Set a weekly goal
          </Text>
        </Pressable>
      )}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${label} ${value}`}>
      <Text variant="caption" color="secondary">
        {label}
      </Text>
      <Text variant="metricSmall">{value}</Text>
    </View>
  );
}
