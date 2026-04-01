import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/constants/theme';

export function GlassCard({
  children,
  style,
  accentColor,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accentColor?: string;
}) {
  return (
    <LinearGradient
      colors={['rgba(15, 24, 39, 0.98)', 'rgba(8, 13, 22, 0.98)']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.card, style]}>
      {accentColor ? <View style={[styles.accentGlow, { backgroundColor: accentColor }]} /> : null}
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
    height: 96,
    left: 24,
    opacity: 0.12,
    position: 'absolute',
    top: -34,
    width: 96,
    borderRadius: 48,
  },
  content: {
    padding: 16,
  },
});
