import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/Text';
import { greeting } from '@/features/display';
import { initials, longDate } from '@/features/dashboard-view';
import { useTheme } from '@/theme/ThemeProvider';

/** Date, greeting and the avatar that opens Profile & settings. */
export function HomeHeader({
  name,
  now,
  onOpenProfile,
}: {
  name: string | null | undefined;
  now: Date;
  onOpenProfile: () => void;
}) {
  const { colors, spacing, touchTarget } = useTheme();
  const letters = initials(name);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.xl,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text variant="label" color="secondary">
          {longDate(now).toUpperCase()}
        </Text>
        <Text variant="title" accessibilityRole="header" numberOfLines={1}>
          {greeting(now)}
          {name ? `, ${name.trim().split(/\s+/)[0]}` : ''}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Profile and settings"
        onPress={onOpenProfile}
        hitSlop={8}
        style={({ pressed }) => ({
          width: touchTarget.min,
          height: touchTarget.min,
          borderRadius: touchTarget.min / 2,
          backgroundColor: colors.surfaceElevated,
          borderWidth: 1,
          borderColor: colors.divider,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {letters ? (
          <Text variant="subheading">{letters}</Text>
        ) : (
          <Ionicons name="person-outline" size={20} color={colors.textPrimary} />
        )}
      </Pressable>
    </View>
  );
}
