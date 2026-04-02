import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, typography } from '@/constants/theme';

export function ChartReadout({
  label,
  value,
  detail,
  accentColor,
  size = 'regular',
  style,
}: {
  label: string;
  value: string;
  detail?: string;
  accentColor: string;
  size?: 'compact' | 'regular';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.container, size === 'compact' ? styles.containerCompact : null, style]}>
      <Text style={[styles.label, size === 'compact' ? styles.labelCompact : null, { color: accentColor }]}>
        {label}
      </Text>
      <Text style={[styles.value, size === 'compact' ? styles.valueCompact : null]}>{value}</Text>
      {detail ? (
        <Text style={[styles.detail, size === 'compact' ? styles.detailCompact : null]}>{detail}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 2,
    minHeight: 60,
  },
  containerCompact: {
    minHeight: 52,
  },
  label: {
    fontFamily: typography.bodySemiBold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  labelCompact: {
    fontSize: 10,
  },
  value: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 30,
    lineHeight: 34,
  },
  valueCompact: {
    fontSize: 24,
    lineHeight: 28,
  },
  detail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
  },
  detailCompact: {
    fontSize: 11,
  },
});
