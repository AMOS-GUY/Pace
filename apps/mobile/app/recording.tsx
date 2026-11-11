import { Ionicons } from '@expo/vector-icons';
import type { LiveMetrics, SessionSummary } from '@pace/activity-engine';
import {
  STANDARD_POOL_LENGTHS_METERS,
  OPEN_WATER_LIMITATION_NOTICE,
  TRIATHLON_SEGMENTS,
  getSport,
} from '@pace/sports';
import { formatDuration, type SwimMode } from '@pace/domain';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { RouteMap } from '@/components/RouteMap';
import { Text } from '@/components/Text';
import { Banner, Card, Chip, MetricTile, Row, Segmented, ToggleRow } from '@/components/layout';
import {
  averageMetric,
  currentMetric,
  distanceMetric,
  elevationMetric,
  sportLabel,
} from '@/features/display';
import { useInvalidateAll } from '@/hooks/queries';
import { getServices } from '@/services/container';
import { reportError } from '@/services/monitoring';
import { usePreferences, useUnits } from '@/stores/preferences';
import { useRecording } from '@/stores/recording';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Full-screen recorder designed for outdoor use: large tabular metrics, large controls,
 * the map secondary. All state comes from the RecordingCoordinator; this screen only renders
 * it and forwards commands.
 */
export default function RecordingScreen() {
  const { colors } = useTheme();
  const snapshot = useRecording((s) => s.snapshot);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const status = snapshot?.state.status ?? 'READY';

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: colors.background }}>
      {summary && status === 'SAVED' ? (
        <SavedView summary={summary} />
      ) : !snapshot || status === 'READY' ? (
        <SetupView />
      ) : status === 'PERMISSION_DENIED' ? (
        <PermissionDeniedView />
      ) : status === 'ACQUIRING_GPS' || status === 'LOCATION_UNAVAILABLE' ? (
        <AcquiringView snapshot={snapshot} />
      ) : (
        <ActiveView snapshot={snapshot} onSaved={setSummary} />
      )}
    </SafeAreaView>
  );
}

// ------------------------------------------------------------------ setup

function SetupView() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { prefs, update } = usePreferences();
  const sport = prefs.lastSport;
  const def = getSport(sport);
  const [swimMode, setSwimMode] = useState<SwimMode>('pool');
  const [busy, setBusy] = useState(false);
  const autoPause = prefs.autoPause[sport] ?? def.autoPauseDefault;

  const prepare = async (): Promise<void> => {
    setBusy(true);
    try {
      const { coordinator } = await getServices();
      const r = await coordinator.prepare(sport, {
        autoPauseEnabled: autoPause,
        ...(sport === 'swimming' ? { swimMode, poolLengthMeters: prefs.poolLengthMeters } : {}),
      });
      await useRecording.getState().refresh();
      // Pool swims need no GPS: start immediately.
      if (r.ok && sport === 'swimming' && swimMode === 'pool') {
        await coordinator.start();
        await useRecording.getState().refresh();
      }
    } catch (e) {
      reportError(e, { area: 'recording.prepare' });
      Alert.alert('Could not start', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Header title={`New ${sportLabel(sport)}`} onClose={() => router.back()} />
      {sport === 'swimming' ? (
        <>
          <Segmented
            options={[
              { value: 'pool', label: 'Pool' },
              { value: 'open_water', label: 'Open water' },
            ]}
            value={swimMode}
            onChange={setSwimMode}
          />
          {swimMode === 'pool' ? (
            <Card>
              <Text variant="label" color="secondary" style={{ marginBottom: spacing.sm }}>
                POOL LENGTH
              </Text>
              <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
                {STANDARD_POOL_LENGTHS_METERS.map((l) => (
                  <Chip
                    key={l}
                    label={l === 22.86 ? '25 yd' : l === 33.33 ? '33⅓ m' : `${l} m`}
                    selected={prefs.poolLengthMeters === l}
                    onPress={() => void update({ poolLengthMeters: l })}
                  />
                ))}
              </Row>
              <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
                Tap “+ lengths” after each set to log them. Stroke detection needs a compatible
                watch (future release).
              </Text>
            </Card>
          ) : (
            <Banner tone="warning" message={OPEN_WATER_LIMITATION_NOTICE} />
          )}
        </>
      ) : null}
      {sport === 'triathlon' ? (
        <Card>
          <Text variant="bodySmall" color="secondary">
            One activity with {TRIATHLON_SEGMENTS.map((s) => s.label).join(' → ')}. Tap “Next leg”
            at each change; transitions are timed automatically.
          </Text>
          <Banner tone="warning" message={OPEN_WATER_LIMITATION_NOTICE} />
        </Card>
      ) : null}
      {def.autoPause ? (
        <Card>
          <ToggleRow
            label="Auto-pause"
            value={autoPause}
            onValueChange={(v) => void update({ autoPause: { ...prefs.autoPause, [sport]: v } })}
            hint="Stops the moving-time clock when you stop (traffic lights, breaks). Elapsed time keeps running."
          />
        </Card>
      ) : null}
      <View style={{ flex: 1 }} />
      <Button
        label={sport === 'swimming' && swimMode === 'pool' ? 'Start swim' : 'Find GPS'}
        icon="navigate"
        size="lg"
        onPress={prepare}
        loading={busy}
      />
    </View>
  );
}

function PermissionDeniedView() {
  const router = useRouter();
  const { spacing } = useTheme();
  const discard = async (): Promise<void> => {
    const { coordinator } = await getServices();
    await coordinator.discard();
    router.back();
  };
  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Header title="Location is off" onClose={() => void discard()} />
      <Card>
        <Text variant="body">
          PACE needs location access to measure distance and draw your route. Open Settings → PACE →
          Location and choose “While Using the App”.
        </Text>
      </Card>
      <Button label="Open Settings" size="lg" onPress={() => void Linking.openSettings()} />
      <Button
        label="Cancel"
        variant="ghost"
        onPress={() => void discard()}
        style={{ marginTop: spacing.md }}
      />
    </View>
  );
}

