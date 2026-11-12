import { useRouter } from 'expo-router';
import { RefreshControl } from 'react-native';
import { FadeIn } from '@/components/FadeIn';
import { Text } from '@/components/Text';
import { HomeHeader } from '@/components/home/HomeHeader';
import { LatestActivity } from '@/components/home/LatestActivity';
import { QuickActions } from '@/components/home/QuickActions';
import { TrainingProgress } from '@/components/home/TrainingProgress';
import { WeekOverview } from '@/components/home/WeekOverview';
import { Welcome } from '@/components/home/Welcome';
import {
  Banner,
  Card,
  ErrorState,
  LoadingState,
  ProgressBar,
  Screen,
  SectionHeader,
} from '@/components/layout';
import { primaryWeeklyGoal } from '@/features/dashboard-view';
import { goalDescription } from '@/features/goals';
import { useDashboard } from '@/hooks/queries';
import { useStartActivity } from '@/hooks/useStartActivity';
import { deviceTimeZone } from '@/services/container';
import { usePreferences, useUnits } from '@/stores/preferences';
import { useRecording } from '@/stores/recording';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Home: the athlete's week at a glance. Every figure comes from `AnalyticsService.dashboard`,
 * which reads the local database; a new athlete sees guidance instead of empty statistics.
 */
export default function Home() {
  const router = useRouter();
  const units = useUnits();
  const name = usePreferences((s) => s.profile?.displayName);
  const start = useStartActivity();
  const snapshot = useRecording((s) => s.snapshot);
  const { spacing } = useTheme();
  const q = useDashboard();
  // Figures were computed at fetch time; label "today" against the same instant.
  const now = q.dataUpdatedAt || Date.now();
  const timeZone = deviceTimeZone();
  const recordingActive =
    snapshot != null && snapshot.state.status !== 'READY' && snapshot.state.status !== 'SAVED';

  const openActivity = (id: string): void =>
    router.push({ pathname: '/activity/[id]', params: { id } });
  const openGoals = (): void => router.push('/settings/goals');
  const openHistory = (): void => router.push('/(tabs)/activities');

  const data = q.data;
  const primaryGoal = data ? primaryWeeklyGoal(data.goals) : null;
  const otherGoals = data ? data.goals.filter((g) => g.goal.id !== primaryGoal?.goal.id) : [];
  const latest = data?.recent[0];

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />
      }
    >
      <HomeHeader
        name={name}
        now={new Date(now)}
        onOpenProfile={() => router.push('/(tabs)/profile')}
      />

      {recordingActive ? (
        <Banner
          tone="info"
          message="A recording is in progress."
          action={{ label: 'Open', onPress: () => router.push('/recording') }}
        />
      ) : null}

      <QuickActions
        actions={[
          {
            key: 'run',
            label: 'Run',
            icon: 'play',
            primary: true,
            accessibilityLabel: 'Start a run',
            onPress: () => void start('running'),
          },
          {
            key: 'ride',
            label: 'Ride',
            icon: 'bicycle-outline',
            accessibilityLabel: 'Start a ride',
            onPress: () => void start('cycling'),
          },
          {
            key: 'other',
            label: 'Other',
            icon: 'grid-outline',
            accessibilityLabel: 'Choose another sport',
            onPress: () => router.push('/(tabs)/record'),
          },
          {
            key: 'history',
            label: 'History',
            icon: 'time-outline',
            accessibilityLabel: 'View activity history',
            onPress: openHistory,
          },
        ]}
      />

      {q.isLoading ? <LoadingState label="Loading your week…" /> : null}
      {q.error ? (
        <ErrorState message="Could not load your summary." onRetry={() => void q.refetch()} />
      ) : null}

      {data && data.totalActivityCount === 0 ? (
        <FadeIn>
          <Welcome
            onRecord={() => void start()}
            onImport={() => router.push('/import')}
            onSetGoal={openGoals}
          />
        </FadeIn>
      ) : null}

      {data && data.totalActivityCount > 0 ? (
        <>
          <FadeIn index={0}>
            <WeekOverview
              data={data}
              units={units}
              now={now}
              timeZone={timeZone}
              onSetGoal={openGoals}
            />
          </FadeIn>

          {latest ? (
            <FadeIn index={1}>
              <SectionHeader
                title="Latest activity"
                action={{ label: 'History', onPress: openHistory }}
              />
              <LatestActivity
                activity={latest}
                units={units}
                onPress={() => openActivity(latest.id)}
              />
            </FadeIn>
          ) : null}

          <FadeIn index={2}>
            <SectionHeader
              title="Training"
              action={{ label: 'Progress', onPress: () => router.push('/(tabs)/progress') }}
            />
            <TrainingProgress data={data} units={units} />
          </FadeIn>

          {otherGoals.length > 0 ? (
            <FadeIn index={3}>
              <SectionHeader title="Goals" action={{ label: 'Manage', onPress: openGoals }} />
              {otherGoals.map(({ goal, progress }) => (
                <Card key={goal.id}>
                  <Text variant="bodySmall" style={{ marginBottom: spacing.sm }}>
                    {goalDescription(goal, progress, units)}
                  </Text>
                  <ProgressBar ratio={progress.ratio} />
                </Card>
              ))}
            </FadeIn>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
