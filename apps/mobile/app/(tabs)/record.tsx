import { Ionicons } from '@expo/vector-icons';
import { SPORT_TYPES } from '@pace/domain';
import { useRouter } from 'expo-router';
import { isTrackingAvailable } from 'pace-tracking';
import { Pressable, View } from 'react-native';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Banner, Card, Screen } from '@/components/layout';
import { sportIcon, sportLabel } from '@/features/display';
import { usePreferences } from '@/stores/preferences';
import { useRecording } from '@/stores/recording';
import { useTheme } from '@/theme/ThemeProvider';

/** Record tab: choose a sport and open the full-screen recorder. */
export default function Record() {
  const router = useRouter();
  const { prefs, update } = usePreferences();
  const snapshot = useRecording((s) => s.snapshot);
  const { colors, radius, spacing } = useTheme();
  const active = snapshot && snapshot.state.status !== 'READY' && snapshot.state.status !== 'SAVED';

  return (
    <Screen>
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: spacing.lg }}>
        Record
      </Text>
      {active ? (
        <Banner
          tone="info"
          message="A recording is in progress."
          action={{ label: 'Open', onPress: () => router.push('/recording') }}
        />
      ) : null}
      {!isTrackingAvailable() ? (
        <Banner
          tone="warning"
          message="GPS recording needs the PACE development build. Pool swims can still be recorded."
        />
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing.md,
          marginBottom: spacing.xl,
        }}
      >
        {SPORT_TYPES.map((s) => {
          const on = prefs.lastSport === s;
          return (
            <Pressable
              key={s}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={sportLabel(s)}
              onPress={() => void update({ lastSport: s })}
              style={{
                width: '30%',
                aspectRatio: 1,
                borderRadius: radius.lg,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: on ? colors.surfaceElevated : colors.surface,
                borderWidth: 2,
                borderColor: on ? colors.primary : 'transparent',
              }}
            >
              <Ionicons
                name={sportIcon(s) as never}
                size={30}
                color={on ? colors.accent : colors.textSecondary}
              />
              <Text variant="label" style={{ marginTop: spacing.xs }}>
                {sportLabel(s)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Button
        label={`Start ${sportLabel(prefs.lastSport)}`}
        icon="play"
        size="lg"
        onPress={() => router.push('/recording')}
      />
      <Card style={{ marginTop: spacing.xl }}>
        <Text variant="bodySmall" color="secondary">
          Recording continues with the screen locked. Every GPS point is saved on this phone as it
          is captured, so an interruption never loses your activity.
        </Text>
      </Card>
    </Screen>
  );
}