function AcquiringView({ snapshot }: { snapshot: LiveMetrics }) {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const accuracy = useRecording((s) => s.acquisitionAccuracy);
  const [busy, setBusy] = useState(false);
  const good = accuracy != null && accuracy >= 0 && accuracy <= 20;

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const { coordinator } = await getServices();
      await coordinator.start({ withoutFix: !good });
      await useRecording.getState().refresh();
    } catch (e) {
      Alert.alert('Could not start recording', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (): Promise<void> => {
    const { coordinator } = await getServices();
    await coordinator.discard();
    await useRecording.getState().refresh();
    router.back();
  };

  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Header title="Getting ready" onClose={() => void cancel()} />
      <View
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
        accessibilityLiveRegion="polite"
      >
        <Ionicons
          name={good ? 'checkmark-circle' : 'locate'}
          size={72}
          color={good ? colors.success : colors.warning}
        />
        <Text variant="heading" style={{ marginTop: spacing.lg }}>
          {good
            ? 'GPS ready'
            : snapshot.state.status === 'LOCATION_UNAVAILABLE'
              ? 'Location unavailable'
              : 'Acquiring GPS…'}
        </Text>
        <Text
          variant="bodySmall"
          color="secondary"
          align="center"
          style={{ marginTop: spacing.sm }}
        >
          {accuracy != null && accuracy >= 0
            ? `Accuracy ±${Math.round(accuracy)} m`
            : 'Waiting for the first fix. Open sky helps.'}
        </Text>
      </View>
      <Button
        label={good ? 'Start' : 'Start without a fix'}
        icon="play"
        size="lg"
        onPress={start}
        loading={busy}
        variant={good ? 'primary' : 'secondary'}
      />
      {!good ? (
        <Text variant="caption" color="secondary" align="center" style={{ marginTop: spacing.sm }}>
          Starting now records time immediately; distance begins once GPS locks on.
        </Text>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ active

function ActiveView({
  snapshot,
  onSaved,
}: {
  snapshot: LiveMetrics;
  onSaved: (s: SessionSummary) => void;
}) {
  const { colors, spacing, touchTarget } = useTheme();
  const router = useRouter();
  const units = useUnits();
  const invalidate = useInvalidateAll();
  const liveRoute = useRecording((s) => s.liveRoute);
  const sport = usePreferences((s) => s.prefs.lastSport);
  const [showMap, setShowMap] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = snapshot.state.status;
  const autoPaused = snapshot.state.status === 'RECORDING' && snapshot.state.autoPaused;
  const [config, setConfig] = useState<{
    sport: typeof sport;
    pool: boolean;
    triathlon: boolean;
  } | null>(null);

  // Read the activity's sport from storage (it may differ from prefs after crash recovery).
  const activityId = useRecording((s) => s.activityId);
  useEffect(() => {
    let cancelled = false;
    void getServices().then(async ({ activities }) => {
      const a = activityId ? await activities.getById(activityId) : null;
      const s = a?.sportType ?? sport;
      if (!cancelled)
        setConfig({ sport: s, pool: a?.swimMode === 'pool', triathlon: s === 'triathlon' });
    });
    return () => {
      cancelled = true;
    };
  }, [activityId, sport]);
  const activeSport = config?.sport ?? sport;
  const legSport = config?.triathlon
    ? (TRIATHLON_SEGMENTS[snapshot.legIndex]?.sport ?? null)
    : activeSport;
  const primary = legSport
    ? currentMetric(legSport, snapshot.currentPaceMsPerKm, snapshot.currentSpeedMps, units)
    : null;
  const average = legSport ? averageMetric(legSport, snapshot, units) : null;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await useRecording.getState().refresh();
    } catch (e) {
      reportError(e, { area: 'recording.command' });
      Alert.alert('Something went wrong', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const svc = () => getServices().then((s) => s.coordinator);

  const finish = (): void =>
    Alert.alert('Finish activity?', 'Your activity will be saved to your history.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'Finish & save',
        onPress: () =>
          void run(async () => {
            const summary = await (await svc()).finish();
            await invalidate();
            onSaved(summary);
          }),
      },
    ]);

  const discard = (): void =>
    Alert.alert(
      'Discard activity?',
      'This permanently deletes everything recorded in this session. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () =>
            void run(async () => {
              await (await svc()).discard();
              router.back();
            }),
        },
      ],
    );

  const addLengths = (): void =>
    Alert.prompt?.(
      'Add lengths',
      'How many pool lengths did you just swim?',
      (text) => {
        const n = Number.parseInt(text, 10);
        if (Number.isInteger(n) && n > 0 && n <= 400) void run(async () => (await svc()).lap(n));
      },
      'plain-text',
      '',
      'number-pad',
    );

  const nextLeg = TRIATHLON_SEGMENTS[snapshot.legIndex + 1];

  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: spacing.md,
        }}
      >
        <View
          style={{ flexDirection: 'row', alignItems: 'center' }}
          accessibilityLiveRegion="polite"
        >
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              marginRight: spacing.sm,
              backgroundColor:
                status === 'RECORDING' && !autoPaused ? colors.recording : colors.warning,
            }}
          />
          <Text variant="label">
            {status === 'RECORDING'
              ? autoPaused
                ? 'AUTO-PAUSED'
                : 'RECORDING'
              : status === 'PAUSED'
                ? 'PAUSED'
                : status === 'INTERRUPTED'
                  ? 'INTERRUPTED'
                  : status}
            {config?.triathlon ? ` · ${TRIATHLON_SEGMENTS[snapshot.legIndex]?.label ?? ''}` : ''}
          </Text>
        </View>
        <GpsBadge snapshot={snapshot} />
      </View>

      {status === 'INTERRUPTED' ? (
        <Banner
          tone="warning"
          message="Recording was interrupted (the app or phone was closed). Everything up to that point is saved."
        />
      ) : null}
      {status === 'FAILED' ? (
        <Banner
          tone="error"
          message={`Saving failed: ${snapshot.state.status === 'FAILED' ? snapshot.state.error : ''}. Your data is safe on this phone.`}
          action={{
            label: 'Retry',
            onPress: () =>
              void run(async () => {
                onSaved(await (await svc()).retrySave());
                await invalidate();
              }),
          }}
        />
      ) : null}
      {snapshot.gps.signalLost ? (
        <Banner
          tone="warning"
          message="GPS signal lost — time continues; distance resumes when the signal returns."
        />
      ) : null}

      <MetricTile label="Time" value={formatDuration(snapshot.movingMs)} size="xl" align="center" />
      <Text variant="caption" color="secondary" align="center">
        Elapsed {formatDuration(snapshot.elapsedMs)}
      </Text>
      <Row style={{ marginTop: spacing.xl }}>
        <MetricTile {...distanceMetric(snapshot.distanceMeters, units)} size="lg" align="center" />
        {primary ? <MetricTile {...primary} size="lg" align="center" /> : null}
      </Row>
      <Row style={{ marginTop: spacing.lg }}>
        {average ? <MetricTile {...average} size="sm" align="center" /> : null}
        <MetricTile
          {...elevationMetric(snapshot.elevationGainMeters, units, 'Climb')}
          size="sm"
          align="center"
        />
        <MetricTile
          label={config?.pool ? 'Laps' : 'Lap'}
          value={
            config?.pool ? String(snapshot.lapCount) : formatDuration(snapshot.currentLap.movingMs)
          }
          size="sm"
          align="center"
        />
      </Row>

      <View style={{ flex: 1, justifyContent: 'center' }}>
        {showMap ? <RouteMap segments={liveRoute} height={200} follow /> : null}
      </View>

      <Row gap={spacing.md} style={{ justifyContent: 'center', marginBottom: spacing.lg }}>
        {!config?.pool ? (
          <Chip
            label={showMap ? 'Hide map' : 'Show map'}
            selected={showMap}
            onPress={() => setShowMap(!showMap)}
          />
        ) : null}
        {config?.pool ? (
          <Chip label="+ lengths" selected={false} onPress={addLengths} />
        ) : getSport(activeSport).supportsManualLaps ? (
          <Chip
            label="Lap"
            selected={false}
            onPress={() => void run(async () => (await svc()).lap())}
          />
        ) : null}
        {config?.triathlon && nextLeg ? (
          <Chip
            label={`Next: ${nextLeg.label}`}
            selected={false}
            onPress={() => void run(async () => (await svc()).advanceLeg())}
          />
        ) : null}
      </Row>

      {status === 'RECORDING' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Pause recording"
          onPress={() => void run(async () => (await svc()).pause())}
          style={{
            alignSelf: 'center',
            width: touchTarget.record,
            height: touchTarget.record,
            borderRadius: touchTarget.record / 2,
            backgroundColor: colors.surfaceElevated,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="pause" size={40} color={colors.textPrimary} />
        </Pressable>
      ) : status === 'PAUSED' || status === 'INTERRUPTED' ? (
        <View style={{ gap: spacing.md }}>
          <Row>
            <Button
              label="Resume"
              icon="play"
              size="lg"
              style={{ flex: 1 }}
              onPress={() =>
                void run(async () =>
                  status === 'INTERRUPTED'
                    ? (await svc()).resumeInterrupted()
                    : (await svc()).resume(),
                )
              }
            />
            <Button
              label="Finish"
              icon="flag"
              size="lg"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={finish}
            />
          </Row>
          <Button label="Discard" variant="danger" onPress={discard} />
        </View>
      ) : null}
    </View>
  );
}

