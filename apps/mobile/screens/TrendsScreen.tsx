import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import { RangeSegmentedControl } from '@/components/dashboard/RangeSegmentedControl';
import { TrendMetricCard } from '@/components/dashboard/TrendMetricCard';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useTrendData } from '@/hooks/useHealthData';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import type { HistoryRange, TrendMetric } from '@/types/health';

const trendRanges: Array<{ label: string; value: HistoryRange }> = [
  { label: '7d', value: '7d' },
  { label: '14d', value: '14d' },
  { label: '30d', value: '30d' },
];

function routeForMetric(metric: TrendMetric['id']) {
  switch (metric) {
    case 'hrv':
    case 'sleepScore':
    case 'sleepDuration':
    case 'sleepConsistency':
      return '/sleep' as const;
    case 'restingHr':
      return null;
    default:
      return '/wellness' as const;
  }
}

export function TrendsScreen() {
  const router = useRouter();
  const [range, setRange] = useState<HistoryRange>('14d');
  const state = useTrendData(range);
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const data = state.data;

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell
        headerAccessory={
          <RangeSegmentedControl onChange={setRange} options={trendRanges} selectedValue={range} />
        }
        headerIcon="trends"
        headerTitle="Trends"
        onRefresh={onRefresh}
        refreshing={refreshing}>
        <LoadingState label="Loading your latest trends..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell
        headerAccessory={
          <RangeSegmentedControl onChange={setRange} options={trendRanges} selectedValue={range} />
        }
        headerIcon="trends"
        headerTitle="Trends"
        onRefresh={onRefresh}
        refreshing={refreshing}>
        <ErrorState message="Unable to load trend history right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <ScreenShell
      headerAccessory={<RangeSegmentedControl onChange={setRange} options={trendRanges} selectedValue={range} />}
      headerIcon="trends"
      headerTitle="Trends"
      onRefresh={onRefresh}
      refreshing={refreshing}>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last trend snapshot while refresh catches up." variant="inline" />
      ) : null}

      <View>
        <Text style={styles.title}>Patterns over time</Text>
        <Text style={styles.subtitle}>
          Track recovery, sleep rhythm, stress load, and overnight baseline shifts across the selected range. Latest day:
          {' '}
          {data.latestLabel}.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Top Signals</Text>
        {data.primaryMetrics.map((metric) => {
          const route = routeForMetric(metric.id);

          return (
            <TrendMetricCard
              key={metric.id}
              metric={metric}
              onOpen={route ? () => router.push(route) : undefined}
              openLabel={route ? 'Open' : undefined}
              openTestID={route ? `trends-open-${metric.id}-button` : undefined}
              testID={`trends-${metric.id}-chart`}
            />
          );
        })}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Supporting Signals</Text>
        {data.secondaryMetrics.map((metric) => {
          const route = routeForMetric(metric.id);

          return (
            <TrendMetricCard
              key={metric.id}
              metric={metric}
              onOpen={route ? () => router.push(route) : undefined}
              openLabel={route ? 'Open' : undefined}
              openTestID={route ? `trends-open-${metric.id}-button` : undefined}
              testID={`trends-${metric.id}-chart`}
            />
          );
        })}
      </View>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  title: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 28,
    marginTop: 4,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 6,
  },
  section: {
    gap: 14,
  },
  sectionLabel: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
