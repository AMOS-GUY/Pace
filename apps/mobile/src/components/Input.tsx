import { useState } from 'react';
import { TextInput, type TextInputProps, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface InputProps extends TextInputProps {
  label: string;
  error?: string | null;
  hint?: string;
}

export function Input({ label, error, hint, style, ...rest }: InputProps) {
  const { colors, radius, spacing, typography } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text variant="label" color="secondary" style={{ marginBottom: spacing.xs }}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.accent}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        {...rest}
        style={[
          {
            minHeight: 50,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: error ? colors.error : focused ? colors.primary : colors.divider,
            backgroundColor: colors.surface,
            color: colors.textPrimary,
            paddingHorizontal: spacing.lg,
            fontFamily: typography.body.fontFamily,
            fontSize: typography.body.fontSize,
          },
          style,
        ]}
      />
      {error ? (
        <Text
          variant="caption"
          color="error"
          style={{ marginTop: spacing.xs }}
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" color="secondary" style={{ marginTop: spacing.xs }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
