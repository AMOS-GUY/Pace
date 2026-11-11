import type { TypographyVariant } from '@pace/design-system';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

export interface TextProps extends RNTextProps {
  variant?: TypographyVariant;
  color?: 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'error' | 'onPrimary';
  align?: TextStyle['textAlign'];
}

export function Text({ variant = 'body', color = 'primary', align, style, ...rest }: TextProps) {
  const { typography, colors } = useTheme();
  const t = typography[variant];
  const palette = {
    primary: colors.textPrimary,
    secondary: colors.textSecondary,
    accent: colors.accent,
    success: colors.success,
    warning: colors.warning,
    error: colors.error,
    onPrimary: colors.textOnPrimary,
  } as const;
  return (
    <RNText
      maxFontSizeMultiplier={variant.startsWith('metric') || variant === 'display' ? 1.3 : 2}
      {...rest}
      style={[
        {
          fontFamily: t.fontFamily,
          fontSize: t.fontSize,
          lineHeight: t.lineHeight,
          letterSpacing: 'letterSpacing' in t ? t.letterSpacing : undefined,
          fontVariant: 'tabular' in t && t.tabular ? ['tabular-nums'] : undefined,
          color: palette[color],
          textAlign: align,
        },
        style,
      ]}
    />
  );
}
