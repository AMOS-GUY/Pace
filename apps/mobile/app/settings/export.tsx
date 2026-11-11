import { useState } from 'react';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Banner, Card, Screen } from '@/components/layout';
import { shareBytes } from '@/services/backup-files';
import { getServices } from '@/services/container';
import { useTheme } from '@/theme/ThemeProvider';

export default function ExportSettings() {
  const { spacing } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportCsv = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { activityService } = await getServices();
      const { fileName, content } = await activityService.exportCsv();
      await shareBytes(fileName, content, 'text/csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={[]}>
      {error ? <Banner tone="error" message={error} /> : null}
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
          onPress={() => void exportCsv()}
          loading={busy}
        />
      </Card>
      <Card>
        <Text variant="subheading" style={{ marginBottom: spacing.xs }}>
          Individual activities (GPX)
        </Text>
        <Text variant="bodySmall" color="secondary">
          Open any activity and choose “Export GPX” to share a file that Strava, Garmin Connect and
          other apps can read.
        </Text>
      </Card>
      <Card>
        <Text variant="subheading" style={{ marginBottom: spacing.xs }}>
          Everything
        </Text>
        <Text variant="bodySmall" color="secondary">
          A full backup file (Profile → Backup & restore) contains every activity with its raw GPS
          data.
        </Text>
      </Card>
    </Screen>
  );
}
