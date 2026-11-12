import { Ionicons } from '@expo/vector-icons';
import type { PortableExportSummary } from '@pace/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Banner, Card, ListRow, ProgressBar, Screen, SectionHeader } from '@/components/layout';
import { shareBytes } from '@/services/backup-files';
import { getServices } from '@/services/container';
import { createPortableExport, shareExport } from '@/services/portability';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

type FullExport =
  | { state: 'idle' }
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; uri: string; summary: PortableExportSummary };

const INCLUDED = [
  'Every activity with all figures, laps, splits and triathlon legs',
  'Heart-rate, cadence and power data',
  'GPS tracks as GPX for Strava, Garmin Connect and other apps',
  'Goals, personal records, profile and preferences',
  'CSV tables for spreadsheets, and a README explaining each file',
];

export default function ExportSettings() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const privacyZone = usePreferences((s) => s.prefs.exportPrivacyZoneMeters);
  const [full, setFull] = useState<FullExport>({ state: 'idle' });
  const [csvBusy, setCsvBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportAll = async (): Promise<void> => {
    setError(null);
    setFull({ state: 'running', done: 0, total: 0 });
    try {
      const r = await createPortableExport(privacyZone, (done, total) =>
        setFull({ state: 'running', done, total }),
      );
      setFull({ state: 'done', ...r });
      await shareExport(r.uri);
    } catch (e) {
      setFull({ state: 'idle' });
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportCsv = async (): Promise<void> => {
    setCsvBusy(true);
    setError(null);
    try {
      const { activityService } = await getServices();
      const { fileName, content } = await activityService.exportCsv();
      await shareBytes(fileName, content, 'text/csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <Screen edges={[]}>
      {error ? <Banner tone="error" message={error} /> : null}

      <Card style={{ borderWidth: 1, borderColor: colors.divider, padding: spacing.xl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
          <Ionicons name="archive-outline" size={20} color={colors.accent} />
          <Text variant="heading" style={{ marginLeft: spacing.sm }}>
            Export everything
          </Text>
        </View>
        <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.md }}>
          One ZIP file with your complete training history, in open formats you can keep, read or
          take to another service.
        </Text>
        {INCLUDED.map((line) => (
          <View key={line} style={{ flexDirection: 'row', marginBottom: spacing.xs }}>
            <Ionicons name="checkmark" size={16} color={colors.accent} style={{ marginTop: 2 }} />
            <Text variant="bodySmall" style={{ flex: 1, marginLeft: spacing.sm }}>
              {line}
            </Text>
          </View>
        ))}

        <ListRow
          icon="eye-off-outline"
          label="Privacy zone"
          value={privacyZone > 0 ? `${privacyZone} m trimmed` : 'Off'}
          onPress={() => router.push('/settings/privacy')}
        />
        <Text
          variant="caption"
          color="secondary"
          style={{ marginTop: spacing.xs, marginBottom: spacing.lg }}
        >
          {privacyZone > 0
            ? `The first and last ${privacyZone} m of every GPS track are left out, so places like home are not revealed.`
            : 'GPS tracks are exported in full. Set a privacy zone to hide where activities start and end.'}{' '}
          No passwords or sign-in details are included.
        </Text>

        {full.state === 'running' ? (
          <View accessibilityLiveRegion="polite">
            <ProgressBar ratio={full.total > 0 ? full.done / full.total : 0} />
            <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
              {full.total > 0 ? `Preparing activity ${full.done} of ${full.total}…` : 'Preparing…'}
            </Text>
          </View>
        ) : (
          <Button
            label={full.state === 'done' ? 'Create a new export' : 'Create export'}
            icon="download-outline"
            size="lg"
            onPress={() => void exportAll()}
          />
        )}

        {full.state === 'done' ? (
          <View style={{ marginTop: spacing.lg }}>
            <Text variant="bodySmall">
              {full.summary.fileName} · {(full.summary.bytes / 1024 / 1024).toFixed(1)} MB
            </Text>
            <Text variant="caption" color="secondary">
              {full.summary.activities} activities · {full.summary.gpxFiles} GPS tracks
              {full.summary.withoutTrack > 0
                ? ` · ${full.summary.withoutTrack} without GPS (in data.json)`
                : ''}
            </Text>
            <Button
              label="Share again"
              icon="share-outline"
              variant="secondary"
              onPress={() =>
                void shareExport(full.uri).catch((e: unknown) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
              }
              style={{ marginTop: spacing.md }}
            />
          </View>
        ) : null}
      </Card>

      <SectionHeader title="Other exports" />
      <Card>
        <Text variant="subheading" style={{ marginBottom: spacing.xs }}>
          Activity summary (CSV)
        </Text>
        <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.md }}>
          One row per activity with distance, time, pace and elevation. Opens in Numbers, Excel or
          Google Sheets.
        </Text>
        <Button
          label="Export CSV"
          icon="document-text-outline"
          variant="secondary"
          onPress={() => void exportCsv()}
          loading={csvBusy}
        />
      </Card>
      <Card>
        <Text variant="subheading" style={{ marginBottom: spacing.xs }}>
          A single activity (GPX)
        </Text>
        <Text variant="bodySmall" color="secondary">
          Open any activity and choose “Export GPX”.
        </Text>
      </Card>
      <Card>
        <Text variant="subheading" style={{ marginBottom: spacing.xs }}>
          Moving to a new iPhone?
        </Text>
        <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.sm }}>
          Use an encrypted backup instead: it restores PACE exactly, including raw GPS data.
        </Text>
        <ListRow
          icon="cloud-upload-outline"
          label="Backup & restore"
          onPress={() => router.push('/settings/backup')}
        />
      </Card>
    </Screen>
  );
}
