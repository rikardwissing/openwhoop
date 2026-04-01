import { StyleSheet, Text, View } from 'react-native';

import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { MetricCard } from '@/components/ui/MetricCard';
import { StatChip } from '@/components/ui/StatChip';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useHeartHistory } from '@/hooks/useHealthData';
import { formatSignedValue } from '@/utils/formatters';

export function HeartScreen() {
  const state = useHeartHistory('14d');

  if (state.status === 'loading') {
    return (
      <ScreenShell>
        <LoadingState label="Loading intraday heart trends..." />
      </ScreenShell>
    );
  }

  if (state.status === 'error') {
    return (
      <ScreenShell>
        <ErrorState message="Unable to load heart history right now." />
      </ScreenShell>
    );
  }

  const data = state.data;

  return (
    <ScreenShell>
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
        <TrendChart accentColor={colors.success} height={170} points={data.intraday} />
      </GlassCard>

      <GlassCard accentColor={colors.cyan}>
        <SectionHeader title="Resting HR Trend" trailing="14 days" />
        <TrendChart accentColor={colors.cyan} points={data.weeklyResting} />
        <View style={styles.chipRow}>
          <StatChip accent={colors.success} label="Recovery shift" value={`${formatSignedValue(data.recoveryShift, 0)} bpm`} />
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.heart}>
        <SectionHeader title="Cardio Readout" trailing="Context" />
        <Text style={styles.readout}>
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
  readout: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 24,
  },
});
