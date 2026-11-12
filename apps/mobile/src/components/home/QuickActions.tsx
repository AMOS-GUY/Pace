import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/Text';
import { useTheme } from '@/theme/ThemeProvider';

type IconName = ComponentProps<typeof Ionicons>['name'];

export interface QuickAction {
  key: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  /** The primary action is filled with the brand colour; the rest are quiet. */
  primary?: boolean;
  accessibilityLabel?: string;
}

/** One row of equally sized shortcuts. Keeps every target at least 44 pt. */
export function QuickActions({ actions }: { actions: readonly QuickAction[] }) {
  const { colors, radius, spacing, touchTarget } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl }}>
      {actions.map((a) => (
        <Pressable
          key={a.key}
          accessibilityRole="button"
          accessibilityLabel={a.accessibilityLabel ?? a.label}
          onPress={a.onPress}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: touchTarget.large + spacing.lg,
            borderRadius: radius.lg,
            paddingVertical: spacing.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: a.primary
              ? pressed
                ? colors.primaryPressed
                : colors.primary
              : colors.surface,
            borderWidth: a.primary ? 0 : 1,
            borderColor: colors.divider,
            opacity: !a.primary && pressed ? 0.7 : 1,
          })}
        >
          <Ionicons
            name={a.icon}
            size={22}
            color={a.primary ? colors.textOnPrimary : colors.accent}
          />
          <Text
            variant="label"
            color={a.primary ? 'onPrimary' : 'primary'}
            numberOfLines={1}
            style={{ marginTop: spacing.xs }}
          >
            {a.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
