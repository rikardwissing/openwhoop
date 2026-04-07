import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DashboardHeroMetricCard } from '@/components/dashboard/DashboardHeroMetricCard';
import {
  ActivitySnapshotCard,
  HeartSnapshotCard,
  InsightsCard,
  SleepSnapshotCard,
} from '@/components/dashboard/DashboardSnapshotCards';
import { TonightPlanCard } from '@/components/dashboard/TonightPlanCard';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useDashboardSnapshot, useDerivedRefreshState } from '@/hooks/useHealthData';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import type { HeartCardSnapshot, HistoryRange } from '@/types/health';
import { hasFreshLiveHeartRate } from '@/types/device';
import { getRecoveryMetricTone, getSleepMetricTone, getStrainMetricTone } from '@/utils/metricTone';

const heartRangeOrder: HistoryRange[] = ['24h', '7d', '14d', '30d'];

export function TodayScreen() {
  const router = useRouter();
  const state = useDashboardSnapshot();
  const derivedRefresh = useDerivedRefreshState();
  const repository = useHealthRepository();
  const heartVersion = useHealthDataVersion('heart');
  const { deviceState } = useWearableSyncState();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const data = state.data;
  const [loadedHeartRange, setLoadedHeartRange] = useState<HistoryRange | null>(null);
  const [loadedHeartSnapshot, setLoadedHeartSnapshot] = useState<HeartCardSnapshot | null>(null);
  const [isLoadingMoreHeartHistory, setIsLoadingMoreHeartHistory] = useState(false);

  const showLiveHeartRate = data?.day.isToday ? hasFreshLiveHeartRate(deviceState) : false;
  const liveHeartRateLabel =
    showLiveHeartRate && deviceState.liveHeartRate !== null ? `${deviceState.liveHeartRate} bpm` : null;
  const currentRangeIndex = loadedHeartRange ? heartRangeOrder.indexOf(loadedHeartRange) : -1;
  const canLoadMoreHeartHistory = currentRangeIndex < heartRangeOrder.length - 1;
  const displayedHeartSnapshot = useMemo(
    () =>
      !data
        ? null
        : {
            ...data.heartCard,
            restingHr: loadedHeartSnapshot?.restingHr ?? data.heartCard.restingHr,
            averageHr: loadedHeartSnapshot?.averageHr ?? data.heartCard.averageHr,
            maxHr: loadedHeartSnapshot?.maxHr ?? data.heartCard.maxHr,
            series: loadedHeartSnapshot?.series ?? data.heartCard.series,
            markers: loadedHeartSnapshot?.markers ?? data.heartCard.markers,
          },
    [data, loadedHeartSnapshot],
  );

  useEffect(() => {
    setLoadedHeartRange(null);
    setLoadedHeartSnapshot(null);
    setIsLoadingMoreHeartHistory(false);
  }, [data?.day.dayKey]);

  useEffect(() => {
    let cancelled = false;

    if (!loadedHeartRange) {
      return () => {
        cancelled = true;
      };
    }

    void repository
      .getDashboardHeartTimeline(loadedHeartRange)
      .then((snapshot) => {
        if (!cancelled) {
          setLoadedHeartSnapshot(snapshot);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setIsLoadingMoreHeartHistory(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [heartVersion, loadedHeartRange, repository]);

  const handleLoadMoreHeartHistory = useCallback(() => {
    if (!canLoadMoreHeartHistory) {
      return;
    }

    const nextRange = heartRangeOrder[currentRangeIndex + 1];
    if (nextRange) {
      setIsLoadingMoreHeartHistory(true);
      setLoadedHeartRange(nextRange);
    }
  }, [canLoadMoreHeartHistory, currentRangeIndex]);

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Today" onRefresh={onRefresh} refreshing={refreshing}>
        <LoadingState label="Loading today's dashboard..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Today" onRefresh={onRefresh} refreshing={refreshing}>
        <ErrorState message="Unable to load today right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const openSleep = () => router.push('/sleep');
  const openWellness = () => router.push('/wellness');

  return (
    <ScreenShell
      headerIcon="today"
      headerTitle="Today"
      onRefresh={onRefresh}
      refreshing={refreshing}>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last dashboard snapshot while refresh catches up." variant="inline" />
      ) : null}
      {data.day.isToday && derivedRefresh.data?.status === 'error' && derivedRefresh.data.lastError ? (
        <ErrorState message={derivedRefresh.data.lastError} variant="inline" />
      ) : null}

      <View>
        <Text style={styles.greeting}>{data.greeting}</Text>
        <Text style={styles.date}>{data.dateLabel}</Text>
      </View>

      <View style={styles.heroRow}>
        <DashboardHeroMetricCard
          caption="Recovery"
          label={data.recovery.label}
          onPress={openWellness}
          score={data.recovery.score}
          testID="today-open-recovery-hero"
          tone={getRecoveryMetricTone(data.recovery.score)}
        />
        <DashboardHeroMetricCard
          caption="Sleep"
          label={data.sleepCard.score === null ? 'Waiting' : 'Last night'}
          onPress={openSleep}
          score={data.sleepCard.score}
          testID="today-open-sleep-hero"
          tone={getSleepMetricTone(data.sleepCard.score)}
        />
        <DashboardHeroMetricCard
          caption="Strain"
          displayDigits={1}
          displaySuffix=""
          label={data.strainCard.label}
          onPress={openWellness}
          progressMax={21}
          score={data.strainCard.score}
          testID="today-open-strain-hero"
          tone={getStrainMetricTone(data.strainCard.score)}
        />
      </View>

      <TonightPlanCard onOpenSleep={openSleep} plan={data.tonightPlan} />

      <HeartSnapshotCard
        canLoadMore={canLoadMoreHeartHistory}
        chartTestID="today-heart-chart"
        isLoadingMore={isLoadingMoreHeartHistory}
        liveHeartRateLabel={liveHeartRateLabel}
        onLoadMore={handleLoadMoreHeartHistory}
        showLiveHeartRate={showLiveHeartRate}
        snapshot={displayedHeartSnapshot ?? data.heartCard}
        trailingLabel="Last 12h"
        viewportKey={data.day.dayKey}
        windowPointCount={data.heartCard.series.length}
      />

      <SleepSnapshotCard
        chartTestID="today-sleep-stage-chart"
        onOpen={openSleep}
        openTestID="today-open-sleep-button"
        snapshot={data.sleepCard}
        trailingLabel="Last night"
      />

      <ActivitySnapshotCard
        activities={data.activitySummary}
        chartTestID="today-strain-chart"
        onOpen={openWellness}
        openTestID="today-open-activity-button"
        strainCard={data.strainCard}
        trailingLabel="Today"
      />

      <InsightsCard insights={data.insights} trailingLabel="Today" />
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
  heroRow: {
    flexDirection: 'row',
    gap: 10,
  },
});
