import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  Switch,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import { Button } from './Button';
import { Text } from './Text';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function Screen({
  children,
  scroll = true,
  edges = ['top'],
  contentStyle,
  refreshControl,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  contentStyle?: ViewStyle;
  refreshControl?: ScrollViewProps['refreshControl'];
}) {
  const { colors, spacing } = useTheme();
  const padding = { padding: spacing.lg, paddingBottom: spacing.xxxl };
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: colors.background }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[padding, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, padding, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { colors, radius, spacing } = useTheme();
  const base: ViewStyle = {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [base, { opacity: pressed ? 0.8 : 1 }, style]}
    >
      {children}
    </Pressable>
  );
}

export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.rowBetween, { marginTop: spacing.xl, marginBottom: spacing.sm }]}>
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={12}>
          <Text variant="label" color="accent">
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function MetricTile({
  label,
  value,
  unit,
  size = 'md',
  align = 'left',
}: {
  label: string;
  value: string;
  unit?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  align?: 'left' | 'center';
}) {
  const variant =
    size === 'xl'
      ? 'display'
      : size === 'lg'
        ? 'metricLarge'
        : size === 'md'
          ? 'metric'
          : 'metricSmall';
  return (
    <View
      style={{ flex: 1, alignItems: align === 'center' ? 'center' : 'flex-start' }}
      accessible
      accessibilityLabel={`${label} ${value} ${unit ?? ''}`}
    >
      <Text variant="label" color="secondary">
        {label.toUpperCase()}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Text variant={variant}>{value}</Text>
        {unit ? (
          <Text variant="label" color="secondary" style={{ marginLeft: 4 }}>
            {unit}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function Row({
  children,
  gap = 12,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: ViewStyle;
}) {
  return <View style={[{ flexDirection: 'row', gap }, style]}>{children}</View>;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.center, { padding: spacing.xxl }]} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.accent} />
      <Text variant="bodySmall" color="secondary" style={{ marginTop: spacing.sm }}>
        {label}
      </Text>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: IconName;
  title: string;
  message: string;
  action?: { label: string; onPress: () => void };
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.center, { padding: spacing.xxl }]}>
      <Ionicons name={icon} size={40} color={colors.textSecondary} />
      <Text variant="subheading" align="center" style={{ marginTop: spacing.md }}>
        {title}
      </Text>
      <Text
        variant="bodySmall"
        color="secondary"
        align="center"
        style={{ marginTop: spacing.xs, marginBottom: spacing.lg }}
      >
        {message}
      </Text>
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" /> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.center, { padding: spacing.xxl }]} accessibilityRole="alert">
      <Ionicons name="alert-circle-outline" size={36} color={colors.error} />
      <Text
        variant="bodySmall"
        color="secondary"
        align="center"
        style={{ marginVertical: spacing.md }}
      >
        {message}
      </Text>
      {onRetry ? <Button label="Try again" onPress={onRetry} variant="secondary" /> : null}
    </View>
  );
}

export function Banner({
  tone,
  message,
  action,
}: {
  tone: 'info' | 'warning' | 'error' | 'success';
  message: string;
  action?: { label: string; onPress: () => void };
}) {
  const { colors, radius, spacing } = useTheme();
  const color = {
    info: colors.accent,
    warning: colors.warning,
    error: colors.error,
    success: colors.success,
  }[tone];
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: color,
        padding: spacing.md,
        marginBottom: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <Text variant="bodySmall" style={{ flex: 1 }}>
        {message}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          hitSlop={12}
          style={{ marginLeft: spacing.md }}
        >
          <Text variant="label" style={{ color }}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ListRow({
  icon,
  label,
  value,
  onPress,
  disabled,
  destructive,
  right,
}: {
  icon?: IconName;
  label: string;
  value?: string;
  onPress?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  right?: ReactNode;
}) {
  const { colors, spacing, touchTarget } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.rowBetween,
        {
          minHeight: touchTarget.min + 8,
          paddingVertical: spacing.sm,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.divider,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
        {icon ? (
          <Ionicons
            name={icon}
            size={20}
            color={destructive ? colors.error : colors.textSecondary}
            style={{ marginRight: spacing.md }}
          />
        ) : null}
        <Text variant="body" color={destructive ? 'error' : 'primary'}>
          {label}
        </Text>
      </View>
      {right ?? (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {value ? (
            <Text variant="bodySmall" color="secondary" style={{ marginRight: spacing.xs }}>
              {value}
            </Text>
          ) : null}
          {onPress && !disabled ? (
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

export function ToggleRow({
  label,
  value,
  onValueChange,
  hint,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  hint?: string;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        paddingVertical: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.divider,
      }}
    >
      <View style={styles.rowBetween}>
        <Text variant="body" style={{ flex: 1 }}>
          {label}
        </Text>
        <Switch
          accessibilityLabel={label}
          value={value}
          onValueChange={onValueChange}
          trackColor={{ true: colors.primary, false: colors.divider }}
        />
      </View>
      {hint ? (
        <Text variant="caption" color="secondary" style={{ marginTop: spacing.xs }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        paddingHorizontal: spacing.lg,
        minHeight: 36,
        justifyContent: 'center',
        borderRadius: radius.pill,
        backgroundColor: selected ? colors.primary : colors.surface,
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.divider,
      }}
    >
      <Text variant="label" color={selected ? 'onPrimary' : 'primary'}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        padding: spacing.xxs,
        marginBottom: spacing.md,
      }}
    >
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: o.value === value }}
          onPress={() => onChange(o.value)}
          style={{
            flex: 1,
            minHeight: 36,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.sm,
            backgroundColor: o.value === value ? colors.surfaceElevated : 'transparent',
          }}
        >
          <Text variant="label" color={o.value === value ? 'primary' : 'secondary'}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ProgressBar({ ratio, color }: { ratio: number; color?: string }) {
  const { colors, radius } = useTheme();
  const pct = Math.max(0, Math.min(1, ratio));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
      style={{
        height: 8,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceElevated,
        overflow: 'hidden',
      }}
    >
      <View
        style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: color ?? colors.primary }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
