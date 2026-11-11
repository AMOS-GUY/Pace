import { formatDistanceValue, formatDuration } from '@pace/domain';
import { useRouter } from 'expo-router';
import { RefreshControl, View } from 'react-native';
import { ActivityRow } from '@/components/ActivityRow';
import { BarChart } from '@/components/BarChart';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricTile,
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
} from '@/components/layout';
import { distanceMetric, greeting } from '@/features/display';
import { goalDescription } from '@/features/goals';
import { useDashboard } from '@/hooks/queries';
import { usePreferences, useUnits } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

export default function Home() {
  const router = useRouter();
  const units = useUnits();
  const name = usePreferences((s) => s.profile?.displayName);
  const { spacing } = useTheme();
  const q = useDashboard();

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />
      }
    >
      <Text variant="bodySmall" color="secondary">
        {greeting()}
      </Text>
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: spacing.lg }}>
        {name ?? 'Athlete'}
      </Text>
      <Button
        label="Start activity"
        icon="play"
        size="lg"
        onPress={() => router.push('/recording')}
      />

      {q.isLoading ? <LoadingState /> : null}
      {q.error ? (
        <ErrorState message="Could not load your summary." onRetry={() => void q.refetch()} />
      ) : null}
      {q.data ? (
        <>
          <SectionHeader title="This week" />
          <Card>
            <Row>
              <MetricTile {...distanceMetric(q.data.thisWeek.distanceMeters, units)} />
              <MetricTile label="Time" value={formatDuration(q.data.thisWeek.movingDurationMs)} />
              <MetricTile label="Activities" value={String(q.data.thisWeek.activityCount)} />
            </Row>
            <View style={{ marginTop: spacing.lg }}>
              <BarChart
                data={q.data.weeks.map((w) => ({
                  key: w.key,
                  label: w.key.slice(8, 10) + '/' + w.key.slice(5, 7),
                  value: w.distanceMeters,
                  description: `Week of ${w.key}: ${formatDistanceValue(w.distanceMeters, units, 1)}`,
                }))}
                formatValue={(v) => formatDistanceValue(v, units, 1)}
                height={110}
              />
            </View>
          </Card>

          {q.data.goals.length > 0 ? (
            <>
              <SectionHeader
                title="Goals"
                action={{ label: 'Manage', onPress: () => router.push('/settings/goals') }}
              />
              {q.data.goals.map(({ goal, progress }) => (
                <Card key={goal.id}>
                  <Text variant="bodySmall" style={{ marginBottom: spacing.sm }}>
                    {goalDescription(goal, progress, units)}
                  </Text>
                  <ProgressBar ratio={progress.ratio} />
                </Card>
              ))}
            </>
          ) : null}

          <SectionHeader
            title="Recent activities"
            action={
              q.data.recent.length
                ? { label: 'See all', onPress: () => router.push('/(tabs)/activities') }
                : undefined
            }
          />
          {q.data.recent.length === 0 ? (
            <EmptyState
              icon="walk-outline"
              title="No activities yet"
              message="Record your first activity or import a GPX file."
              action={{ label: 'Start activity', onPress: () => router.push('/recording') }}
            />
          ) : (
            q.data.recent.map((a) => <ActivityRow key={a.id} activity={a} units={units} />)
          )}
        </>
      ) : null}
    </Screen>
  );
}
