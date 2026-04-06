import { useRouter } from 'expo-router';
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
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import { hasFreshLiveHeartRate } from '@/types/device';
import { getRecoveryMetricTone, getSleepMetricTone, getStrainMetricTone } from '@/utils/metricTone';

function HeaderStatusPill({ label }: { label: string }) {
  return (
    <View style={styles.headerStatusRow}>
      <View style={styles.headerStatusPill}>
        <Text numberOfLines={1} style={styles.headerStatusText}>
          {label}
        </Text>
      </View>
    </View>
  );
}

export function TodayScreen() {
  const router = useRouter();
  const state = useDashboardSnapshot();
  const derivedRefresh = useDerivedRefreshState();
  const { deviceState } = useWearableSyncState();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const data = state.data;

  const showLiveHeartRate = data?.day.isToday ? hasFreshLiveHeartRate(deviceState) : false;
  const liveHeartRateLabel =
    showLiveHeartRate && deviceState.liveHeartRate !== null ? `${deviceState.liveHeartRate} bpm` : null;

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

  const syncStatusLabel =
    derivedRefresh.data?.status === 'pending' || derivedRefresh.data?.status === 'processing'
      ? derivedRefresh.data.isFirstSync
        ? 'Preparing insights from your first sync...'
        : 'Updating today with your latest sync...'
      : data.lastSyncLabel ?? 'Today';
  const openHeart = () => router.push('/heart');
  const openSleep = () => router.push('/sleep');
  const openWellness = () => router.push('/wellness');

  return (
    <ScreenShell
      headerAccessory={<HeaderStatusPill label={syncStatusLabel} />}
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
        chartTestID="today-heart-chart"
        liveHeartRateLabel={liveHeartRateLabel}
        onOpen={openHeart}
        openTestID="today-open-heart-button"
        showLiveHeartRate={showLiveHeartRate}
        snapshot={data.heartCard}
        trailingLabel="Today"
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
  headerStatusRow: {
    alignItems: 'flex-start',
  },
  headerStatusPill: {
    backgroundColor: 'rgba(8, 18, 25, 0.86)',
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerStatusText: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  heroRow: {
    flexDirection: 'row',
    gap: 10,
  },
});
