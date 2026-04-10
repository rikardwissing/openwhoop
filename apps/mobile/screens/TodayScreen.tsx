import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DashboardHeroMetricCard } from '@/components/dashboard/DashboardHeroMetricCard';
import {
  ActivitySnapshotCard,
  HeartSnapshotCard,
  HeartSnapshotStatusCard,
  InsightsCard,
  SleepSnapshotCard,
} from '@/components/dashboard/DashboardSnapshotCards';
import { TonightPlanCard } from '@/components/dashboard/TonightPlanCard';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useDashboardSnapshot, useDerivedRefreshState } from '@/hooks/useHealthData';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import { useHealthDataVersion, useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import type { ManualActivityKind } from '@/data/HealthRepository';
import type { HeartCardSnapshot } from '@/types/health';
import { hasFreshLiveHeartRate } from '@/types/device';
import { getRecoveryMetricTone, getSleepMetricTone, getStrainMetricTone } from '@/utils/metricTone';

const HEART_PREFETCH_RANGE = '7d';
const HEART_ACTIVITY_REFRESH_SCOPES = ['dashboard', 'sleep', 'heart', 'wellness', 'trends'] as const;

export function TodayScreen() {
  const router = useRouter();
  const state = useDashboardSnapshot();
  const derivedRefresh = useDerivedRefreshState();
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const heartVersion = useHealthDataVersion('heart');
  const { deviceState } = useWearableSyncState();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const data = state.data;
  const [heartCardState, setHeartCardState] = useState<{
    dayKey: string | null;
    isRefreshing: boolean;
    snapshot: HeartCardSnapshot | null;
    status: 'idle' | 'loading' | 'ready' | 'error';
  }>({
    dayKey: null,
    isRefreshing: false,
    snapshot: null,
    status: 'idle',
  });

  const showLiveHeartRate = data?.day.isToday ? hasFreshLiveHeartRate(deviceState) : false;
  const liveHeartRateLabel =
    showLiveHeartRate && deviceState.liveHeartRate !== null ? `${deviceState.liveHeartRate} bpm` : null;

  const heartDayKey = data?.day.dayKey ?? null;

  useEffect(() => {
    if (!heartDayKey) {
      setHeartCardState({ dayKey: null, isRefreshing: false, snapshot: null, status: 'idle' });
      return;
    }

    setHeartCardState((current) => {
      if (current.snapshot && current.dayKey === heartDayKey) {
        return { ...current, isRefreshing: true };
      }

      if (data?.heartCard) {
        return {
          dayKey: heartDayKey,
          isRefreshing: true,
          snapshot: data.heartCard,
          status: 'ready',
        };
      }

      return { dayKey: heartDayKey, isRefreshing: false, snapshot: null, status: 'loading' };
    });
  }, [heartDayKey, heartVersion]);

  useEffect(() => {
    let cancelled = false;

    if (!heartDayKey) {
      return () => {
        cancelled = true;
      };
    }

    void repository
      .getDashboardHeartTimeline(HEART_PREFETCH_RANGE)
      .then((snapshot) => {
        if (!cancelled) {
          setHeartCardState({ dayKey: heartDayKey, isRefreshing: false, snapshot, status: 'ready' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHeartCardState((current) => {
            if (current.snapshot && current.dayKey === heartDayKey) {
              return { ...current, isRefreshing: false };
            }

            return { dayKey: heartDayKey, isRefreshing: false, snapshot: null, status: 'error' };
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [heartDayKey, heartVersion, repository]);

  const refreshAfterActivityMutation = useCallback(() => {
    refreshHealthData(HEART_ACTIVITY_REFRESH_SCOPES);
  }, [refreshHealthData]);
  const handleConfirmHeartActivity = useCallback(async (activityId: string) => {
    await repository.confirmActivity(activityId);
    refreshAfterActivityMutation();
  }, [refreshAfterActivityMutation, repository]);
  const handleDismissHeartActivity = useCallback(async (activityId: string) => {
    await repository.dismissActivity(activityId);
    refreshAfterActivityMutation();
  }, [refreshAfterActivityMutation, repository]);
  const handleRelabelHeartActivity = useCallback(async (activityId: string, activity: 'Activity' | 'Walk' | 'Workout' | 'Nap') => {
    await repository.relabelActivity(activityId, activity);
    refreshAfterActivityMutation();
  }, [refreshAfterActivityMutation, repository]);
  const handleCreateManualHeartActivity = useCallback(async (activity: ManualActivityKind, start: Date, end: Date) => {
    const activityId = await repository.createManualActivity(activity, start, end);
    refreshAfterActivityMutation();
    return activityId;
  }, [refreshAfterActivityMutation, repository]);
  const handleCreateManualHeartSleep = useCallback(async (start: Date, end: Date) => {
    const sleepId = await repository.createManualSleep(start, end);
    refreshAfterActivityMutation();
    return sleepId;
  }, [refreshAfterActivityMutation, repository]);
  const handleUpdateHeartActivity = useCallback(async (activityId: string, activity: ManualActivityKind, start: Date, end: Date) => {
    await repository.updateActivity(activityId, activity, start, end);
    refreshAfterActivityMutation();
  }, [refreshAfterActivityMutation, repository]);
  const handleUpdateHeartSleep = useCallback(async (sleepId: string, start: Date, end: Date) => {
    await repository.updateSleep(sleepId, start, end);
    refreshAfterActivityMutation();
  }, [refreshAfterActivityMutation, repository]);

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

  const displayedHeartSnapshot =
    heartCardState.snapshot && heartCardState.dayKey === data.day.dayKey
      ? heartCardState.snapshot
      : data.heartCard;
  const isHeartCardRefreshing = displayedHeartSnapshot
    ? heartCardState.dayKey === data.day.dayKey
      ? heartCardState.isRefreshing
      : true
    : false;

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

      {displayedHeartSnapshot ? (
        <HeartSnapshotCard
          activityReviewActions={{
            confirmActivity: handleConfirmHeartActivity,
            createManualActivity: handleCreateManualHeartActivity,
            createManualSleep: handleCreateManualHeartSleep,
            dismissActivity: handleDismissHeartActivity,
            relabelActivity: handleRelabelHeartActivity,
            updateActivity: handleUpdateHeartActivity,
            updateSleep: handleUpdateHeartSleep,
          }}
          chartTestID="today-heart-chart"
          isRefreshing={isHeartCardRefreshing}
          liveHeartRateLabel={liveHeartRateLabel}
          showLiveHeartRate={showLiveHeartRate}
          snapshot={displayedHeartSnapshot}
          trailingLabel="Last 12h"
          viewportKey={data.day.dayKey}
          windowPointCount={data.heartCard.series.length}
        />
      ) : heartCardState.status === 'error' ? (
        <HeartSnapshotStatusCard
          chartTestID="today-heart-chart"
          isLoading={false}
          liveHeartRateLabel={liveHeartRateLabel}
          message="Unable to load 7 day heart history right now."
          showLiveHeartRate={showLiveHeartRate}
          trailingLabel="Last 12h"
        />
      ) : (
        <HeartSnapshotStatusCard
          chartTestID="today-heart-chart"
          liveHeartRateLabel={liveHeartRateLabel}
          message="Loading 7 day heart history..."
          showLiveHeartRate={showLiveHeartRate}
          trailingLabel="Last 12h"
        />
      )}

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
