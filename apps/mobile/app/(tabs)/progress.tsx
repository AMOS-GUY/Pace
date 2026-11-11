import type { PersonalRecord, SportType } from '@pace/domain';
import { formatDistanceValue, formatDuration } from '@pace/domain';
import { getSport } from '@pace/sports';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { BarChart } from '@/components/BarChart';
import { Text } from '@/components/Text';
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  ListRow,
  LoadingState,
  MetricTile,
  Row,
  Screen,
  SectionHeader,
  Segmented,
} from '@/components/layout';
import {
  averageMetric,
  distanceMetric,
  elevationMetric,
  formatDate,
  sportLabel,
} from '@/features/display';
import { useProgress } from '@/hooks/queries';
import { useUnits } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

type Period = 'week' | 'month' | 'year';

function bucketLabel(key: string, period: Period): string {
  if (period === 'year') return key;
  if (period === 'month')
    return new Intl.DateTimeFormat(undefined, { month: 'short' }).format(
      new Date(`${key}-15T12:00:00Z`),
    );
  return `${key.slice(8, 10)}/${key.slice(5, 7)}`;
}

function recordLabel(r: PersonalRecord): string {
  return (
    getSport(r.sportType).records.find((d) => d.metric === r.metricType)?.label ?? r.metricType
  );
}

export default function Progress() {
  const router = useRouter();
  const units = useUnits();
  const { spacing } = useTheme();
  const [period, setPeriod] = useState<Period>('week');
  const [metric, setMetric] = useState<'distance' | 'time'>('distance');
  const [sport, setSport] = useState<SportType | undefined>(undefined);
  const q = useProgress(period, sport);

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />
      }
    >
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: spacing.lg }}>
        Progress
      </Text>
      <Segmented
        options={[
          { value: 'week', label: 'Weekly' },
          { value: 'month', label: 'Monthly' },
          { value: 'year', label: 'Yearly' },
        ]}
        value={period}
        onChange={setPeriod}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}
      >
        <Chip label="All sports" selected={!sport} onPress={() => setSport(undefined)} />
        {(['running', 'cycling', 'walking', 'hiking', 'swimming', 'triathlon'] as const).map(
          (s) => (
            <Chip
              key={s}
              label={sportLabel(s)}
              selected={sport === s}
              onPress={() => setSport(sport === s ? undefined : s)}
            />
          ),
        )}
      </ScrollView>

      {q.isLoading ? <LoadingState /> : null}
      {q.error ? (
        <ErrorState message="Could not compute your progress." onRetry={() => void q.refetch()} />
      ) : null}
      {q.data ? (
        q.data.allTime.activityCount === 0 ? (
          <EmptyState
            icon="stats-chart-outline"
            title="Nothing to analyse yet"
            message="Your statistics are calculated from recorded activities."
            action={{ label: 'Start activity', onPress: () => router.push('/recording') }}
          />
        ) : (
          <>
            <Card>
              <Segmented
                options={[
                  { value: 'distance', label: 'Distance' },
                  { value: 'time', label: 'Moving time' },
                ]}
                value={metric}
                onChange={setMetric}
              />
              <BarChart
                data={q.data.buckets.map((b) => ({
                  key: b.key,
                  label: bucketLabel(b.key, period),
                  value: metric === 'distance' ? b.distanceMeters : b.movingDurationMs,
                  description: `${b.key}: ${metric === 'distance' ? formatDistanceValue(b.distanceMeters, units, 1) : formatDuration(b.movingDurationMs)}`,
                }))}
                formatValue={(v) =>
                  metric === 'distance' ? formatDistanceValue(v, units, 1) : formatDuration(v)
                }
              />
            </Card>

            <SectionHeader title="All time" />
            <Card>
              <Row>
                <MetricTile {...distanceMetric(q.data.allTime.distanceMeters, units)} size="sm" />
                <MetricTile
                  label="Moving time"
                  value={formatDuration(q.data.allTime.movingDurationMs)}
                  size="sm"
                />
              </Row>
              <Row style={{ marginTop: spacing.md }}>
                <MetricTile
                  {...elevationMetric(q.data.allTime.elevationGainMeters, units, 'Elevation gain')}
                  size="sm"
                />
                <MetricTile
                  label="Activities"
                  value={String(q.data.allTime.activityCount)}
                  size="sm"
                />
              </Row>
            </Card>

            <SectionHeader title="By sport" />
            <Card>
              {q.data.bySport.map((s) => {
                const d = distanceMetric(s.distanceMeters, units);
                const avg = averageMetric(s.sportType, s, units);
                return (
                  <ListRow
                    key={s.sportType}
                    label={`${sportLabel(s.sportType)} · ${s.activityCount}`}
                    right={
                      <Text variant="bodySmall" color="secondary">
                        {d.value} {d.unit} · {avg.value} {avg.unit}
                      </Text>
                    }
                  />
                );
              })}
              <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
                Averages are per sport — pace and speed are never blended across sports.
              </Text>
            </Card>

            <SectionHeader title="Personal records" />
            <Card>
              {q.data.records.length === 0 ? (
                <Text variant="bodySmall" color="secondary">
                  Records appear once an activity has a reliable GPS track.
                </Text>
              ) : (
                q.data.records.map((r) => (
                  <ListRow
                    key={`${r.sportType}:${r.metricType}`}
                    label={`${sportLabel(r.sportType)} · ${recordLabel(r)}`}
                    value={`${r.unit === 'ms' ? formatDuration(r.value) : `${formatDistanceValue(r.value, units)} ${units === 'metric' ? 'km' : 'mi'}`}${r.basis === 'estimated_segment' ? ' (est.)' : ''}`}
                    onPress={() =>
                      router.push({ pathname: '/activity/[id]', params: { id: r.activityId } })
                    }
                  />
                ))
              )}
              <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
                “est.” marks the fastest segment within a longer activity, measured by GPS — not an
                official race time.
              </Text>
            </Card>

            {q.data.highlights.longestByDistance ? (
              <>
                <SectionHeader title="Highlights" />
                <Card>
                  <View>
                    <ListRow
                      label="Longest activity"
                      value={`${formatDistanceValue(q.data.highlights.longestByDistance.distanceMeters, units)} · ${formatDate(q.data.highlights.longestByDistance.startedAt)}`}
                      onPress={() =>
                        router.push({
                          pathname: '/activity/[id]',
                          params: { id: q.data!.highlights.longestByDistance!.id },
                        })
                      }
                    />
                    {q.data.highlights.highestElevationGain ? (
                      <ListRow
                        label="Most climbing"
                        value={`${elevationMetric(q.data.highlights.highestElevationGain.elevationGainMeters, units).value} ${units === 'metric' ? 'm' : 'ft'}`}
                        onPress={() =>
                          router.push({
                            pathname: '/activity/[id]',
                            params: { id: q.data!.highlights.highestElevationGain!.id },
                          })
                        }
                      />
                    ) : null}
                  </View>
                </Card>
              </>
            ) : null}
            <ListRow
              icon="flag-outline"
              label="Training goals"
              onPress={() => router.push('/settings/goals')}
            />
          </>
        )
      ) : null}
    </Screen>
  );
}
