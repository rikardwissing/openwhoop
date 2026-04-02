import { Ionicons } from '@expo/vector-icons';
import { Image, StyleSheet, Text, View } from 'react-native';

import { TrendChart } from '@/components/charts/TrendChart';
import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowRing } from '@/components/ui/GlowRing';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { appIcon } from '@/constants/assets';
import { colors, typography } from '@/constants/theme';
import { useDashboardSnapshot } from '@/hooks/useHealthData';
import { formatCompactDuration, formatMetricValue } from '@/utils/formatters';

export function TodayScreen() {
  const state = useDashboardSnapshot();

  if (state.status === 'loading') {
    return (
      <ScreenShell>
        <LoadingState label="Loading today's recovery snapshot..." />
      </ScreenShell>
    );
  }

  if (state.status === 'error') {
    return (
      <ScreenShell>
        <ErrorState message="Unable to load the mock dashboard right now." />
      </ScreenShell>
    );
  }

  const data = state.data;

  return (
    <ScreenShell>
      <View style={styles.topBar}>
        <Image source={appIcon} style={styles.brandIcon} />
        <Text style={styles.topTitle}>Today</Text>
        <Ionicons color={colors.text} name="search" size={22} />
      </View>

      <View>
        <Text style={styles.greeting}>{data.greeting}</Text>
        <Text style={styles.date}>{data.dateLabel}</Text>
      </View>

      <GlowRing
        caption={data.recovery.caption}
        label={data.recovery.label}
        score={data.recovery.score}
        size={306}
      />

      <GlassCard accentColor={colors.primary}>
        <View style={styles.summaryRow}>
          {data.summaryStats.map((stat, index) => (
            <View key={stat.label} style={[styles.summaryItem, index < data.summaryStats.length - 1 ? styles.summaryDivider : null]}>
              <Text style={styles.summaryLabel}>{stat.label}</Text>
              <Text style={styles.summaryValue}>{stat.value}</Text>
            </View>
          ))}
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.success}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            <Ionicons color={colors.success} name="heart-circle-outline" size={22} />
            <Text style={styles.cardTitle}>Heart Rate</Text>
          </View>
          <Ionicons color={colors.subtle} name="ellipsis-horizontal" size={18} />
        </View>
        <View style={styles.metricRow}>
          <View>
            <Text style={styles.metricLabel}>Resting HR</Text>
            <Text style={styles.metricValue}>
              {data.heartCard.restingHr}
              <Text style={styles.metricUnit}> BPM</Text>
            </Text>
          </View>
          <View>
            <Text style={styles.metricLabel}>Average</Text>
            <Text style={styles.metricValue}>
              {data.heartCard.averageHr}
              <Text style={styles.metricUnit}> BPM</Text>
            </Text>
          </View>
          <View>
            <Text style={styles.metricLabel}>Max</Text>
            <Text style={[styles.metricValue, { color: colors.heart }]}>
              {data.heartCard.maxHr}
              <Text style={styles.metricUnit}> BPM</Text>
            </Text>
          </View>
        </View>
        <TrendChart accentColor={colors.primary} height={164} points={data.heartCard.series} />
      </GlassCard>

      <View style={styles.bottomGrid}>
        <GlassCard accentColor={colors.violet} style={styles.gridCard}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLeft}>
              <Ionicons color={colors.violet} name="moon-outline" size={20} />
              <Text style={styles.cardTitle}>Sleep</Text>
            </View>
            <Ionicons color={colors.subtle} name="ellipsis-horizontal" size={18} />
          </View>
          <Text style={styles.sleepScore}>{formatMetricValue(data.sleepCard.score, 0)}</Text>
          <Text style={styles.sleepDuration}>{formatCompactDuration(data.sleepCard.durationMinutes)}</Text>
          <SleepStageChart
            endLabel={data.sleepCard.endLabel}
            middleLabel={data.sleepCard.middleLabel}
            segments={data.sleepCard.stages}
            startLabel={data.sleepCard.startLabel}
          />
        </GlassCard>

        <GlassCard accentColor={colors.cyan} style={styles.gridCard}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLeft}>
              <Ionicons color={colors.cyan} name="pulse-outline" size={20} />
              <Text style={styles.cardTitle}>Strain</Text>
            </View>
            <Ionicons color={colors.subtle} name="ellipsis-horizontal" size={18} />
          </View>
          <Text style={styles.strainValue}>{formatMetricValue(data.strainCard.score, 1)}</Text>
          <Text style={styles.strainLabel}>{data.strainCard.label}</Text>
          <TrendChart accentColor={colors.cyan} height={110} points={data.strainCard.series} />
        </GlassCard>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  brandIcon: {
    height: 28,
    width: 28,
  },
  topTitle: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 21,
  },
  greeting: {
    color: colors.success,
    fontFamily: typography.headingMedium,
    fontSize: 34,
    marginTop: 4,
  },
  date: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 16,
    marginTop: 4,
  },
  summaryRow: {
    flexDirection: 'row',
  },
  summaryItem: {
    flex: 1,
    gap: 6,
  },
  summaryDivider: {
    borderRightColor: colors.border,
    borderRightWidth: 1,
    marginRight: 12,
    paddingRight: 12,
  },
  summaryLabel: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    textTransform: 'uppercase',
  },
  summaryValue: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 22,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  cardHeaderLeft: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  cardTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  metricLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
    textTransform: 'uppercase',
  },
  metricValue: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 20,
    marginTop: 4,
  },
  metricUnit: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  bottomGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  gridCard: {
    flex: 1,
  },
  sleepScore: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 46,
    lineHeight: 50,
  },
  sleepDuration: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 16,
    marginBottom: 12,
  },
  strainValue: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 42,
    lineHeight: 48,
  },
  strainLabel: {
    color: colors.cyan,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
    marginBottom: 10,
  },
});
