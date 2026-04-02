import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ChartReadout } from '@/components/charts/ChartReadout';
import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { MetricCard } from '@/components/ui/MetricCard';
import { StatChip } from '@/components/ui/StatChip';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useHeartHistory } from '@/hooks/useHealthData';
import type { TrendSelection } from '@/types/health';
import { formatMetricValue, formatSignedValue } from '@/utils/formatters';

export function HeartScreen() {
  const state = useHeartHistory('14d');
  const [intradaySelection, setIntradaySelection] = useState<TrendSelection | null>(null);
  const [restingSelection, setRestingSelection] = useState<TrendSelection | null>(null);
  const data = state.data;

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell>
        <LoadingState label="Loading intraday heart trends..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell>
        <ErrorState message="Unable to load heart history right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <ScreenShell>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last heart snapshot while refresh catches up." variant="inline" />
      ) : null}
      <View>
        <SectionHeader title="Heart" trailing="Daily profile" />
        <Text style={styles.subtitle}>Heart rate range, resting trend, and recovery cues.</Text>
      </View>

      <View style={styles.metricGrid}>
        <MetricCard accentColor={colors.success} style={styles.metricCard} title="Resting" value={`${data.restingHr}`} unit="BPM" />
        <MetricCard accentColor={colors.cyan} style={styles.metricCard} title="Average" value={`${data.averageHr}`} unit="BPM" />
        <MetricCard accentColor={colors.heart} style={styles.metricCard} title="Max" value={`${data.maxHr}`} unit="BPM" />
      </View>

      <GlassCard accentColor={colors.success}>
        <SectionHeader title="Intraday Heart Rate" trailing="Last 24 hours" />
        <ChartReadout
          accentColor={colors.success}
          detail={
            intradaySelection
              ? 'Selected 5-minute window'
              : `Resting ${formatMetricValue(data.restingHr, 0)} BPM · Max ${formatMetricValue(data.maxHr, 0)} BPM`
          }
          label={intradaySelection?.point.label ?? '24-hour average'}
          style={styles.chartReadout}
          value={
            intradaySelection
              ? `${formatMetricValue(intradaySelection.point.value, 0)} BPM`
              : `${formatMetricValue(data.averageHr, 0)} BPM`
          }
        />
        <TrendChart
          accentColor={colors.success}
          height={170}
          onSelectionChange={setIntradaySelection}
          points={data.intraday}
          testID="heart-intraday-chart"
        />
      </GlassCard>

      <GlassCard accentColor={colors.cyan}>
        <SectionHeader title="Resting HR Trend" trailing="14 days" />
        <ChartReadout
          accentColor={colors.cyan}
          detail={
            restingSelection ? 'Selected nightly resting HR' : `Recovery shift ${formatSignedValue(data.recoveryShift, 0)} bpm`
          }
          label={restingSelection?.point.label ?? 'Current resting HR'}
          style={styles.chartReadout}
          value={
            restingSelection
              ? `${formatMetricValue(restingSelection.point.value, 0)} BPM`
              : `${formatMetricValue(data.restingHr, 0)} BPM`
          }
        />
        <TrendChart
          accentColor={colors.cyan}
          onSelectionChange={setRestingSelection}
          points={data.weeklyResting}
          testID="heart-resting-chart"
        />
        {!restingSelection ? (
          <View style={styles.chipRow}>
            <StatChip accent={colors.success} label="Recovery shift" value={`${formatSignedValue(data.recoveryShift, 0)} bpm`} />
          </View>
        ) : null}
      </GlassCard>

      <GlassCard accentColor={colors.heart}>
        <SectionHeader title="Cardio Readout" trailing="Context" />
        <Text style={styles.readoutText}>
          Your resting rate has trended down through the last two weeks while peak effort still reaches the
          same ceiling. That usually points to better aerobic readiness without sacrificing intensity.
        </Text>
      </GlassCard>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    marginTop: 6,
  },
  metricGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  metricCard: {
    flex: 1,
  },
  chipRow: {
    marginTop: 8,
  },
  chartReadout: {
    marginBottom: 10,
  },
  readoutText: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 24,
  },
});
