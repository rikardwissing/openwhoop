import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function StatChip({
  label,
  value,
  accent = colors.primary,
  style,
}: {
  label: string;
  value: string;
  accent?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.chip, { borderColor: `${accent}33` }, style]}>
      <View style={[styles.dot, { backgroundColor: accent }]} />
      <Text numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      <Text ellipsizeMode="tail" numberOfLines={1} style={styles.value}>
        {value}
      </Text>
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
    flexShrink: 1,
    gap: 8,
    maxWidth: '100%',
    minWidth: 0,
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
    flexShrink: 1,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    minWidth: 0,
  },
});
