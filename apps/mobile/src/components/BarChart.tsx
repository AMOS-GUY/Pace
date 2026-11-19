import { useState } from 'react';
import { PixelRatio, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { type BarDatum, axisLabels } from '@/features/chart';
import { Text } from './Text';

export type { BarDatum };

/**
 * Lightweight bar chart built from Views (no extra native dependency). The latest bar is
 * highlighted; values are read from props only, so the chart can never show invented data.
 */
export function BarChart({
  data,
  height = 140,
  formatValue,
}: {
  data: readonly BarDatum[];
  height?: number;
  formatValue: (v: number) => string;
}) {
  const { colors, radius, spacing, typography } = useTheme();
  const [width, setWidth] = useState(0);
  const fontScale = PixelRatio.getFontScale();
  // Only the labels that fit are drawn (see axisLabels); the bars are unchanged.
  const labels = axisLabels(
    data.map((d) => d.label),
    width,
    spacing.xs,
    0.62 * typography.caption.fontSize * fontScale,
  );
  const max = Math.max(0, ...data.map((d) => d.value));
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={data.map((d) => d.description).join('. ')}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: spacing.xs }}>
        {data.map((d, i) => {
          const h = max > 0 ? Math.max(d.value > 0 ? 4 : 2, (d.value / max) * (height - 20)) : 2;
          const latest = i === data.length - 1;
          return (
            <View key={d.key} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
              {latest && d.value > 0 ? (
                <Text variant="caption" color="accent" numberOfLines={1}>
                  {formatValue(d.value)}
                </Text>
              ) : null}
              <View
                style={{
                  width: '70%',
                  height: h,
                  borderRadius: radius.sm,
                  backgroundColor: latest ? colors.primary : colors.surfaceElevated,
                }}
              />
            </View>
          );
        })}
      </View>
      <View
        style={{ height: typography.caption.lineHeight * fontScale, marginTop: spacing.xs }}
        importantForAccessibility="no-hide-descendants"
      >
        {labels.map((l) => (
          <Text
            key={data[l.index]!.key}
            variant="caption"
            color="secondary"
            align="center"
            style={{ position: 'absolute', left: l.left, width: l.width }}
            numberOfLines={1}
          >
            {data[l.index]!.label}
          </Text>
        ))}
      </View>
    </View>
  );
}
