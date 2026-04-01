import { StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function StatChip({
  label,
  value,
  accent = colors.primary,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <View style={[styles.chip, { borderColor: `${accent}33` }]}>
      <View style={[styles.dot, { backgroundColor: accent }]} />
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  dot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  label: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
  },
  value: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
});
