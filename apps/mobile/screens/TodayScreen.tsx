import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DashboardHeroMetricCard } from '@/components/dashboard/DashboardHeroMetricCard';
import {
  ActivityCard,
  HeartCard,
  HeartCardStatus,
  InsightsCard,
  SleepCard,
} from '@/components/dashboard/DashboardCards';
import { TonightPlanCard } from '@/components/dashboard/TonightPlanCard';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useDerivedRefreshState, useTodayOverview } from '@/hooks/useHealthData';
import { useHealthDataVersion, useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import {
  useWearableSyncActions,
  useWearableSyncProgress,
  useWearableSyncState,
} from '@/providers/WearableSyncProvider';
import type { ManualActivityKind } from '@/data/HealthRepository';
import type { HeartCardData, HeartTimelineWindow, TodayOverview } from '@/types/health';
import { hasFreshLiveHeartRate } from '@/types/device';
import {
  getHeartTimelineWindowPointCount,
  getHeartTimelineZoomPreset,
  getHeartTimelineZoomSteps,
  type HeartTimelineZoomLevel,
} from '@/utils/heartTimelineZoom';
import { buildHeartCardDataFromWindow } from '@/utils/heartTimeline';
import { logMobilePerf, logMobilePerfError } from '@/utils/mobilePerf';
import { getRecoveryMetricTone, getSleepMetricTone, getStrainMetricTone } from '@/utils/metricTone';
import { resolveTonightSurfaceState } from '@/utils/sleepPlan';

const HEART_PREFETCH_RANGE = '7d';
const HEART_ACTIVITY_REFRESH_SCOPES = ['dashboard', 'sleep', 'heart', 'wellness', 'trends'] as const;
const TODAY_REFRESH_SCOPES = ['dashboard', 'sleep', 'heart', 'wellness', 'trends', 'derived'] as const;
const DEFAULT_HEART_TIMELINE_ZOOM: HeartTimelineZoomLevel = '12h';

export function TodayScreen() {
  const router = useRouter();
  const state = useTodayOverview();
  const derivedRefresh = useDerivedRefreshState();
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const heartVersion = useHealthDataVersion('heart');
  const { backgroundSyncRefreshIndicator } = useWearableSyncProgress();
  const { runBackgroundSync } = useWearableSyncActions();
  const { deviceState } = useWearableSyncState();
  const [retainedOverview, setRetainedOverview] = useState<TodayOverview | null>(null);
  const data = state.data ?? retainedOverview;
  const [selectedHeartZoom, setSelectedHeartZoom] = useState<HeartTimelineZoomLevel>(DEFAULT_HEART_TIMELINE_ZOOM);
  const [heartTimelineWindow, setHeartTimelineWindow] = useState<HeartTimelineWindow | null>(null);
  const [heartCardState, setHeartCardState] = useState<{
    dayKey: string | null;
    isRefreshing: boolean;
    cardData: HeartCardData | null;
    status: 'idle' | 'loading' | 'ready' | 'error';
  }>({
    dayKey: null,
    isRefreshing: false,
    cardData: null,
    status: 'idle',
  });

  useEffect(() => {
    if (state.data) {
      setRetainedOverview(state.data);
    }
  }, [state.data]);

  const showLiveHeartRate = data?.day.isToday ? hasFreshLiveHeartRate(deviceState) : false;
  const liveHeartRateLabel =
    showLiveHeartRate && deviceState.liveHeartRate !== null ? `${deviceState.liveHeartRate} bpm` : null;

  const heartDayKey = data?.day.dayKey ?? null;
  const selectedHeartZoomPreset = useMemo(
    () => getHeartTimelineZoomPreset(selectedHeartZoom),
    [selectedHeartZoom],
  );
  const fallbackHeartCardData =
    heartCardState.cardData && heartCardState.dayKey === heartDayKey ? heartCardState.cardData : null;
  const displayedHeartCardData = useMemo(() => {
    if (heartTimelineWindow) {
      return buildHeartCardDataFromWindow(heartTimelineWindow);
    }

    return fallbackHeartCardData;
  }, [fallbackHeartCardData, heartTimelineWindow]);
  const heartPinchZoomSteps = useMemo(
    () =>
      displayedHeartCardData
        ? getHeartTimelineZoomSteps(
            displayedHeartCardData.pointIntervalMinutes,
            displayedHeartCardData.series.length,
          )
        : [],
    [displayedHeartCardData],
  );

  useEffect(() => {
    if (!heartDayKey) {
      setHeartTimelineWindow(null);
      setHeartCardState({ dayKey: null, isRefreshing: false, cardData: null, status: 'idle' });
      return;
    }

    setHeartTimelineWindow(null);
    setHeartCardState({
      dayKey: heartDayKey,
      isRefreshing: false,
      cardData: null,
      status: 'loading',
    });
  }, [heartDayKey, heartVersion]);

  useEffect(() => {
    let cancelled = false;

    if (!heartDayKey) {
      return () => {
        cancelled = true;
      };
    }

    const loadStartedAt = Date.now();

    setHeartTimelineWindow(null);
    setHeartCardState({
      dayKey: heartDayKey,
      isRefreshing: false,
      cardData: null,
      status: 'loading',
    });

    void repository
      .getDashboardHeartTimelineWindow(HEART_PREFETCH_RANGE)
      .then((window) => {
        if (!cancelled) {
          const cardData = buildHeartCardDataFromWindow(window);

          logMobilePerf('screen.today.heartGraph.load', loadStartedAt, {
            day: heartDayKey,
            markers: window.markers.length,
            points: cardData.series.length,
            range: HEART_PREFETCH_RANGE,
            samples: window.samples.length,
          });
          setHeartTimelineWindow(window);
          setHeartCardState({
            dayKey: heartDayKey,
            isRefreshing: false,
            cardData: cardData,
            status: 'ready',
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          logMobilePerfError('screen.today.heartGraph.load', error, {
            day: heartDayKey,
            range: HEART_PREFETCH_RANGE,
          });
          setHeartCardState((current) => {
            if (current.cardData && current.dayKey === heartDayKey) {
              return { ...current, isRefreshing: false };
            }

            return { dayKey: heartDayKey, isRefreshing: false, cardData: null, status: 'error' };
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [heartDayKey, heartVersion, repository]);

  const handleHeartZoomChange = useCallback(
    (zoomLevel: string) => {
      const nextZoom = zoomLevel as HeartTimelineZoomLevel;

      if (nextZoom === selectedHeartZoom) {
        return;
      }

      setSelectedHeartZoom(nextZoom);
    },
    [selectedHeartZoom],
  );

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
  const handleRefreshToday = useCallback(async () => {
    if (backgroundSyncRefreshIndicator.active || backgroundSyncRefreshIndicator.showStatus) {
      return;
    }

    try {
      await runBackgroundSync({ showOverlay: false });
      refreshHealthData(TODAY_REFRESH_SCOPES);
    } catch (error) {
      refreshHealthData(TODAY_REFRESH_SCOPES);
    }
  }, [backgroundSyncRefreshIndicator.active, backgroundSyncRefreshIndicator.showStatus, refreshHealthData, runBackgroundSync]);

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Today">
        <LoadingState label="Loading today's overview..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Today">
        <ErrorState message="Unable to load today right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const isHeartCardRefreshing = heartCardState.dayKey === heartDayKey ? heartCardState.isRefreshing : false;
  const heartChartWindowPointCount = displayedHeartCardData
    ? getHeartTimelineWindowPointCount(
        selectedHeartZoom,
        displayedHeartCardData.pointIntervalMinutes,
        displayedHeartCardData.series.length,
      )
    : undefined;
  const openSleep = () => router.push('/sleep');
  const openWellness = () => router.push('/wellness');
  const refreshTitle = backgroundSyncRefreshIndicator.showStatus
    ? backgroundSyncRefreshIndicator.message
    : deviceState.id
      ? 'Pull to sync wearable data'
      : 'Pull to refresh today';
  const tonightSurfaceState = data.day.isToday
    ? resolveTonightSurfaceState({
        completionStatus: data.sleepCard.completionStatus,
        isInProgress: data.sleepCard.isInProgress,
        sleepPlan: data.tonightPlan,
      })
    : null;
  const useTonightSurfaceGreeting =
    tonightSurfaceState?.mode === 'sleep' ||
    tonightSurfaceState?.mode === 'bedtime_passed' ||
    tonightSurfaceState?.mode === 'wind_down';
  const useTonightSurfaceDetail = tonightSurfaceState !== null && tonightSurfaceState.mode !== 'awake';
  const tonightSurfaceGreeting = (() => {
    switch (tonightSurfaceState?.mode) {
      case 'sleep':
        return 'Sleep in progress';
      case 'bedtime_passed':
        return 'Bedtime has started';
      case 'wind_down':
        return 'Time to wind down';
      case 'awake':
      default:
        return data.greeting;
    }
  })();
  const tonightSurfaceDetail = tonightSurfaceState?.mode === 'sleep'
    ? 'Sleep in progress'
    : tonightSurfaceState?.windDownStatus.detail;

  return (
    <ScreenShell
      headerIcon="today"
      headerTitle="Today"
      onRefresh={() => {
        void handleRefreshToday();
      }}
      refreshTitle={refreshTitle}
      refreshing={backgroundSyncRefreshIndicator.active}>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last Today overview while refresh catches up." variant="inline" />
      ) : null}
      {data.day.isToday && derivedRefresh.data?.status === 'error' && derivedRefresh.data.lastError ? (
        <ErrorState message={derivedRefresh.data.lastError} variant="inline" />
      ) : null}

      <View>
        <Text style={styles.greeting}>{useTonightSurfaceGreeting ? tonightSurfaceGreeting : data.greeting}</Text>
        <Text style={styles.date}>{useTonightSurfaceDetail ? tonightSurfaceDetail : data.dateLabel}</Text>
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
          label={data.sleepCard.isInProgress ? 'In progress' : data.sleepCard.score === null ? 'Waiting' : 'Last night'}
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

      <TonightPlanCard onOpenSleep={openSleep} plan={data.tonightPlan} surfaceState={tonightSurfaceState ?? undefined} />

      {displayedHeartCardData ? (
        <HeartCard
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
          latestWindowLabel={selectedHeartZoomPreset.latestLabel}
          onPinchZoomStepChange={handleHeartZoomChange}
          pinchZoomSteps={heartPinchZoomSteps}
          showLiveHeartRate={showLiveHeartRate}
          cardData={displayedHeartCardData}
          trailingLabel={selectedHeartZoomPreset.latestLabel}
          viewportKey={data.day.dayKey}
          windowPointCount={heartChartWindowPointCount}
        />
      ) : heartCardState.status === 'error' ? (
        <HeartCardStatus
          chartTestID="today-heart-chart"
          isLoading={false}
          liveHeartRateLabel={liveHeartRateLabel}
          message="Unable to load 7 day heart history right now."
          showLiveHeartRate={showLiveHeartRate}
          trailingLabel={selectedHeartZoomPreset.latestLabel}
        />
      ) : (
        <HeartCardStatus
          chartTestID="today-heart-chart"
          liveHeartRateLabel={liveHeartRateLabel}
          message="Loading 7 day heart history..."
          showLiveHeartRate={showLiveHeartRate}
          trailingLabel={selectedHeartZoomPreset.latestLabel}
        />
      )}

      <SleepCard
        chartTestID="today-sleep-stage-chart"
        onOpen={openSleep}
        openTestID="today-open-sleep-button"
        cardData={data.sleepCard}
        trailingLabel={data.sleepCard.isInProgress ? 'In progress' : 'Last night'}
      />

      <ActivityCard
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
