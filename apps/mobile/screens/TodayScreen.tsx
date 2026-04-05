import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChartReadout } from '@/components/charts/ChartReadout';
import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
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
import type { ActivitySummary, MetricSeries, SleepStageSelection, TrendSelection } from '@/types/health';
import {
  formatClockRangeFromStartLabel,
  formatCompactDuration,
  formatMetricValue,
  formatSleepStageLabel,
} from '@/utils/formatters';
import { mapHeartIntradayMarkersToTrendMarkers } from '@/utils/heartChartMarkers';

function accentColorFor(metric: Pick<MetricSeries, 'accent'>) {
  switch (metric.accent) {
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

function MetricDayCard({
  metric,
  onSelectionChange,
  selection,
  testID,
  trailing,
}: {
  metric: MetricSeries;
  onSelectionChange: (selection: TrendSelection | null) => void;
  selection: TrendSelection | null;
  testID: string;
  trailing: ReactNode;
}) {
  const accentColor = accentColorFor(metric);
  const digits = metric.unit === '°C' ? 1 : 0;

  return (
    <GlassCard accentColor={accentColor} style={styles.metricTrendCard}>
      <View style={styles.metricTrendCardIntro}>
        <SectionHeader title={metric.title} titleNumberOfLines={1} trailing={trailing} />
        {selection ? (
          <ChartReadout
            accentColor={accentColor}
            detail={selection.point.value === null ? 'No data recorded for this window' : 'Selected time window'}
            label={selection.point.label}
            size="compact"
            style={styles.metricReadout}
            value={`${formatMetricValue(selection.point.value, digits)}${metric.unit ? ` ${metric.unit}` : ''}`}
          />
        ) : (
          <>
            <View style={styles.metricTopRow}>
              <View style={styles.metricValueWrap}>
                <Text adjustsFontSizeToFit minimumFontScale={0.82} numberOfLines={1} style={styles.metricCardValue}>
                  {formatMetricValue(metric.latest, digits)}
                  {metric.unit ? <Text style={styles.metricCardUnit}> {metric.unit}</Text> : null}
                </Text>
              </View>
              {metric.average !== null ? (
                <StatChip
                  accent={accentColor}
                  label="Avg"
                  style={styles.metricAverageChip}
                  value={`${formatMetricValue(metric.average, digits)}${metric.unit ? metric.unit : ''}`}
                />
              ) : null}
            </View>
            <Text numberOfLines={2} style={styles.metricCardDetail}>
              {metric.detail}
            </Text>
          </>
        )}
      </View>
      <TrendChart
        accentColor={accentColor}
        height={108}
        onSelectionChange={onSelectionChange}
        points={metric.series}
        testID={testID}
      />
    </GlassCard>
  );
}

function CardHeaderMeta({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <View style={styles.cardTrailingGroup}>
      <Text numberOfLines={1} style={styles.cardTrailing}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.cardActionButton, pressed ? styles.cardActionButtonPressed : null]}
        testID={testID}>
        <Text style={styles.cardActionText}>Open</Text>
        <Ionicons color={colors.primaryBright} name="chevron-forward" size={14} />
      </Pressable>
    </View>
  );
}

