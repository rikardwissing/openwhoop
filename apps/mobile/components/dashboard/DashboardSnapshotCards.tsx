import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { PannableHeartChart } from './PannableHeartChart';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { PulsingHeartIcon } from '@/components/ui/PulsingHeartIcon';
import { StatChip } from '@/components/ui/StatChip';
import { colors, typography } from '@/constants/theme';
import type {
  ActivitySummary,
  DashboardInsight,
  HeartCardSnapshot,
  SleepCardSnapshot,
  StrainCardSnapshot,
} from '@/types/health';
import { formatCompactDuration, formatMetricValue } from '@/utils/formatters';

function accentColorForInsight(accent: DashboardInsight['accent']) {
  switch (accent) {
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

function CardAction({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.actionWrap}>
      <Text numberOfLines={1} style={styles.actionMeta}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.actionButton, pressed ? styles.actionPressed : null]}
        testID={testID}>
        <Text style={styles.actionText}>Open</Text>
        <Ionicons color={colors.primaryBright} name="chevron-forward" size={14} />
      </Pressable>
    </View>
  );
}

export function HeartSnapshotCard({
  canLoadMore = false,
  chartTestID,
  isLoadingMore = false,
  isRefreshing = false,
  liveHeartRateLabel,
  onLoadMore,
  onOpen,
  openTestID,
  showLiveHeartRate = false,
  snapshot,
  trailingLabel,
  viewportKey,
  windowPointCount,
}: {
  canLoadMore?: boolean;
  chartTestID: string;
  isLoadingMore?: boolean;
  isRefreshing?: boolean;
  liveHeartRateLabel?: string | null;
  onLoadMore?: () => void;
  onOpen?: () => void;
  openTestID?: string;
  showLiveHeartRate?: boolean;
  snapshot: HeartCardSnapshot;
  trailingLabel: string;
  viewportKey?: string;
  windowPointCount?: number;
}) {
  const resolvedWindowPointCount = windowPointCount ?? snapshot.series.length;
  const [isViewingLatestWindow, setIsViewingLatestWindow] = useState(true);
  const [latestJumpVersion, setLatestJumpVersion] = useState(0);
  const showsLatestWindowButton = trailingLabel === 'Last 12h';

  useEffect(() => {
    setIsViewingLatestWindow(true);
    setLatestJumpVersion(0);
  }, [viewportKey]);

  return (
    <GlassCard accentColor={colors.success}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <PulsingHeartIcon
            bpm={showLiveHeartRate ? Number(liveHeartRateLabel?.replace(' bpm', '') ?? 0) : null}
            color={colors.success}
            name="heart-circle-outline"
            size={22}
          />
          <Text style={styles.cardTitle}>Heart Rate</Text>
        </View>
        {showsLatestWindowButton ? (
          <View style={styles.actionWrap}>
            <View style={styles.actionButtonRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: isViewingLatestWindow }}
                disabled={isViewingLatestWindow}
                onPress={() => {
                  setLatestJumpVersion((current) => current + 1);
                }}
                style={({ pressed }) => [
                  styles.latestButton,
                  isViewingLatestWindow ? styles.latestButtonIdle : styles.latestButtonActive,
                  pressed && !isViewingLatestWindow ? styles.actionPressed : null,
                ]}
                testID={chartTestID ? `${chartTestID}-latest-button` : undefined}>
                <View
                  style={styles.latestButtonIconSlot}>
                  {isRefreshing ? (
                    <View testID={chartTestID ? `${chartTestID}-refresh-indicator` : undefined}>
                      <ActivityIndicator
                        color={isViewingLatestWindow ? colors.subtle : colors.primaryBright}
                        size="small"
                        style={styles.latestButtonSpinner}
                      />
                    </View>
                  ) : (
                    <Ionicons
                      color={isViewingLatestWindow ? colors.subtle : colors.primaryBright}
                      name="refresh-outline"
                      size={12}
                    />
                  )}
                </View>
                <Text
                  style={[
                    styles.latestButtonText,
                    isViewingLatestWindow ? styles.latestButtonTextIdle : null,
                  ]}>
                  Last 12h
                </Text>
              </Pressable>
              {onOpen ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={onOpen}
                  style={({ pressed }) => [styles.actionButton, pressed ? styles.actionPressed : null]}
                  testID={openTestID}>
                  <Text style={styles.actionText}>Open</Text>
                  <Ionicons color={colors.primaryBright} name="chevron-forward" size={14} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : onOpen ? <CardAction label={trailingLabel} onPress={onOpen} testID={openTestID} /> : <Text style={styles.actionMeta}>{trailingLabel}</Text>}
      </View>

      <View style={styles.metricRow}>
        <View style={styles.metricColumn}>
          <Text style={styles.metricLabel}>Resting HR</Text>
          <Text style={styles.metricValue}>
            {formatMetricValue(snapshot.restingHr, 0)}
            <Text style={styles.metricUnit}> BPM</Text>
          </Text>
        </View>
        <View style={styles.metricColumn}>
          <Text style={styles.metricLabel}>Average</Text>
          <Text style={styles.metricValue}>
            {formatMetricValue(snapshot.averageHr, 0)}
            <Text style={styles.metricUnit}> BPM</Text>
          </Text>
        </View>
        <View style={styles.metricColumn}>
          <Text style={styles.metricLabel}>Max</Text>
          <Text style={[styles.metricValue, styles.metricValueAlert]}>
            {formatMetricValue(snapshot.maxHr, 0)}
            <Text style={styles.metricUnit}> BPM</Text>
          </Text>
        </View>
      </View>

      {showLiveHeartRate && liveHeartRateLabel ? (
        <View style={styles.cardChipRow}>
          <StatChip accent={colors.heart} label="Live" value={liveHeartRateLabel} />
        </View>
      ) : null}

      <PannableHeartChart
        accentColor={colors.primary}
        anchorDayKey={viewportKey}
        axisTestID={chartTestID ? `${chartTestID}-axis` : undefined}
        canLoadMore={canLoadMore}
        chartTestID={chartTestID}
        height={150}
        isLoadingMore={isLoadingMore}
        markers={snapshot.markers}
        jumpToLatestSignal={latestJumpVersion}
        onLoadMore={onLoadMore}
        onViewingLatestWindowChange={setIsViewingLatestWindow}
        points={snapshot.series}
        resetKey={viewportKey}
        windowPointCount={resolvedWindowPointCount}
      />
      {isLoadingMore ? (
        <View style={styles.historyLoaderRow}>
          <ActivityIndicator color={colors.primary} size="small" />
          <Text style={styles.historyLoaderText}>Loading more heart history...</Text>
        </View>
      ) : null}
    </GlassCard>
  );
}

export function HeartSnapshotStatusCard({
  chartTestID,
  isLoading = true,
  liveHeartRateLabel,
  message,
  showLiveHeartRate = false,
  trailingLabel,
}: {
  chartTestID?: string;
  isLoading?: boolean;
  liveHeartRateLabel?: string | null;
  message: string;
  showLiveHeartRate?: boolean;
  trailingLabel: string;
}) {
  const showsLatestWindowButton = trailingLabel === 'Last 12h';

  return (
    <GlassCard accentColor={colors.success}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <PulsingHeartIcon bpm={null} color={colors.success} name="heart-circle-outline" size={22} />
          <Text style={styles.cardTitle}>Heart Rate</Text>
        </View>
        {showsLatestWindowButton ? (
          <View style={styles.actionWrap}>
            <View style={styles.actionButtonRow}>
              <View style={[styles.latestButton, styles.latestButtonIdle]}>
                <Ionicons color={colors.subtle} name="refresh-outline" size={12} />
                <Text style={[styles.latestButtonText, styles.latestButtonTextIdle]}>Last 12h</Text>
              </View>
            </View>
          </View>
        ) : (
          <Text numberOfLines={1} style={styles.actionMeta}>
            {trailingLabel}
          </Text>
        )}
      </View>

      <View style={styles.metricRow}>
        <View style={styles.metricColumn}>
          <Text style={styles.metricLabel}>Resting HR</Text>
          <Text style={styles.metricValue}>
            --
            <Text style={styles.metricUnit}> BPM</Text>
          </Text>
        </View>
        <View style={styles.metricColumn}>
          <Text style={styles.metricLabel}>Average</Text>
          <Text style={styles.metricValue}>
            --
            <Text style={styles.metricUnit}> BPM</Text>
          </Text>
        </View>
        <View style={styles.metricColumn}>
          <Text style={styles.metricLabel}>Max</Text>
          <Text style={styles.metricValue}>
            --
            <Text style={styles.metricUnit}> BPM</Text>
          </Text>
        </View>
      </View>

      {showLiveHeartRate && liveHeartRateLabel ? (
        <View style={styles.cardChipRow}>
          <StatChip accent={colors.heart} label="Live" value={liveHeartRateLabel} />
        </View>
      ) : null}

      <View
        style={styles.heartStatusChartShell}
        testID={chartTestID ? `${chartTestID}-loading-shell` : undefined}>
        <View style={styles.heartStatusRow}>
          {isLoading ? <ActivityIndicator color={colors.primary} size="small" /> : null}
          <Text style={styles.heartStatusText}>{message}</Text>
        </View>
      </View>
    </GlassCard>
  );
}

export function SleepSnapshotCard({
  chartTestID,
  onOpen,
  openTestID,
  snapshot,
  trailingLabel,
}: {
  chartTestID: string;
  onOpen: () => void;
  openTestID: string;
  snapshot: SleepCardSnapshot;
  trailingLabel: string;
}) {
  return (
    <GlassCard accentColor={colors.violet}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <Ionicons color={colors.violet} name="moon-outline" size={20} />
          <Text style={styles.cardTitle}>Sleep</Text>
        </View>
        <CardAction label={trailingLabel} onPress={onOpen} testID={openTestID} />
      </View>

      <View style={styles.sleepSummary}>
        <View>
          <Text style={styles.sleepScore}>{formatMetricValue(snapshot.score, 0)}%</Text>
          <Text style={styles.sleepDuration}>{formatCompactDuration(snapshot.durationMinutes)}</Text>
        </View>
        <View style={styles.sleepMeta}>
          <Text style={styles.metricLabel}>In bed</Text>
          <Text style={styles.sleepMetaValue}>{formatCompactDuration(snapshot.timeInBedMinutes)}</Text>
          <Text style={styles.sleepMetaCaption}>
            {snapshot.startLabel} to {snapshot.endLabel}
          </Text>
        </View>
      </View>

      <SleepStageChart
        accentColor={colors.violet}
        endLabel={snapshot.endLabel}
        middleLabel={snapshot.middleLabel}
        segments={snapshot.stages}
        startLabel={snapshot.startLabel}
        testID={chartTestID}
      />
    </GlassCard>
  );
}

export function ActivitySnapshotCard({
  activities,
  chartTestID,
  onOpen,
  openTestID,
  strainCard,
  trailingLabel,
}: {
  activities: readonly ActivitySummary[];
  chartTestID: string;
  onOpen: () => void;
  openTestID: string;
  strainCard: StrainCardSnapshot;
  trailingLabel: string;
}) {
  return (
    <GlassCard accentColor={colors.aqua}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <Ionicons color={colors.aqua} name="walk-outline" size={20} />
          <Text style={styles.cardTitle}>Activity</Text>
        </View>
        <CardAction label={trailingLabel} onPress={onOpen} testID={openTestID} />
      </View>

      <View style={styles.cardChipRow}>
        <StatChip
          accent={colors.cyan}
          label="Day strain"
          value={strainCard.score === null ? '--' : strainCard.score.toFixed(1)}
        />
        <StatChip accent={colors.success} label="Sessions" value={`${activities.length}`} />
      </View>
      <Text style={styles.activityLabel}>{strainCard.label}</Text>

      <TrendChart
        accentColor={colors.cyan}
        height={112}
        points={strainCard.series}
        selectionValueFormatter={(selection) =>
          selection.point.value === null ? 'No data' : `${selection.point.value.toFixed(1)} strain`
        }
        testID={chartTestID}
      />

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

export function InsightsCard({
  insights,
  trailingLabel,
}: {
  insights: readonly DashboardInsight[];
  trailingLabel: string;
}) {
  return (
    <GlassCard accentColor={colors.primaryBright}>
      <SectionHeader title="Insights" trailing={trailingLabel} />
      {insights.length === 0 ? (
        <Text style={styles.emptyText}>Insights will appear once more history is available.</Text>
      ) : (
        insights.map((insight, index) => (
          <View
            key={insight.id}
            style={[styles.insightRow, index < insights.length - 1 ? styles.insightDivider : null]}>
            <View
              style={[
                styles.insightDot,
                {
                  backgroundColor: accentColorForInsight(insight.accent),
                },
              ]}
            />
            <View style={styles.insightBody}>
              <Text style={styles.insightTitle}>{insight.title}</Text>
              <Text style={styles.insightDetail}>{insight.detail}</Text>
            </View>
          </View>
        ))
      )}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  actionWrap: {
    alignItems: 'flex-end',
    gap: 8,
    maxWidth: '62%',
  },
  actionMeta: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
  },
  actionButtonRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'flex-end',
  },
  actionButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  actionText: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  actionPressed: {
    opacity: 0.82,
  },
  latestButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  latestButtonIdle: {
    backgroundColor: 'rgba(112, 132, 144, 0.08)',
    borderColor: 'rgba(112, 132, 144, 0.16)',
  },
  latestButtonActive: {
    backgroundColor: 'rgba(236, 255, 114, 0.08)',
    borderColor: 'rgba(236, 255, 114, 0.18)',
  },
  latestButtonText: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 11,
  },
  latestButtonTextIdle: {
    color: colors.subtle,
  },
  cardHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardHeaderLeft: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  cardTitle: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 22,
    lineHeight: 26,
  },
  metricRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
  },
  metricColumn: {
    flex: 1,
  },
  metricLabel: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    textTransform: 'uppercase',
  },
  metricValue: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 28,
    lineHeight: 34,
    marginTop: 6,
  },
  metricValueAlert: {
    color: colors.heart,
  },
  metricUnit: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  cardChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 10,
  },
  historyLoaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  historyLoaderText: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
  },
  heartStatusChartShell: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 150,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  latestButtonIconSlot: {
    alignItems: 'center',
    height: 12,
    justifyContent: 'center',
    width: 12,
  },
  latestButtonSpinner: {
    transform: [{ scale: 0.7 }],
  },
  heartStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    maxWidth: '88%',
  },
  heartStatusText: {
    color: colors.muted,
    flex: 1,
    fontFamily: typography.body,
    fontSize: 14,
    lineHeight: 20,
  },
  sleepSummary: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sleepScore: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 38,
    lineHeight: 42,
  },
  sleepDuration: {
    color: colors.violet,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
    marginTop: 4,
  },
  sleepMeta: {
    alignItems: 'flex-end',
    maxWidth: '44%',
  },
  sleepMetaValue: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 22,
    marginTop: 6,
  },
  sleepMetaCaption: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
    textAlign: 'right',
  },
  activityLabel: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    marginBottom: 8,
  },
  emptyText: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 14,
    lineHeight: 20,
  },
  activityRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  activityDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  activityBody: {
    flex: 1,
    paddingRight: 12,
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
    color: colors.text,
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
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  insightDot: {
    borderRadius: 999,
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
    fontSize: 14,
  },
  insightDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
});
