import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TrendChart } from '@/components/charts/TrendChart';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { colors, typography } from '@/constants/theme';
import type { TrendMetricSnapshot } from '@/types/health';
import { formatMetricValue, formatSignedValue } from '@/utils/formatters';

function accentColorFor(metric: TrendMetricSnapshot) {
  switch (metric.accent) {
    case 'alert':
      return colors.alert;
    case 'heart':
      return colors.heart;
    case 'violet':
      return colors.violet;
    case 'cyan':
      return colors.cyan;
    default:
      return colors.success;
  }
}

export function TrendMetricCard({
  metric,
  onOpen,
  openLabel,
  openTestID,
  testID,
}: {
  metric: TrendMetricSnapshot;
  onOpen: () => void;
  openLabel: string;
  openTestID: string;
  testID: string;
}) {
  const accentColor = accentColorFor(metric);
  const digits = metric.unit === 'bpm' || metric.unit === '%' || metric.unit === '' ? (metric.id === 'strain' ? 1 : 0) : 1;

  return (
    <GlassCard accentColor={accentColor}>
      <SectionHeader
        title={metric.title}
        trailing={
          <Pressable
            accessibilityRole="button"
            onPress={onOpen}
            style={({ pressed }) => [styles.openButton, pressed ? styles.openButtonPressed : null]}
            testID={openTestID}>
            <Text style={styles.openText}>{openLabel}</Text>
            <Ionicons color={colors.primaryBright} name="chevron-forward" size={14} />
          </Pressable>
        }
      />

      <View style={styles.topRow}>
        <View style={styles.valueWrap}>
          <Text adjustsFontSizeToFit minimumFontScale={0.82} numberOfLines={1} style={styles.value}>
            {formatMetricValue(metric.latest, digits)}
            {metric.unit ? <Text style={styles.unit}> {metric.unit}</Text> : null}
          </Text>
        </View>
        {metric.delta !== null ? (
          <StatChip
            accent={accentColor}
            label="Delta"
            style={styles.deltaChip}
            value={`${formatSignedValue(metric.delta, digits)}${metric.unit}`}
          />
        ) : null}
      </View>

      <Text numberOfLines={2} style={styles.detail}>
        {metric.detail}
      </Text>

      <TrendChart accentColor={accentColor} height={132} points={metric.series} testID={testID} />
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  openButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  openButtonPressed: {
    opacity: 0.82,
  },
  openText: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  topRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 4,
    minHeight: 50,
  },
  valueWrap: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  value: {
    color: colors.text,
    flexShrink: 1,
    fontFamily: typography.heading,
    fontSize: 38,
    lineHeight: 42,
  },
  unit: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  deltaChip: {
    maxWidth: '44%',
  },
  detail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
    minHeight: 36,
  },
});