function ActivityOverviewCard({
  activities,
  trailing,
  strainLabel,
  strainScore,
  strainSeries,
  strainSelection,
  onStrainSelectionChange,
  onOpenDetails,
  actionTestID,
}: {
  activities: readonly ActivitySummary[];
  trailing: ReactNode;
  strainLabel: string;
  strainScore: number | null;
  strainSeries: TrendSelection['point'][];
  strainSelection: TrendSelection | null;
  onStrainSelectionChange: (selection: TrendSelection | null) => void;
  onOpenDetails: () => void;
  actionTestID: string;
}) {
  return (
    <GlassCard accentColor={colors.success}>
      <SectionHeader title="Activity" titleNumberOfLines={1} trailing={trailing} />
      {strainSelection ? (
        <ChartReadout
          accentColor={colors.cyan}
          detail={strainSelection.point.value === null ? 'No load estimate for this window' : 'Cumulative daily load'}
          label={strainSelection.point.label}
          size="compact"
          style={styles.metricReadout}
          value={strainSelection.point.value === null ? '--' : `${formatMetricValue(strainSelection.point.value, 1)} strain`}
        />
      ) : (
        <>
          <View style={styles.activitySummaryRow}>
            <StatChip
              accent={colors.cyan}
              label="Day strain"
              value={strainScore === null ? '--' : strainScore.toFixed(1)}
            />
            <StatChip accent={colors.success} label="Sessions" value={`${activities.length}`} />
          </View>
          <Text style={styles.activitySummaryLabel}>{strainLabel}</Text>
        </>
      )}
      <TrendChart
        accentColor={colors.cyan}
        height={112}
        onSelectionChange={onStrainSelectionChange}
        points={strainSeries}
        testID="today-strain-chart"
      />
      <View style={styles.activityActionsRow}>
        <Pressable
          accessibilityRole="button"
          onPress={onOpenDetails}
          style={({ pressed }) => [styles.inlineActionButton, pressed ? styles.cardActionButtonPressed : null]}
          testID={actionTestID}>
          <Text style={styles.inlineActionText}>Open Wellness</Text>
          <Ionicons color={colors.primaryBright} name="chevron-forward" size={14} />
        </Pressable>
      </View>
      {activities.length === 0 ? (
        <Text style={styles.emptyText}>No recorded activity sessions for this day.</Text>
      ) : (
        activities.map((activity, index) => (
          <View
            key={activity.id}
            style={[styles.activityRow, index < activities.length - 1 ? styles.activityDivider : null]}>
            <View style={styles.activityBody}>
              <Text style={styles.activityTitle}>{activity.title}</Text>
              <Text style={styles.activityMeta}>
                {activity.timeLabel} · {activity.durationMinutes} min
              </Text>
            </View>
            <View style={styles.activityValues}>
              <Text style={styles.activityValueText}>
                {activity.strain === null ? '-- strain' : `${activity.strain.toFixed(1)} strain`}
              </Text>
              <Text style={styles.activityMeta}>
                {activity.calories === null ? '-- kcal' : `${activity.calories} kcal`}
              </Text>
            </View>
          </View>
        ))
      )}
    </GlassCard>
  );
}

