import { activityEditSchema } from '@pace/validation';
import { Ionicons } from '@expo/vector-icons';
import {
  NO_VALUE,
  elevationUnitLabel,
  formatDuration,
  formatElevation,
  formatSpeed,
  speedUnitLabel,
} from '@pace/domain';
import { getSport } from '@pace/sports';
import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert, Modal, View } from 'react-native';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { RouteMap } from '@/components/RouteMap';
import { SplitChart } from '@/components/SplitChart';
import { SportBadge } from '@/components/SportBadge';
import { Text } from '@/components/Text';
import {
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  LoadingState,
  MetricTile,
  Row,
  Screen,
  SectionHeader,
} from '@/components/layout';
import {
  isPoolSwim,
  pausedDurationMs,
  routeQuality,
  showsElevation,
  sourceLabel,
} from '@/features/activity-view';
import {
  averageMetric,
  distanceMetric,
  elevationMetric,
  formatDateTime,
  sportLabel,
} from '@/features/display';
import { useActivityDetail, useInvalidateAll } from '@/hooks/queries';
import { getServices } from '@/services/container';
import { usePreferences, useUnits } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

const SEGMENT_LABELS = {
  swim: 'Swim',
  transition_1: 'T1',
  bike: 'Bike',
  transition_2: 'T2',
  run: 'Run',
} as const;

