import { type ReactNode, useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Subtle entrance (fade + 8 pt rise) for dashboard sections, staggered by `index`. Skipped when
 * the user has enabled Reduce Motion. Uses the built-in Animated API on the native driver.
 */
export function FadeIn({ children, index = 0 }: { children: ReactNode; index?: number }) {
  const { motion } = useTheme();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) {
        progress.setValue(1);
        return;
      }
      Animated.timing(progress, {
        toValue: 1,
        duration: motion.slow,
        delay: index * 60,
        useNativeDriver: true,
      }).start();
    });
    return () => {
      cancelled = true;
    };
  }, [index, motion.slow, progress]);

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
