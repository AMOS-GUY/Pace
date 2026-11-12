import type { MeasurementSystem, Split, SportType } from '@pace/domain';
import {
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  paceUnitLabel,
  speedUnitLabel,
} from '@pace/domain';
import { getSport } from '@pace/sports';
import { View } from 'react-native';
import { splitBars } from '@/features/activity-view';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

/**
 * Splits as horizontal bars scaled to the fastest split (highlighted). Each row carries its
 * own accessible description; a split without a measured pace shows "—" and no bar.
 */
export function SplitChart({
  splits,
  sport,
  units,
  showElevation,
}: {
  splits: readonly Split[];
  sport: SportType;
  units: MeasurementSystem;
  showElevation: boolean;
}) {
  const { colors, radius, spacing } = useTheme();
  const bars = splitBars(splits, sport);
  const bySpeed = getSport(sport).primaryMetric === 'speed';
  const unit = bySpeed ? speedUnitLabel(units) : paceUnitLabel(units);
  return (
    <View>
      <View style={{ flexDirection: 'row', marginBottom: spacing.sm }}>
        <Text variant="caption" color="secondary" style={{ width: 44 }}>
          #
        </Text>
        <Text variant="caption" color="secondary" style={{ flex: 1 }}>
          {bySpeed ? `Speed (${unit})` : `Pace (${unit})`}
        </Text>
        <Text variant="caption" color="secondary" style={{ width: 64, textAlign: 'right' }}>
          Time
        </Text>
        {showElevation ? (
          <Text variant="caption" color="secondary" style={{ width: 48, textAlign: 'right' }}>
            Elev
          </Text>
        ) : null}
      </View>
      {splits.map((s, i) => {
        const bar = bars[i]!;
        const value = bySpeed ? formatSpeed(s.speedMps, units) : formatPace(s.paceMsPerKm, units);
        const elev = formatElevation(s.elevationGainMeters, units);
        return (
          <View
            key={s.index}
            accessible
            accessibilityLabel={`Split ${s.index + 1}${s.isPartial ? ', partial' : ''}: ${value} ${unit}, ${formatDuration(s.movingDurationMs)}${showElevation ? `, ${elev} ${units === 'metric' ? 'metres' : 'feet'} climbed` : ''}${bar.fastest ? ', fastest split' : ''}`}
            style={{ flexDirection: 'row', alignItems: 'center', minHeight: 32 }}
          >
            <Text variant="bodySmall" color="secondary" style={{ width: 44 }}>
              {s.index + 1}
              {s.isPartial ? '*' : ''}
            </Text>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1, height: 18, justifyContent: 'center' }}>
                {bar.ratio != null ? (
                  <View
                    style={{
                      width: `${Math.max(6, bar.ratio * 100)}%`,
                      height: 18,
                      borderRadius: radius.sm,
                      backgroundColor: bar.fastest ? colors.primary : colors.surfaceElevated,
                    }}
                  />
                ) : null}
              </View>
              <Text
                variant="bodySmall"
                style={{ width: 52, textAlign: 'right', fontVariant: ['tabular-nums'] }}
              >
                {value}
              </Text>
            </View>
            <Text
              variant="bodySmall"
              color="secondary"
              style={{ width: 64, textAlign: 'right', fontVariant: ['tabular-nums'] }}
            >
              {formatDuration(s.movingDurationMs)}
            </Text>
            {showElevation ? (
              <Text
                variant="bodySmall"
                color="secondary"
                style={{ width: 48, textAlign: 'right', fontVariant: ['tabular-nums'] }}
              >
                {elev}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
