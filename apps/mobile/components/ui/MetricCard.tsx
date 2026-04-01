import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, typography } from '@/constants/theme';
import { GlassCard } from '@/components/ui/GlassCard';

export function MetricCard({
  title,
  value,
  unit,
  subtitle,
  accentColor,
  style,
}: {
  title: string;
  value: string;
  unit?: string;
  subtitle?: string;
  accentColor: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <GlassCard accentColor={accentColor} style={style}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.valueRow}>
        <Text style={styles.value}>{value}</Text>
        {unit ? <Text style={styles.unit}>{unit}</Text> : null}
      </View>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  title: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    textTransform: 'uppercase',
  },
  valueRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  value: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 34,
    lineHeight: 40,
  },
  unit: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 16,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    marginTop: 8,
  },
});
