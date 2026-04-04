import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ChartReadout } from '@/components/charts/ChartReadout';
import { TrendChart } from '@/components/charts/TrendChart';
import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowRing } from '@/components/ui/GlowRing';
import { PulsingHeartIcon } from '@/components/ui/PulsingHeartIcon';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { StatChip } from '@/components/ui/StatChip';
import { colors, typography } from '@/constants/theme';
import { useDashboardSnapshot, useDerivedRefreshState } from '@/hooks/useHealthData';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import { hasFreshLiveHeartRate } from '@/types/device';
import type { SleepStageSelection, TrendSelection } from '@/types/health';
import {
  formatClockRangeFromStartLabel,
  formatCompactDuration,
  formatMetricValue,
  formatSleepStageLabel,
} from '@/utils/formatters';

export function TodayScreen() {
  const state = useDashboardSnapshot();
  const derivedRefresh = useDerivedRefreshState();
  const { deviceState } = useWearableSyncState();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const [heartSelection, setHeartSelection] = useState<TrendSelection | null>(null);
  const [sleepSelection, setSleepSelection] = useState<SleepStageSelection | null>(null);
  const [strainSelection, setStrainSelection] = useState<TrendSelection | null>(null);
  const data = state.data;
  const showLiveHeartRate = hasFreshLiveHeartRate(deviceState);
  const liveHeartRateLabel =
    showLiveHeartRate && deviceState.liveHeartRate !== null ? `${deviceState.liveHeartRate} bpm` : null;

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Today" onRefresh={onRefresh} refreshing={refreshing}>
        <LoadingState label="Loading today's recovery snapshot..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Today" onRefresh={onRefresh} refreshing={refreshing}>
        <ErrorState message="Unable to load the dashboard right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const heartSelectionValue =
    heartSelection === null ? null : `${formatMetricValue(heartSelection.point.value, 0)} BPM`;
  const sleepSelectionDetail =
    sleepSelection === null
      ? null
      : `${sleepSelection.segment.minutes}m · ${formatClockRangeFromStartLabel(
          data.sleepCard.startLabel,
          sleepSelection.startMinute,
          sleepSelection.endMinute,
        )}`;
  const strainSelectionValue =
    strainSelection === null ? null : `${formatMetricValue(strainSelection.point.value, 1)} strain`;
  const heartSelectionDetail =
    heartSelection === null
      ? null
      : heartSelection.point.value === null
        ? 'No data in this 5-minute window'
        : 'Selected 5-minute window';
  const strainSelectionDetail =
    strainSelection === null
      ? null
      : strainSelection.point.value === null
        ? 'No strain data for this point'
        : 'Selected strain point';
  const derivedRefreshMessage =
    derivedRefresh.data?.status === 'pending' || derivedRefresh.data?.status === 'processing'
      ? derivedRefresh.data.isFirstSync
        ? 'Preparing insights from your first sync...'
        : 'Updating insights with your latest sync...'
      : null;

  return (
    <ScreenShell headerIcon="today" headerTitle="Today" onRefresh={onRefresh} refreshing={refreshing}>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last dashboard snapshot while refresh catches up." variant="inline" />
      ) : null}
      {derivedRefreshMessage ? (
        <Text style={styles.syncNotice}>{derivedRefreshMessage}</Text>
      ) : null}
      {derivedRefresh.data?.status === 'error' && derivedRefresh.data.lastError ? (
        <ErrorState message={derivedRefresh.data.lastError} variant="inline" />
      ) : null}

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
            <PulsingHeartIcon
              bpm={showLiveHeartRate ? deviceState.liveHeartRate : null}
              color={colors.success}
              name="heart-circle-outline"
              size={22}
            />
            <Text style={styles.cardTitle}>Heart Rate</Text>
          </View>
          <Ionicons color={colors.subtle} name="ellipsis-horizontal" size={18} />
        </View>
        {heartSelection ? (
          <ChartReadout
            accentColor={colors.primary}
            detail={heartSelectionDetail ?? undefined}
            label={heartSelection.point.label}
            style={styles.chartReadout}
            value={heartSelectionValue ?? '--'}
          />
        ) : (
          <View style={styles.heartSummary}>
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
            {liveHeartRateLabel ? (
              <View style={styles.heartChipRow}>
                <StatChip accent={colors.heart} label="Live" value={liveHeartRateLabel} />
              </View>
            ) : null}
          </View>
        )}
        <TrendChart
          accentColor={colors.primary}
          height={164}
          lineStrokeWidth={0.8}
          onSelectionChange={setHeartSelection}
          points={data.heartCard.series}
          shadowStrokeWidth={1.6}
          testID="today-heart-chart"
        />
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
          {sleepSelection ? (
            <ChartReadout
              accentColor={colors.violet}
              detail={sleepSelectionDetail ?? undefined}
              label={formatSleepStageLabel(sleepSelection.segment.stage)}
              size="compact"
              style={styles.compactReadout}
              value={`${sleepSelection.segment.minutes}m`}
            />
          ) : (
            <>
              <Text style={styles.sleepScore}>{formatMetricValue(data.sleepCard.score, 0)}</Text>
              <Text style={styles.sleepDuration}>{formatCompactDuration(data.sleepCard.durationMinutes)}</Text>
            </>
          )}
          <SleepStageChart
            accentColor={colors.violet}
            endLabel={data.sleepCard.endLabel}
            middleLabel={data.sleepCard.middleLabel}
            onSelectionChange={setSleepSelection}
            segments={data.sleepCard.stages}
            startLabel={data.sleepCard.startLabel}
            testID="today-sleep-stage-chart"
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
          {strainSelection ? (
            <ChartReadout
              accentColor={colors.cyan}
              detail={strainSelectionDetail ?? undefined}
              label={strainSelection.point.label}
              size="compact"
              style={styles.compactReadout}
              value={strainSelectionValue ?? '--'}
            />
          ) : (
            <>
              <Text style={styles.strainValue}>{formatMetricValue(data.strainCard.score, 1)}</Text>
              <Text style={styles.strainLabel}>{data.strainCard.label}</Text>
            </>
          )}
          <TrendChart
            accentColor={colors.cyan}
            height={110}
            onSelectionChange={setStrainSelection}
            points={data.strainCard.series}
            testID="today-strain-chart"
          />
        </GlassCard>
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
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
  syncNotice: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
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
    minHeight: 60,
  },
  heartSummary: {
    marginBottom: 6,
  },
  heartChipRow: {
    marginTop: 2,
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
  chartReadout: {
    marginBottom: 8,
  },
  compactReadout: {
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
