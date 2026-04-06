import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ChartReadout } from '@/components/charts/ChartReadout';
import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useDerivedRefreshState, useWellnessSnapshot } from '@/hooks/useHealthData';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import type { MetricSeries, TrendSelection } from '@/types/health';
import { formatMetricValue, formatSignedValue } from '@/utils/formatters';
import { getMetricToneColor, getRecoveryMetricTone } from '@/utils/metricTone';

function accentColorFor(series: MetricSeries) {
  switch (series.accent) {
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

function barColorForMetric(metric: MetricSeries, value: number | null) {
  if (value === null) {
    return undefined;
  }

  if (metric.title === 'Recovery Index') {
    return getMetricToneColor(getRecoveryMetricTone(value));
  }

  return undefined;
}

function WellnessMetricCard({ metric }: { metric: MetricSeries }) {
  const accentColor = accentColorFor(metric);
  const [selection, setSelection] = useState<TrendSelection | null>(null);
  const digits = metric.unit === '°C' ? 1 : 0;

  return (
    <GlassCard accentColor={accentColor} style={styles.metricCard}>
      <View style={styles.metricCardIntro}>
        <SectionHeader title={metric.title} titleNumberOfLines={1} trailing={metric.unit ? `${metric.unit} trend` : 'Trend'} />
        {selection ? (
          <ChartReadout
            accentColor={accentColor}
            detail={selection.point.value === null ? 'No data recorded for this day' : 'Selected daily average'}
            label={selection.point.label}
            style={styles.readout}
            value={`${formatMetricValue(selection.point.value, digits)}${metric.unit ? ` ${metric.unit}` : ''}`}
          />
        ) : (
          <View style={styles.metricTopRow}>
            <View style={styles.metricNumberWrap}>
              <Text adjustsFontSizeToFit minimumFontScale={0.82} numberOfLines={1} style={styles.metricNumber}>
                {formatMetricValue(metric.latest, digits)}
                {metric.unit ? <Text style={styles.metricUnit}> {metric.unit}</Text> : null}
              </Text>
            </View>
            {metric.delta !== null ? (
              <StatChip
                accent={accentColor}
                label="Delta"
                style={styles.metricStatChip}
                value={`${formatSignedValue(metric.delta, digits)}${metric.unit}`}
              />
            ) : null}
          </View>
        )}
        <Text numberOfLines={2} style={styles.metricDetail}>
          {metric.detail}
        </Text>
        {metric.hasPartialData ? (
          <View style={styles.partialRow}>
            <StatChip accent={colors.alert} label="Signal" value="Limited samples" />
          </View>
        ) : null}
      </View>
      <TrendChart
        accentColor={accentColor}
        barColorForPoint={(point) => barColorForMetric(metric, point.value)}
        height={126}
        mode="bar"
        onSelectionChange={setSelection}
        points={metric.series}
        testID={`wellness-${metric.title.toLowerCase().replace(/\s+/g, '-')}-chart`}
      />
    </GlassCard>
  );
}

export function WellnessScreen() {
  const state = useWellnessSnapshot('14d');
  const derivedRefresh = useDerivedRefreshState();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const data = state.data;

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="wellness" headerTitle="Wellness" onRefresh={onRefresh} refreshing={refreshing}>
        <LoadingState label="Loading wellness metrics..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell headerIcon="wellness" headerTitle="Wellness" onRefresh={onRefresh} refreshing={refreshing}>
        <ErrorState message="Unable to load the wellness board right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const derivedRefreshMessage =
    derivedRefresh.data?.status === 'pending' || derivedRefresh.data?.status === 'processing'
      ? derivedRefresh.data.isFirstSync
        ? 'Preparing insights from your first sync...'
        : 'Updating wellness insights with your latest sync...'
      : null;

  return (
    <ScreenShell headerIcon="wellness" headerTitle="Wellness" onRefresh={onRefresh} refreshing={refreshing}>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last wellness snapshot while refresh catches up." variant="inline" />
      ) : null}
      {derivedRefreshMessage ? (
        <Text style={styles.syncNotice}>{derivedRefreshMessage}</Text>
      ) : null}
      {derivedRefresh.data?.status === 'error' && derivedRefresh.data.lastError ? (
        <ErrorState message={derivedRefresh.data.lastError} variant="inline" />
      ) : null}
      <View>
        <Text style={styles.subtitle}>Stress, oxygen, temperature, recovery, and recent activity trends.</Text>
      </View>

      <WellnessMetricCard metric={data.stress} />
      <WellnessMetricCard metric={data.spo2} />
      <WellnessMetricCard metric={data.skinTemperature} />
      <WellnessMetricCard metric={data.recoveryIndex} />

      <GlassCard accentColor={colors.success}>
        <SectionHeader title="Recent Activity" trailing="Today" />
        {data.activities.map((activity, index) => (
          <View key={activity.id} style={[styles.activityRow, index < data.activities.length - 1 ? styles.activityDivider : null]}>
            <View>
              <Text style={styles.activityTitle}>{activity.title}</Text>
              <Text style={styles.activityMeta}>
                {activity.timeLabel} · {activity.durationMinutes} min
              </Text>
            </View>
            <View style={styles.activityValues}>
              <Text style={styles.activityStrain}>{activity.strain === null ? '-- strain' : `${activity.strain.toFixed(1)} strain`}</Text>
              <Text style={styles.activityCalories}>{activity.calories === null ? '-- kcal' : `${activity.calories} kcal`}</Text>
            </View>
          </View>
        ))}
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
  syncNotice: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  metricCard: {
    marginBottom: 0,
  },
  metricCardIntro: {
    marginBottom: 8,
    minHeight: 116,
  },
  metricTopRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 8,
    minHeight: 50,
  },
  metricNumberWrap: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  metricStatChip: {
    maxWidth: '44%',
  },
  metricNumber: {
    color: colors.text,
    flexShrink: 1,
    fontFamily: typography.heading,
    fontSize: 40,
    lineHeight: 46,
  },
  metricUnit: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  metricDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
    minHeight: 36,
  },
  partialRow: {
    marginTop: 6,
  },
  readout: {
    marginBottom: 8,
  },
  activityRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  activityDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  activityTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  activityMeta: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  activityValues: {
    alignItems: 'flex-end',
  },
  activityStrain: {
    color: colors.success,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  activityCalories: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
});
