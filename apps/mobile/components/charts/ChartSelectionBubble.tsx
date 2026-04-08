import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function ChartSelectionBubble({
  accentColor,
  detail,
  label,
  size = 'regular',
  style,
  testID,
  value,
}: {
  accentColor: string;
  detail?: string;
  label: string;
  size?: 'compact' | 'regular';
  style?: StyleProp<ViewStyle>;
  testID?: string;
  value: string;
}) {
  const isCompact = size === 'compact';

  return (
    <View
      style={[styles.container, isCompact ? styles.containerCompact : null, style]}
      testID={testID}>
      <View style={[styles.primaryRow, isCompact ? styles.primaryRowCompact : null]}>
        <Text
          numberOfLines={1}
          style={[styles.label, isCompact ? styles.labelCompact : null, { color: accentColor }]}>
          {label}
        </Text>
        <Text numberOfLines={1} style={[styles.value, isCompact ? styles.valueCompact : null]}>
          {value}
        </Text>
      </View>
      {detail ? (
        <Text numberOfLines={1} style={[styles.detail, isCompact ? styles.detailCompact : null]}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(10, 22, 30, 0.9)',
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 3,
    maxWidth: '66%',
    paddingHorizontal: 10,
    paddingVertical: 7,
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.18,
    shadowRadius: 6,
  },
  containerCompact: {
    borderRadius: 10,
    gap: 2,
    maxWidth: '56%',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  primaryRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 8,
  },
  primaryRowCompact: {
    gap: 6,
  },
  label: {
    flexShrink: 1,
    fontFamily: typography.bodySemiBold,
    fontSize: 10,
    letterSpacing: 0.2,
  },
  labelCompact: {
    fontSize: 9,
  },
  value: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 16,
    lineHeight: 18,
  },
  valueCompact: {
    fontSize: 13,
    lineHeight: 15,
  },
  detail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 10,
  },
  detailCompact: {
    fontSize: 9,
  },
});