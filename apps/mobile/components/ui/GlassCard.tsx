import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '@/constants/theme';

const TRANSPARENT_ACCENT = 'rgba(0, 0, 0, 0)';

export function GlassCard({
  children,
  style,
  accentColor,
  accentTransitionDurationMs = 240,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accentColor?: string;
  accentTransitionDurationMs?: number;
}) {
  const accentTransitionProgress = useSharedValue(1);
  const previousAccentColor = useSharedValue(accentColor ?? TRANSPARENT_ACCENT);
  const nextAccentColor = useSharedValue(accentColor ?? TRANSPARENT_ACCENT);

  useEffect(() => {
    const resolvedAccentColor = accentColor ?? TRANSPARENT_ACCENT;

    previousAccentColor.value = nextAccentColor.value;
    nextAccentColor.value = resolvedAccentColor;
    accentTransitionProgress.value = 0;
    accentTransitionProgress.value = withTiming(1, {
      duration: accentTransitionDurationMs,
      easing: Easing.out(Easing.cubic),
    });
  }, [accentColor, accentTransitionDurationMs, accentTransitionProgress, nextAccentColor, previousAccentColor]);

  const animatedAccentGlowStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(
        accentTransitionProgress.value,
        [0, 1],
        [previousAccentColor.value, nextAccentColor.value],
      ),
      opacity:
        (previousAccentColor.value === TRANSPARENT_ACCENT ? 0 : 0.12) +
        ((nextAccentColor.value === TRANSPARENT_ACCENT ? 0 : 0.12) -
          (previousAccentColor.value === TRANSPARENT_ACCENT ? 0 : 0.12)) *
          accentTransitionProgress.value,
    }),
    [accentTransitionProgress, nextAccentColor, previousAccentColor],
  );

  return (
    <LinearGradient
      colors={['rgba(15, 24, 39, 0.98)', 'rgba(8, 13, 22, 0.98)']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.card, style]}>
      <Animated.View pointerEvents="none" style={[styles.accentGlow, animatedAccentGlowStyle]} />
      <View style={styles.content}>{children}</View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  card: {
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.22,
    shadowRadius: 28,
  },
  accentGlow: {
    borderRadius: 48,
    height: 96,
    left: 24,
    position: 'absolute',
    top: -34,
    width: 96,
  },
  content: {
    padding: 16,
  },
});
