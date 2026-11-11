import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

type IconName = ComponentProps<typeof Ionicons>['name'];

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  accessibilityHint?: string;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading,
  disabled,
  style,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const { colors, radius, spacing, touchTarget } = useTheme();
  const bg = {
    primary: colors.primary,
    secondary: colors.surfaceElevated,
    ghost: 'transparent',
    danger: 'transparent',
  }[variant];
  const fg = {
    primary: colors.textOnPrimary,
    secondary: colors.textPrimary,
    ghost: colors.accent,
    danger: colors.error,
  }[variant];
  const isDisabled = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: variant === 'primary' && pressed ? colors.primaryPressed : bg,
          borderRadius: radius.md,
          minHeight: size === 'lg' ? touchTarget.large : touchTarget.min + 6,
          paddingHorizontal: spacing.xl,
          borderWidth: variant === 'danger' ? 1 : 0,
          borderColor: colors.error,
          opacity: isDisabled ? 0.45 : pressed && variant !== 'primary' ? 0.7 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.row}>
          {icon ? (
            <Ionicons name={icon} size={20} color={fg} style={{ marginRight: spacing.sm }} />
          ) : null}
          <Text variant="subheading" style={{ color: fg }}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
});
