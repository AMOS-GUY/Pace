import { Text } from '@/components/Text';
import { Card, Chip, Row, Screen, SectionHeader } from '@/components/layout';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

const ZONES = [0, 200, 500, 1000] as const;

export default function PrivacySettings() {
  const { spacing } = useTheme();
  const { prefs, update } = usePreferences();
  return (
    <Screen edges={[]}>
      <SectionHeader title="Export privacy zone" />
      <Card>
        <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.md }}>
          Hide the start and end of routes in exported GPX files so they don’t reveal where you live
          or work. Your stored activity is never changed.
        </Text>
        <Row gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
          {ZONES.map((z) => (
            <Chip
              key={z}
              label={z === 0 ? 'Off' : `${z} m`}
              selected={prefs.exportPrivacyZoneMeters === z}
              onPress={() => void update({ exportPrivacyZoneMeters: z })}
            />
          ))}
        </Row>
      </Card>

      <SectionHeader title="How PACE handles your data" />
      <Card>
        <Text variant="bodySmall" color="secondary">
          • Location is collected only while you record, with the iOS location indicator visible.
          {'\n'}• Activities are stored on this iPhone first. Nothing is shared with other users.
          {'\n'}• Cloud backups are encrypted on the device; PACE cannot read them.{'\n'}•
          Diagnostics never include GPS coordinates.{'\n'}• You can export everything, delete any
          activity, and delete your account at any time.
        </Text>
      </Card>
    </Screen>
  );
}
