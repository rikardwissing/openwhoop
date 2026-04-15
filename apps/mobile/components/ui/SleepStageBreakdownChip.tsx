import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function SleepStageBreakdownChip({
  accentColor,
  label,
  onPress,
  selected = false,
  value,
}: {
  accentColor: string;
  label: string;
  onPress: () => void;
  selected?: boolean;
  value: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? `${accentColor}18` : colors.surfaceMuted,
          borderColor: selected ? `${accentColor}55` : `${accentColor}33`,
        },
        pressed ? styles.chipPressed : null,
      ]}>
      <View style={styles.left}>
        <View style={[styles.dot, { backgroundColor: accentColor }]} />
        <Text style={styles.label}>{label}</Text>
      </View>
      <Text style={styles.value}>{value}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 16,
    borderWidth: 1,
    flexBasis: '48%',
    flexDirection: 'row',
    flexGrow: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chipPressed: {
    opacity: 0.82,
  },
  dot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  label: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  left: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  value: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
});