export default function ActivityDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const units = useUnits();
  const privacyZone = usePreferences((s) => s.prefs.exportPrivacyZoneMeters);
  const { colors, spacing } = useTheme();
  const q = useActivityDetail(id);
  const invalidate = useInvalidateAll();
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (q.isLoading)
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  if (q.error)
    return (
      <Screen>
        <ErrorState message="Could not load this activity." onRetry={() => void q.refetch()} />
      </Screen>
    );
  if (!q.data)
    return (
      <Screen>
        <EmptyState
          icon="alert-circle-outline"
          title="Activity not found"
          message="It may have been deleted."
        />
      </Screen>
    );
  const { activity: a, laps, splits, segments, route, records } = q.data;
  const sport = getSport(a.sportType);
  const avg = averageMetric(a.sportType, a, units);
  const pool = isPoolSwim(a);
  const elevation = showsElevation(a);
  const paused = pausedDurationMs(a);
  const hasRoute = route != null && route.points.some((p) => p.length > 1);
  const quality = route ? routeQuality(route) : null;

  const exportGpx = async (): Promise<void> => {
    setExporting(true);
    try {
      const { activityService } = await getServices();
      const { fileName, content } = await activityService.exportGpx(a.id, {
        privacyZoneMeters: privacyZone,
      });
      const file = new File(Paths.cache, fileName);
      if (file.exists) file.delete();
      file.create();
      file.write(content);
      if (await Sharing.isAvailableAsync())
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/gpx+xml',
          UTI: 'com.topografix.gpx',
        });
      else Alert.alert('Exported', `Saved to ${file.uri}`);
    } catch (e) {
      Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const remove = (): void =>
    Alert.alert(
      'Delete activity?',
      'The activity, its route and its records are removed from this iPhone. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const { activities } = await getServices();
            await activities.softDelete(a.id);
            await invalidate();
            router.back();
          },
        },
      ],
    );

  return (
    <>
      <Stack.Screen options={{ title: sportLabel(a.sportType) }} />
      <Screen edges={[]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
          <SportBadge sport={a.sportType} size={32} />
          <Text variant="label" color="secondary" style={{ marginLeft: spacing.sm, flex: 1 }}>
            {sportLabel(a.sportType).toUpperCase()}
            {pool ? ' · POOL' : a.sportType === 'swimming' ? ' · OPEN WATER' : null}
          </Text>
        </View>
        <Text variant="title" accessibilityRole="header">
          {a.title}
        </Text>
        <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.lg }}>
          {formatDateTime(a.startedAt, a.timezone)}
          {a.source !== 'recorded' ? ` · ${sourceLabel(a.source)}` : null}
        </Text>
        {a.description ? (
          <Text variant="body" style={{ marginBottom: spacing.lg }}>
            {a.description}
          </Text>
        ) : null}

        {hasRoute ? (
          <RouteMap segments={route.points} height={280} style={{ marginBottom: spacing.lg }} />
        ) : (
          <Card>
            <Text variant="bodySmall" color="secondary">
              {pool
                ? 'Pool swims are measured by lengths, so there is no GPS route.'
                : 'No GPS route was stored for this activity.'}
            </Text>
          </Card>
        )}

        <Card style={{ borderWidth: 1, borderColor: colors.divider, padding: spacing.xl }}>
          <MetricTile {...distanceMetric(a.distanceMeters, units)} size="lg" />
          <Row style={{ marginTop: spacing.lg }}>
            <MetricTile label="Moving time" value={formatDuration(a.movingDurationMs)} size="sm" />
            <MetricTile {...avg} size="sm" />
          </Row>
          <Row style={{ marginTop: spacing.md }}>
            {elevation ? (
              <MetricTile
                {...elevationMetric(a.elevationGainMeters, units, 'Elevation gain')}
                size="sm"
              />
            ) : (
              <MetricTile label="Paused" value={formatDuration(paused)} size="sm" />
            )}
            <MetricTile label="Elapsed" value={formatDuration(a.elapsedDurationMs)} size="sm" />
          </Row>
        </Card>

        {records.length > 0 ? (
          <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="trophy-outline" size={18} color={colors.accent} />
            <Text variant="label" color="accent" style={{ marginLeft: spacing.sm }}>
              {records.length} personal record{records.length > 1 ? 's' : null} in this activity
            </Text>
          </Card>
        ) : null}

        {segments.length > 0 ? (
          <>
            <SectionHeader title="Legs" />
            <Card>
              {segments.map((s) => (
                <ListRow
                  key={s.id}
                  label={SEGMENT_LABELS[s.segmentType]}
                  value={`${formatDuration(s.elapsedDurationMs)}${s.distanceMeters > 0 ? ` · ${distanceMetric(s.distanceMeters, units).value} ${distanceMetric(s.distanceMeters, units).unit}` : ''}`}
                />
              ))}
            </Card>
          </>
        ) : null}

        {splits.length > 0 ? (
          <>
            <SectionHeader title="Splits" />
            <Card>
              <SplitChart
                splits={splits}
                sport={a.sportType}
                units={units}
                showElevation={elevation}
              />
              <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
                Splits are every {(sport.splitDistanceMeters ?? 1000) / 1000} km of moving distance.
                {splits.some((s) => s.isPartial) ? ' * Partial split.' : null} The fastest split is
                highlighted.
              </Text>
            </Card>
          </>
        ) : null}

        {laps.length > 0 ? (
          <>
            <SectionHeader title="Laps" />
            <Card>
              {laps.map((l) => (
                <ListRow
                  key={l.id}
                  label={`Lap ${l.sequenceNumber + 1}${l.lengthCount ? ` · ${l.lengthCount} lengths` : ''}`}
                  value={`${formatDuration(l.durationMs)} · ${distanceMetric(l.distanceMeters, units).value} ${distanceMetric(l.distanceMeters, units).unit}`}
                />
              ))}
            </Card>
          </>
        ) : null}

        <SectionHeader title="Details" />
        <Card>
          {elevation ? <ListRow label="Paused time" value={formatDuration(paused)} /> : null}
          <ListRow
            label="Max speed"
            value={`${formatSpeed(a.maximumSpeedMps, units)} ${speedUnitLabel(units)}`}
          />
          {elevation ? (
            <ListRow
              label="Elevation loss"
              value={`${formatElevation(a.elevationLossMeters, units)} ${elevationUnitLabel(units)}`}
            />
          ) : null}
          {pool && a.poolLengthMeters ? (
            <ListRow label="Pool length" value={`${a.poolLengthMeters} m`} />
          ) : null}
          <ListRow label="Source" value={sourceLabel(a.source)} />
          <ListRow label="Started" value={formatDateTime(a.startedAt, a.timezone)} />
          {a.endedAt ? (
            <ListRow label="Finished" value={formatDateTime(a.endedAt, a.timezone)} />
          ) : null}
          <ListRow label="Time zone" value={a.timezone} />
        </Card>

        {route && quality ? (
          <>
            <SectionHeader title="GPS route" />
            <Card>
              <ListRow label="Track segments" value={String(route.segments.length)} />
              <ListRow
                label="Signal gaps"
                value={
                  quality.gapCount === 0
                    ? 'None'
                    : `${quality.gapCount} · ${formatDuration(quality.gapDurationMs)}`
                }
              />
              <ListRow
                label="GPS fixes used"
                value={
                  quality.rejectedShare == null
                    ? NO_VALUE
                    : `${quality.acceptedSamples} of ${quality.acceptedSamples + quality.rejectedSamples}`
                }
              />
              <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
                Inaccurate or implausible fixes are excluded, and signal gaps are left empty rather
                than filled in.
              </Text>
            </Card>
          </>
        ) : null}

        <SectionHeader title="Manage" />
        <Card>
          <ListRow
            icon="create-outline"
            label="Edit title & notes"
            onPress={() => setEditing(true)}
          />
          <ListRow
            icon="share-outline"
            label={exporting ? 'Exporting…' : 'Export GPX'}
            onPress={
              exporting || (a.sportType === 'swimming' && a.swimMode === 'pool')
                ? undefined
                : () => void exportGpx()
            }
            disabled={a.sportType === 'swimming' && a.swimMode === 'pool'}
          />
          <ListRow icon="trash-outline" label="Delete activity" destructive onPress={remove} />
        </Card>
      </Screen>
      <EditModal
        visible={editing}
        initial={{ title: a.title, description: a.description ?? '' }}
        onClose={() => setEditing(false)}
        onSave={async (v) => {
          const { activities } = await getServices();
          await activities.updateDetails(a.id, v);
          await invalidate();
          setEditing(false);
        }}
      />
    </>
  );
}

function EditModal({
  visible,
  initial,
  onClose,
  onSave,
}: {
  visible: boolean;
  initial: { title: string; description: string };
  onClose: () => void;
  onSave: (v: { title: string; description: string | null }) => Promise<void>;
}) {
  const { colors, spacing } = useTheme();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const r = activityEditSchema.safeParse({ title, description: description.trim() || null });
    if (!r.success) {
      setError('A title is required (up to 120 characters).');
      return;
    }
    await onSave({ title: r.data.title ?? initial.title, description: r.data.description ?? null });
  };
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      onShow={() => {
        setTitle(initial.title);
        setDescription(initial.description);
        setError(null);
      }}
    >
      <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg }}>
        <Text variant="heading" style={{ marginBottom: spacing.lg }}>
          Edit activity
        </Text>
        <Input label="Title" value={title} onChangeText={setTitle} error={error} maxLength={120} />
        <Input
          label="Notes"
          value={description}
          onChangeText={setDescription}
          multiline
          style={{ minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }}
          maxLength={4000}
        />
        <Button label="Save" size="lg" onPress={() => void save()} />
        <Button
          label="Cancel"
          variant="ghost"
          onPress={onClose}
          style={{ marginTop: spacing.md }}
        />
      </View>
    </Modal>
  );
}
