import type { GoalPeriod, GoalType, SportType, TrainingGoal } from '@pace/domain';
import { METERS_PER_KILOMETER, METERS_PER_MILE, MS_PER_HOUR } from '@pace/domain';
import { goalInputSchema } from '@pace/validation';
import { useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import {
  Card,
  Chip,
  EmptyState,
  ListRow,
  LoadingState,
  Row,
  Screen,
  SectionHeader,
  Segmented,
} from '@/components/layout';
import { sportLabel } from '@/features/display';
import { useGoals, useInvalidateAll } from '@/hooks/queries';
import { getServices } from '@/services/container';
import { useUnits } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

function describe(g: TrainingGoal, units: 'metric' | 'imperial'): string {
  const unit = units === 'metric' ? METERS_PER_KILOMETER : METERS_PER_MILE;
  const v =
    g.goalType === 'distance'
      ? `${(g.targetValue / unit).toFixed(0)} ${units === 'metric' ? 'km' : 'mi'}`
      : g.goalType === 'duration'
        ? `${(g.targetValue / MS_PER_HOUR).toFixed(1)} h`
        : `${g.targetValue} activities`;
  return `${v} per ${g.period}${g.sportType ? ` · ${sportLabel(g.sportType)}` : ''}`;
}

export default function GoalsSettings() {
  const units = useUnits();
  const { spacing } = useTheme();
  const q = useGoals();
  const invalidate = useInvalidateAll();
  const [goalType, setGoalType] = useState<GoalType>('distance');
  const [period, setPeriod] = useState<GoalPeriod>('week');
  const [sport, setSport] = useState<SportType | null>(null);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    const n = Number(target.replace(',', '.'));
    const unit = units === 'metric' ? METERS_PER_KILOMETER : METERS_PER_MILE;
    const targetValue =
      goalType === 'distance'
        ? n * unit
        : goalType === 'duration'
          ? n * MS_PER_HOUR
          : Math.round(n);
    const r = goalInputSchema.safeParse({ sportType: sport, goalType, targetValue, period });
    if (!r.success || !Number.isFinite(n) || n <= 0) {
      setError('Enter a positive target.');
      return;
    }
    setError(null);
    const { goals } = await getServices();
    await goals.create(r.data);
    setTarget('');
    await invalidate();
  };

  const remove = (g: TrainingGoal): void =>
    Alert.alert('Delete goal?', describe(g, units), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await (await getServices()).goals.remove(g.id);
          await invalidate();
        },
      },
    ]);

  return (
    <Screen edges={[]}>
      {q.isLoading ? <LoadingState /> : null}
      {q.data && q.data.length === 0 ? (
        <EmptyState
          icon="flag-outline"
          title="No goals yet"
          message="Goals track progress from your recorded activities."
        />
      ) : null}
      {q.data && q.data.length > 0 ? (
        <Card>
          {q.data.map((g) => (
            <ListRow
              key={g.id}
              label={describe(g, units)}
              onPress={() => remove(g)}
              value="Delete"
            />
          ))}
        </Card>
      ) : null}

      <SectionHeader title="New goal" />
      <Card>
        <Segmented
          options={[
            { value: 'distance', label: 'Distance' },
            { value: 'activity_count', label: 'Activities' },
            { value: 'duration', label: 'Hours' },
          ]}
          value={goalType}
          onChange={setGoalType}
        />
        <Segmented
          options={[
            { value: 'week', label: 'Per week' },
            { value: 'month', label: 'Per month' },
          ]}
          value={period}
          onChange={setPeriod}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}
        >
          <Chip label="All sports" selected={sport === null} onPress={() => setSport(null)} />
          {(['running', 'cycling', 'walking', 'hiking', 'swimming'] as const).map((s) => (
            <Chip
              key={s}
              label={sportLabel(s)}
              selected={sport === s}
              onPress={() => setSport(s)}
            />
          ))}
        </ScrollView>
        <Row>
          <Input
            label={
              goalType === 'distance'
                ? `Target (${units === 'metric' ? 'km' : 'mi'})`
                : goalType === 'duration'
                  ? 'Target (hours)'
                  : 'Target (activities)'
            }
            value={target}
            onChangeText={setTarget}
            keyboardType="decimal-pad"
            error={error}
            style={{ minWidth: 200 }}
          />
        </Row>
        <Button label="Add goal" onPress={() => void add()} />
        <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
          Progress counts completed activities in the current calendar week (Mon–Sun) or month.
        </Text>
      </Card>
    </Screen>
  );
}
