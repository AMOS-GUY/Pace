import { Ionicons } from '@expo/vector-icons';
import type { ImportOutcome } from '@pace/core';
import type { SportType } from '@pace/domain';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Banner, Card, Chip, ProgressBar, Screen, SectionHeader } from '@/components/layout';
import { sportLabel } from '@/features/display';
import {
  groupOutcomes,
  importProgressRatio,
  outcomeName,
  skippedSummary,
} from '@/features/import-view';
import { useInvalidateAll } from '@/hooks/queries';
import { pickImportFiles } from '@/services/portability';
import { useImport } from '@/stores/import';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme/ThemeProvider';

const FALLBACK_SPORTS: ReadonlyArray<SportType> = ['running', 'cycling', 'walking', 'hiking'];
/** Long reports stay fast: each group shows this many rows, then a count. */
const ROWS_PER_GROUP = 40;

export default function ImportScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const invalidate = useInvalidateAll();
  const userId = useSession((s) => s.session?.user.id ?? null);
  const { status, progress, report, error, cancelRequested, start, cancel, reset } = useImport();
  const [fallback, setFallback] = useState<SportType | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const choose = async (): Promise<void> => {
    setPickError(null);
    try {
      const files = await pickImportFiles();
      if (!files || files.length === 0) return;
      await start(
        files,
        { userId, ...(fallback ? { fallbackSportType: fallback } : {}) },
        invalidate,
      );
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Import activities' }} />
      <Screen edges={['bottom']}>
        {status === 'idle' || status === 'error' ? (
          <>
            {error || pickError ? <Banner tone="error" message={error ?? pickError!} /> : null}
            <Text variant="title" accessibilityRole="header">
              Bring your history
            </Text>
            <Text
              variant="body"
              color="secondary"
              style={{ marginTop: spacing.xs, marginBottom: spacing.lg }}
            >
              Import activities from Garmin, Strava, Komoot or any app that exports FIT, GPX or TCX.
              Everything is processed on this iPhone.
            </Text>
            <Card style={{ borderWidth: 1, borderColor: colors.divider }}>
              <Supported
                icon="document-outline"
                title="FIT, GPX and TCX files"
                detail="Tracks, laps, pauses, heart rate, cadence and power; FIT triathlons with every leg"
              />
              <Supported
                icon="file-tray-full-outline"
                title="ZIP archives and .gz files"
                detail="Whole account exports — choose the ZIP as it is"
              />
              <Supported
                icon="copy-outline"
                title="Duplicates are skipped"
                detail="Import the same export again safely"
              />
              <Supported
                icon="alert-circle-outline"
                title="Not yet: indoor sessions without GPS"
                detail="Treadmill, trainer and pool files are listed in the report with the reason"
                muted
              />
            </Card>

            <SectionHeader title="Files without a sport" />
            <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.sm }}>
              Some files do not say which sport they are. Choose one to use for them, or leave them
              out and import them later.
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.lg }}
            >
              <Chip
                label="Leave out"
                selected={fallback === null}
                onPress={() => setFallback(null)}
              />
              {FALLBACK_SPORTS.map((s) => (
                <Chip
                  key={s}
                  label={sportLabel(s)}
                  selected={fallback === s}
                  onPress={() => setFallback(s)}
                />
              ))}
            </ScrollView>

            <Button
              label="Choose files"
              icon="folder-open-outline"
              size="lg"
              onPress={() => void choose()}
            />
            <Text
              variant="caption"
              color="secondary"
              align="center"
              style={{ marginTop: spacing.md }}
            >
              You can select several files at once.
            </Text>
          </>
        ) : null}

        {status === 'running' ? (
          <View accessibilityLiveRegion="polite">
            <Text variant="title" accessibilityRole="header">
              Importing…
            </Text>
            <Text
              variant="bodySmall"
              color="secondary"
              numberOfLines={1}
              style={{ marginTop: spacing.xs, marginBottom: spacing.lg }}
            >
              {progress
                ? `${progress.fileCount > 1 ? `File ${progress.fileIndex} of ${progress.fileCount} · ` : ''}${progress.file}`
                : 'Opening files…'}
            </Text>
            <ProgressBar ratio={importProgressRatio(progress)} />
            <Text
              variant="caption"
              color="secondary"
              numberOfLines={1}
              style={{ marginTop: spacing.sm }}
            >
              {progress?.current ? outcomeName(progress.current) : ' '}
            </Text>
            <Counts
              imported={progress?.imported ?? 0}
              duplicates={progress?.duplicates ?? 0}
              needsSport={progress?.needsSport ?? 0}
              failed={progress?.failed ?? 0}
            />
            <Button
              label={cancelRequested ? 'Stopping after this file…' : 'Cancel'}
              variant="secondary"
              onPress={cancel}
              disabled={cancelRequested}
              style={{ marginTop: spacing.xl }}
            />
            <Text
              variant="caption"
              color="secondary"
              align="center"
              style={{ marginTop: spacing.sm }}
            >
              Activities imported so far are kept. You can leave this screen; the import continues.
            </Text>
          </View>
        ) : null}

        {status === 'done' && report ? (
          <>
            <Text variant="title" accessibilityRole="header">
              {report.cancelled ? 'Import stopped' : 'Import finished'}
            </Text>
            <Text variant="bodySmall" color="secondary" style={{ marginTop: spacing.xs }}>
              {report.imported === 0 && report.duplicates > 0 && report.failed === 0
                ? 'Everything in these files is already in PACE.'
                : `${report.imported} new ${report.imported === 1 ? 'activity' : 'activities'} added to your history.`}
            </Text>
            <Counts
              imported={report.imported}
              duplicates={report.duplicates}
              needsSport={report.needsSport}
              failed={report.failed}
            />
            {report.sourceErrors.map((e) => (
              <Banner
                key={e.file}
                tone="warning"
                message={`${e.file}: ${e.message}. Activities read before this point were imported.`}
              />
            ))}
            {report.cancelled ? (
              <Banner
                tone="info"
                message="Stopped before the end. Import the same files again to continue; activities already imported are skipped."
              />
            ) : null}
            <ReportGroups
              outcomes={report.outcomes}
              onOpen={(id) => router.push({ pathname: '/activity/[id]', params: { id } })}
            />
            {report.skipped.count > 0 ? (
              <Card>
                <Text variant="bodySmall" color="secondary">
                  {skippedSummary(report.skipped)}
                </Text>
              </Card>
            ) : null}
            <Button
              label="View activities"
              icon="list-outline"
              size="lg"
              onPress={() => {
                reset();
                router.replace('/(tabs)/activities');
              }}
              style={{ marginTop: spacing.lg }}
            />
            <Button
              label="Import more files"
              variant="ghost"
              onPress={reset}
              style={{ marginTop: spacing.sm }}
            />
          </>
        ) : null}
      </Screen>
    </>
  );
}

