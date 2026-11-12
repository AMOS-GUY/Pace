import { Ionicons } from '@expo/vector-icons';
import type { SportType } from '@pace/domain';
import { View } from 'react-native';
import { sportIcon } from '@/features/display';
import { useTheme } from '@/theme/ThemeProvider';

/** Sport icon on a tinted circle — the one visual marker for a sport across the app. */
export function SportBadge({ sport, size = 40 }: { sport: SportType; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.primaryMuted,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name={sportIcon(sport) as never} size={size * 0.5} color={colors.accent} />
    </View>
  );
}