function GpsBadge({ snapshot }: { snapshot: LiveMetrics }) {
  const { colors, spacing } = useTheme();
  const q = snapshot.gps.quality;
  if (snapshot.gps.lastFixAt == null && q === 'none' && !snapshot.gps.signalLost) {
    return (
      <Text variant="caption" color="secondary">
        No GPS
      </Text>
    );
  }
  const color = {
    good: colors.success,
    fair: colors.warning,
    poor: colors.error,
    none: colors.textSecondary,
  }[q];
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center' }}
      accessible
      accessibilityLabel={`GPS ${q}`}
    >
      <Ionicons name="navigate" size={14} color={color} />
      <Text variant="caption" style={{ color, marginLeft: spacing.xxs }}>
        {q === 'none'
          ? 'GPS lost'
          : `GPS ${q}${snapshot.gps.lastAccuracyMeters != null ? ` ±${Math.round(snapshot.gps.lastAccuracyMeters)} m` : ''}`}
      </Text>
    </View>
  );
}

// ------------------------------------------------------------------ saved

function SavedView({ summary }: { summary: SessionSummary }) {
  const router = useRouter();
  const units = useUnits();
  const { spacing } = useTheme();
  const activityId = useRecording((s) => s.activityId);
  const done = async (openDetail: boolean): Promise<void> => {
    const { coordinator } = await getServices();
    coordinator.close();
    await useRecording.getState().refresh();
    router.back();
    if (openDetail && activityId)
      router.push({ pathname: '/activity/[id]', params: { id: activityId } });
  };
  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Text variant="title" accessibilityRole="header" style={{ marginTop: spacing.xl }}>
        Activity saved
      </Text>
      <Card style={{ marginTop: spacing.lg }}>
        <Row>
          <MetricTile {...distanceMetric(summary.metrics.distanceMeters, units)} />
          <MetricTile
            label="Moving time"
            value={formatDuration(summary.metrics.movingDurationMs)}
          />
        </Row>
        <Row style={{ marginTop: spacing.md }}>
          <MetricTile
            label="Elapsed"
            value={formatDuration(summary.metrics.elapsedDurationMs)}
            size="sm"
          />
          <MetricTile
            {...elevationMetric(summary.metrics.elevationGainMeters, units, 'Climb')}
            size="sm"
          />
        </Row>
      </Card>
      {!summary.quality.hasReliableTrack && summary.route.segments.length > 0 ? (
        <Banner
          tone="info"
          message="GPS quality was limited, so segment records were not calculated for this activity."
        />
      ) : null}
      <View style={{ flex: 1 }} />
      <Button label="View activity" size="lg" onPress={() => void done(true)} />
      <Button
        label="Done"
        variant="ghost"
        onPress={() => void done(false)}
        style={{ marginTop: spacing.md }}
      />
    </View>
  );
}

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: spacing.lg,
      }}
    >
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        hitSlop={16}
      >
        <Ionicons name="close" size={28} color={colors.textPrimary} />
      </Pressable>
    </View>
  );
}
