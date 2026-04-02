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
import { useWellnessSnapshot } from '@/hooks/useHealthData';
import type { MetricSeries, TrendSelection } from '@/types/health';
import { formatMetricValue, formatSignedValue } from '@/utils/formatters';

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

function WellnessMetricCard({ metric }: { metric: MetricSeries }) {
  const accentColor = accentColorFor(metric);
  const [selection, setSelection] = useState<TrendSelection | null>(null);
  const digits = metric.unit === '°C' ? 1 : 0;

  return (
    <GlassCard accentColor={accentColor} style={styles.metricCard}>
      <SectionHeader title={metric.title} trailing={metric.unit ? `${metric.unit} trend` : 'Trend'} />
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
          <Text style={styles.metricNumber}>
            {formatMetricValue(metric.latest, digits)}
            {metric.unit ? <Text style={styles.metricUnit}> {metric.unit}</Text> : null}
          </Text>
          {metric.delta !== null ? (
            <StatChip accent={accentColor} label="Delta" value={`${formatSignedValue(metric.delta, digits)}${metric.unit}`} />
          ) : null}
        </View>
      )}
      <Text style={styles.metricDetail}>{metric.detail}</Text>
      {metric.hasPartialData ? (
        <View style={styles.partialRow}>
          <StatChip accent={colors.alert} label="Signal" value="Limited samples" />
        </View>
      ) : null}
      <TrendChart
        accentColor={accentColor}
        height={126}
        onSelectionChange={setSelection}
        points={metric.series}
        testID={`wellness-${metric.title.toLowerCase().replace(/\s+/g, '-')}-chart`}
      />
    </GlassCard>
  );
}

export function WellnessScreen() {
  const state = useWellnessSnapshot('14d');
  const data = state.data;

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell>
        <LoadingState label="Loading wellness metrics..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell>
        <ErrorState message="Unable to load the wellness board right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <ScreenShell>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last wellness snapshot while refresh catches up." variant="inline" />
      ) : null}
      <View>
        <SectionHeader title="Wellness" trailing="Signals and trends" />
        <Text style={styles.subtitle}>Stress, oxygen, temperature, recovery, and recent activity.</Text>
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
  metricCard: {
    marginBottom: 0,
  },
  metricTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  metricNumber: {
    color: colors.text,
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
    marginBottom: 8,
  },
  partialRow: {
    marginBottom: 6,
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