function Supported({
  icon,
  title,
  detail,
  muted,
}: {
  icon: 'document-outline' | 'file-tray-full-outline' | 'copy-outline' | 'alert-circle-outline';
  title: string;
  detail: string;
  muted?: boolean;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm }}>
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: muted ? colors.surfaceElevated : colors.primaryMuted,
        }}
      >
        <Ionicons name={icon} size={18} color={muted ? colors.textSecondary : colors.accent} />
      </View>
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text variant="subheading">{title}</Text>
        <Text variant="caption" color="secondary">
          {detail}
        </Text>
      </View>
    </View>
  );
}

function Counts(c: { imported: number; duplicates: number; needsSport: number; failed: number }) {
  const { colors, radius, spacing } = useTheme();
  const items = [
    { label: 'Imported', value: c.imported, color: colors.accent },
    { label: 'Already in PACE', value: c.duplicates, color: colors.textSecondary },
    { label: 'Need a sport', value: c.needsSport, color: colors.warning },
    { label: 'Failed', value: c.failed, color: c.failed > 0 ? colors.error : colors.textSecondary },
  ];
  return (
    <View
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg }}
    >
      {items.map((i) => (
        <View
          key={i.label}
          accessible
          accessibilityLabel={`${i.label}: ${i.value}`}
          style={{
            flexBasis: '47%',
            flexGrow: 1,
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            padding: spacing.md,
          }}
        >
          <Text variant="metric" style={{ color: i.color }}>
            {i.value}
          </Text>
          <Text variant="caption" color="secondary">
            {i.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ReportGroups({
  outcomes,
  onOpen,
}: {
  outcomes: readonly ImportOutcome[];
  onOpen: (id: string) => void;
}) {
  const groups = groupOutcomes(outcomes);
  return (
    <>
      {groups.map((g) => (
        <View key={g.status}>
          <SectionHeader title={`${g.title} · ${g.items.length}`} />
          <Card>
            {g.items.slice(0, ROWS_PER_GROUP).map((o, i) => (
              <OutcomeRow key={`${o.file}:${o.entry ?? ''}:${i}`} outcome={o} onOpen={onOpen} />
            ))}
            {g.items.length > ROWS_PER_GROUP ? (
              <Text variant="caption" color="secondary">
                and {g.items.length - ROWS_PER_GROUP} more
              </Text>
            ) : null}
          </Card>
        </View>
      ))}
    </>
  );
}

function OutcomeRow({
  outcome: o,
  onOpen,
}: {
  outcome: ImportOutcome;
  onOpen: (id: string) => void;
}) {
  const { colors, spacing } = useTheme();
  const [open, setOpen] = useState(false);
  const target = o.activityId ?? o.existingActivityId;
  const detail =
    o.message ??
    (o.warnings.length ? `${o.warnings.length} note${o.warnings.length > 1 ? 's' : ''}` : null);
  return (
    <View
      style={{
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.divider,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityHint={
          target ? 'Opens the activity' : o.warnings.length ? 'Shows the notes' : undefined
        }
        disabled={!target && o.warnings.length === 0}
        onPress={() => (target ? onOpen(target) : setOpen((v) => !v))}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <View style={{ flex: 1 }}>
          <Text variant="body" numberOfLines={1}>
            {outcomeName(o.entry ?? o.file)}
          </Text>
          {detail ? (
            <Text variant="caption" color="secondary">
              {detail}
            </Text>
          ) : null}
        </View>
        {target ? <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} /> : null}
      </Pressable>
      {o.warnings.length > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => setOpen((v) => !v)} hitSlop={8}>
          <Text variant="caption" color="accent" style={{ marginTop: spacing.xs }}>
            {open
              ? 'Hide notes'
              : `Show ${o.warnings.length} note${o.warnings.length > 1 ? 's' : ''}`}
          </Text>
        </Pressable>
      ) : null}
      {open
        ? o.warnings.map((w) => (
            <Text key={w} variant="caption" color="secondary" style={{ marginTop: spacing.xs }}>
              • {w}
            </Text>
          ))
        : null}
    </View>
  );
}