export function TodayScreen() {
  const router = useRouter();
  const [selectedDayKey, setSelectedDayKey] = useState<string | undefined>(undefined);
  const state = useDashboardSnapshot(selectedDayKey);
  const derivedRefresh = useDerivedRefreshState();
  const { deviceState } = useWearableSyncState();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const [heartSelection, setHeartSelection] = useState<TrendSelection | null>(null);
  const [sleepSelection, setSleepSelection] = useState<SleepStageSelection | null>(null);
  const [strainSelection, setStrainSelection] = useState<TrendSelection | null>(null);
  const [hrvSelection, setHrvSelection] = useState<TrendSelection | null>(null);
  const [stressSelection, setStressSelection] = useState<TrendSelection | null>(null);
  const [spo2Selection, setSpo2Selection] = useState<TrendSelection | null>(null);
  const [skinTemperatureSelection, setSkinTemperatureSelection] = useState<TrendSelection | null>(null);
  const data = state.data;

  useEffect(() => {
    setHeartSelection(null);
    setSleepSelection(null);
    setStrainSelection(null);
    setHrvSelection(null);
    setStressSelection(null);
    setSpo2Selection(null);
    setSkinTemperatureSelection(null);
  }, [data?.day.dayKey]);

  const showLiveHeartRate = data?.day.isToday ? hasFreshLiveHeartRate(deviceState) : false;
  const liveHeartRateLabel =
    showLiveHeartRate && deviceState.liveHeartRate !== null ? `${deviceState.liveHeartRate} bpm` : null;
  const heartMarkers = useMemo(
    () => (data ? mapHeartIntradayMarkersToTrendMarkers(data.heartCard.markers ?? []) : []),
    [data?.heartCard.markers],
  );

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Today" onRefresh={onRefresh} refreshing={refreshing}>
        <LoadingState label="Loading the dashboard overview..." variant="inline" />
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
  const heartSelectionDetail =
    heartSelection === null
      ? null
      : heartSelection.point.value === null
        ? 'No data in this 5-minute window'
        : 'Selected 5-minute window';
  const derivedRefreshMessage =
    data.day.isToday && (derivedRefresh.data?.status === 'pending' || derivedRefresh.data?.status === 'processing')
      ? derivedRefresh.data.isFirstSync
        ? 'Preparing insights from your first sync...'
        : 'Updating insights with your latest sync...'
      : null;
  const title = data.day.isToday ? data.greeting : 'Overview';
  const subtitle = data.day.isToday ? data.dateLabel : `${data.dateLabel} dashboard`;
  const overnightMetricLabel = data.sleepCard.durationMinutes !== null ? 'Overnight' : data.day.shortLabel;
  const openHeart = () => router.push('/heart');
  const openSleep = () => router.push('/sleep');
  const openWellness = () => router.push('/wellness');

  return (
    <ScreenShell
      headerAccessory={
        <View style={styles.dayNavigator}>
          <Pressable
            accessibilityLabel="Show older dashboard day"
            accessibilityRole="button"
            disabled={!data.day.olderDayKey}
            onPress={() => setSelectedDayKey(data.day.olderDayKey ?? undefined)}
            style={({ pressed }) => [
              styles.dayNavigatorButton,
              !data.day.olderDayKey ? styles.dayNavigatorButtonDisabled : null,
              pressed ? styles.dayNavigatorButtonPressed : null,
            ]}
            testID="today-day-backward-button">
            <Ionicons color={data.day.olderDayKey ? colors.text : colors.muted} name="chevron-back" size={14} />
            <Text style={styles.dayNavigatorButtonLabel}>Older</Text>
          </Pressable>

          <View style={styles.dayNavigatorCenter}>
            <Text style={styles.dayNavigatorDate} testID="today-selected-day-label">
              {data.day.shortLabel}
            </Text>
            <Text style={styles.dayNavigatorMeta}>{data.day.isToday ? 'Today' : data.dateLabel}</Text>
          </View>

          <Pressable
            accessibilityLabel="Show newer dashboard day"
            accessibilityRole="button"
            disabled={!data.day.newerDayKey}
            onPress={() => setSelectedDayKey(data.day.newerDayKey ?? undefined)}
            style={({ pressed }) => [
              styles.dayNavigatorButton,
              !data.day.newerDayKey ? styles.dayNavigatorButtonDisabled : null,
              pressed ? styles.dayNavigatorButtonPressed : null,
            ]}
            testID="today-day-forward-button">
            <Text style={styles.dayNavigatorButtonLabel}>Newer</Text>
            <Ionicons color={data.day.newerDayKey ? colors.text : colors.muted} name="chevron-forward" size={14} />
          </Pressable>
        </View>
      }
      headerIcon="today"
      headerTitle="Today"
      onRefresh={onRefresh}
      refreshing={refreshing}>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last dashboard snapshot while refresh catches up." variant="inline" />
      ) : null}
      {derivedRefreshMessage ? <Text style={styles.syncNotice}>{derivedRefreshMessage}</Text> : null}
      {data.day.isToday && derivedRefresh.data?.status === 'error' && derivedRefresh.data.lastError ? (
        <ErrorState message={derivedRefresh.data.lastError} variant="inline" />
      ) : null}

      <View>
        <Text style={styles.greeting}>{title}</Text>
        <Text style={styles.date}>{subtitle}</Text>
      </View>

      <GlowRing caption={data.recovery.caption} label={data.recovery.label} score={data.recovery.score} size={286} />

      <GlassCard accentColor={colors.primary}>
        <View style={styles.summaryGrid}>
          {data.summaryStats.map((stat) => (
            <View key={stat.label} style={styles.summaryItem}>
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
          <CardHeaderMeta label={data.day.shortLabel} onPress={openHeart} testID="today-open-heart-button" />
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
          markers={heartMarkers}
          onSelectionChange={setHeartSelection}
          points={data.heartCard.series}
          shadowStrokeWidth={1.6}
          testID="today-heart-chart"
        />
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            <Ionicons color={colors.violet} name="moon-outline" size={20} />
            <Text style={styles.cardTitle}>Sleep</Text>
          </View>
          <CardHeaderMeta label={overnightMetricLabel} onPress={openSleep} testID="today-open-sleep-button" />
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

      <View style={styles.metricTrendGrid}>
        <View style={styles.metricTrendGridItem}>
          <MetricDayCard
            metric={data.hrvCard}
            onSelectionChange={setHrvSelection}
            selection={hrvSelection}
            testID="today-hrv-chart"
            trailing={<CardHeaderMeta label={overnightMetricLabel} onPress={openSleep} testID="today-open-hrv-details-button" />}
          />
        </View>
        <View style={styles.metricTrendGridItem}>
          <MetricDayCard
            metric={data.stressCard}
            onSelectionChange={setStressSelection}
            selection={stressSelection}
            testID="today-stress-chart"
            trailing={<CardHeaderMeta label={data.day.shortLabel} onPress={openWellness} testID="today-open-stress-details-button" />}
          />
        </View>
        <View style={styles.metricTrendGridItem}>
          <MetricDayCard
            metric={data.spo2Card}
            onSelectionChange={setSpo2Selection}
            selection={spo2Selection}
            testID="today-spo2-chart"
            trailing={<CardHeaderMeta label={data.day.shortLabel} onPress={openWellness} testID="today-open-spo2-details-button" />}
          />
        </View>
        <View style={styles.metricTrendGridItem}>
          <MetricDayCard
            metric={data.skinTemperatureCard}
            onSelectionChange={setSkinTemperatureSelection}
            selection={skinTemperatureSelection}
            testID="today-skin-temperature-chart"
            trailing={<CardHeaderMeta label={data.day.shortLabel} onPress={openWellness} testID="today-open-skin-temperature-details-button" />}
          />
        </View>
      </View>

      <ActivityOverviewCard
        activities={data.activitySummary}
        trailing={<CardHeaderMeta label={data.day.shortLabel} onPress={openWellness} testID="today-open-activity-header-button" />}
        strainLabel={data.strainCard.label}
        strainScore={data.strainCard.score}
        strainSeries={data.strainCard.series}
        strainSelection={strainSelection}
        onStrainSelectionChange={setStrainSelection}
        onOpenDetails={openWellness}
        actionTestID="today-open-activity-details-button"
      />

      <GlassCard accentColor={colors.aqua}>
        <SectionHeader title="Insights" trailing={data.day.isToday ? 'Today' : data.day.shortLabel} />
        {data.insights.length === 0 ? (
          <Text style={styles.emptyText}>Insights will appear once more history is available.</Text>
        ) : (
          data.insights.map((insight, index) => (
            <View key={insight.id} style={[styles.insightRow, index < data.insights.length - 1 ? styles.insightDivider : null]}>
              <View style={[styles.insightDot, { backgroundColor: accentColorFor({ accent: insight.accent }) }]} />
              <View style={styles.insightBody}>
                <Text style={styles.insightTitle}>{insight.title}</Text>
                <Text style={styles.insightDetail}>{insight.detail}</Text>
              </View>
            </View>
          ))
        )}
      </GlassCard>

      {data.lastSyncLabel ? <Text style={styles.lastSyncLabel}>{data.lastSyncLabel}</Text> : null}
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
  dayNavigator: {
    alignItems: 'center',
    backgroundColor: 'rgba(8, 18, 25, 0.74)',
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  dayNavigatorButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    minWidth: 68,
  },
  dayNavigatorButtonDisabled: {
    opacity: 0.42,
  },
  dayNavigatorButtonPressed: {
    opacity: 0.78,
  },
  dayNavigatorButtonLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  dayNavigatorCenter: {
    alignItems: 'center',
    flex: 1,
  },
  dayNavigatorDate: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 18,
  },
  dayNavigatorMeta: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 2,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  summaryItem: {
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    minWidth: '47%',
    paddingHorizontal: 12,
    paddingVertical: 12,
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
    marginTop: 6,
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
  cardTrailing: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
  },
  cardTrailingGroup: {
    alignItems: 'flex-end',
    flexShrink: 1,
    gap: 4,
    maxWidth: '48%',
    minWidth: 0,
  },
  cardActionButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  cardActionButtonPressed: {
    opacity: 0.7,
  },
  cardActionText: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
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
  metricTrendGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricTrendGridItem: {
    minWidth: '47%',
    flex: 1,
  },
  metricTrendCard: {
    minHeight: 228,
  },
  metricTrendCardIntro: {
    marginBottom: 8,
    minHeight: 94,
  },
  metricTopRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    marginBottom: 8,
    minHeight: 42,
  },
  metricValueWrap: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  metricAverageChip: {
    maxWidth: '48%',
  },
  metricCardValue: {
    color: colors.text,
    flexShrink: 1,
    fontFamily: typography.heading,
    fontSize: 30,
    lineHeight: 34,
  },
  metricCardUnit: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  metricCardDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    lineHeight: 17,
    minHeight: 34,
  },
  metricReadout: {
    marginBottom: 8,
  },
  activitySummaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  activitySummaryLabel: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginBottom: 4,
  },
  activityActionsRow: {
    alignItems: 'flex-end',
    marginTop: 8,
    marginBottom: 4,
  },
  inlineActionButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
  inlineActionText: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
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
  activityBody: {
    flex: 1,
    marginRight: 12,
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
  activityValueText: {
    color: colors.success,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  insightRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  insightDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  insightDot: {
    borderRadius: 5,
    height: 10,
    marginTop: 6,
    width: 10,
  },
  insightBody: {
    flex: 1,
  },
  insightTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  insightDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  emptyText: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
  },
  lastSyncLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
  },
});
