import { Ionicons } from '@expo/vector-icons';
import { SPORT_TYPES, type SportType } from '@pace/domain';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Screen } from '@/components/layout';
import { sportIcon, sportLabel } from '@/features/display';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

export default function OnboardingSports() {
  const router = useRouter();
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  const { profile, saveProfile, update } = usePreferences();
  const { colors, radius, spacing } = useTheme();
  const [selected, setSelected] = useState<SportType[]>(profile?.preferredSports ?? []);

  const toggle = (s: SportType): void =>
    setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const next = async (): Promise<void> => {
    if (profile) await saveProfile({ ...profile, preferredSports: selected });
    if (selected[0]) await update({ lastSport: selected[0] });
    if (edit) router.back();
    else router.push('/(onboarding)/units');
  };

  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 96 }}>
      {edit ? null : (
        <Text variant="label" color="accent">
          STEP 2 OF 4
        </Text>
      )}
      <Text variant="title" accessibilityRole="header" style={{ marginVertical: 12 }}>
        What do you train?
      </Text>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing.md,
          marginBottom: spacing.xl,
        }}
      >
        {SPORT_TYPES.map((s) => {
          const on = selected.includes(s);
          return (
            <Pressable
              key={s}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={sportLabel(s)}
              onPress={() => toggle(s)}
              style={{
                width: '47%',
                minHeight: 88,
                borderRadius: radius.lg,
                padding: spacing.lg,
                justifyContent: 'space-between',
                backgroundColor: on ? colors.surfaceElevated : colors.surface,
                borderWidth: 2,
                borderColor: on ? colors.primary : 'transparent',
              }}
            >
              <Ionicons
                name={sportIcon(s) as never}
                size={26}
                color={on ? colors.accent : colors.textSecondary}
              />
              <Text variant="subheading">{sportLabel(s)}</Text>
            </Pressable>
          );
        })}
      </View>
      <Button label={edit ? 'Save' : 'Continue'} size="lg" onPress={next} />
    </Screen>
  );
}
