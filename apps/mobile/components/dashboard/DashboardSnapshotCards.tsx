import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { PannableHeartChart } from './PannableHeartChart';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { PulsingHeartIcon } from '@/components/ui/PulsingHeartIcon';
import { StatChip } from '@/components/ui/StatChip';
import { colors, sleepStageColors, typography } from '@/constants/theme';
import type { ManualActivityKind } from '@/data/HealthRepository';
import type {
  ActivitySummary,
  DashboardInsight,
  HeartCardSnapshot,
  HeartIntradayMarker,
  SleepStage,
  SleepCardSnapshot,
  StrainCardSnapshot,
} from '@/types/health';
import { formatCompactDuration, formatMetricValue, formatShortDuration } from '@/utils/formatters';
import {
  canManageHeartIntradayMarker,
  getHeartIntradayMarkerPresentation,
  getHeartIntradayMarkerReviewLabel,
  getHeartIntradayMarkerTrustState,
} from '@/utils/heartChartMarkers';

interface HeartMetricColumn {
  label: string;
  value: string;
  unit?: string;
  valueColor?: string;
}

interface HeartMetricChip {
  accentColor: string;
  label: string;
  value: string;
}

interface FocusedHeartCardContent {
  accentColor: string;
  chartAccentColor: string;
  iconName: ReturnType<typeof getHeartIntradayMarkerPresentation>['iconName'];
  subtitle: string;
  title: string;
  metrics: HeartMetricColumn[];
  chips: HeartMetricChip[];
  stageChips: HeartMetricChip[];
}

const HEART_CARD_CHART_HEIGHT = 150;
const HEART_CARD_CHROME_OUT_DURATION_MS = 140;
const HEART_CARD_CHROME_IN_DURATION_MS = 180;
const HEART_CARD_CHROME_STAGE_DELAY_MS = 60;
const SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS = 220;
const SLEEP_STAGE_PANEL_MAX_HEIGHT = 120;
const SLEEP_STAGE_PANEL_STAGE_DELAY_MS = HEART_CARD_CHROME_STAGE_DELAY_MS * 3;
const SLEEP_STAGE_CHIP_STAGE_DELAY_MS = SLEEP_STAGE_PANEL_STAGE_DELAY_MS + 20;
const ACTIVITY_DETAIL_PANEL_MAX_HEIGHT = 220;
const ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS = HEART_CARD_CHROME_STAGE_DELAY_MS * 3;
const ACTIVITY_DETAIL_CHIP_STAGE_DELAY_MS = ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS + 20;
const REVIEW_ACTIVITY_OPTIONS: ManualActivityKind[] = ['Activity', 'Walk', 'Workout', 'Nap'];

interface HeartActivityReviewActions {
  confirmActivity: (activityId: string) => Promise<void>;
  dismissActivity: (activityId: string) => Promise<void>;
  relabelActivity: (activityId: string, activity: ManualActivityKind) => Promise<void>;
}

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

function ReviewActionButton({
  accentColor,
  disabled = false,
  label,
  onPress,
  testID,
}: {
  accentColor: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.reviewActionButton,
        { borderColor: accentColor },
        disabled ? styles.reviewActionButtonDisabled : null,
        pressed ? styles.actionPressed : null,
      ]}
      testID={testID}>
      <Text style={[styles.reviewActionButtonLabel, { color: accentColor }]}>{label}</Text>
    </Pressable>
  );
}

function clampIndex(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function summarizeMarkerHeartValues(snapshot: HeartCardSnapshot, marker: HeartIntradayMarker) {
  if (snapshot.series.length === 0) {
    return {
      averageHr: null,
      minHr: null,
      maxHr: null,
    };
  }

  const lastIndex = snapshot.series.length - 1;
  const startIndex = clampIndex(Math.floor(marker.startFraction * lastIndex), 0, lastIndex);
  const endIndex = clampIndex(Math.ceil(marker.endFraction * lastIndex), startIndex, lastIndex);
  const values = snapshot.series
    .slice(startIndex, endIndex + 1)
    .map((point) => point.value)
    .filter((value): value is number => value !== null);

  if (values.length === 0) {
    return {
      averageHr: null,
      minHr: null,
      maxHr: null,
    };
  }

  return {
    averageHr: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    minHr: Math.min(...values),
    maxHr: Math.max(...values),
  };
}

function buildSleepStageTotals(stages: NonNullable<HeartIntradayMarker['details']>['stages']) {
  const totals = new Map<SleepStage, number>();

  for (const stage of stages ?? []) {
    totals.set(stage.stage, (totals.get(stage.stage) ?? 0) + stage.minutes);
  }

  return (['light', 'rem', 'deep', 'awake'] as SleepStage[])
    .map((stage) => ({
      stage,
      minutes: totals.get(stage) ?? 0,
    }))
    .filter((stage) => stage.minutes > 0);
}

function formatSleepStageName(stage: SleepStage) {
  if (stage === 'rem') {
    return 'REM';
  }

  return `${stage[0]?.toUpperCase() ?? ''}${stage.slice(1)}`;
}

function activityReviewAccentColor(marker: HeartIntradayMarker) {
  if (marker.details?.source === 'manual') {
    return colors.primaryBright;
  }

  switch (marker.details?.reviewState) {
    case 'confirmed':
      return colors.success;
    case 'relabelled':
      return colors.aqua;
    default:
      return getHeartIntradayMarkerTrustState(marker) === 'suggested' ? colors.heart : colors.success;
  }
}

function buildActivityMarkerChips(marker: HeartIntradayMarker): HeartMetricChip[] {
  const chips: HeartMetricChip[] = [];
  const reviewLabel = getHeartIntradayMarkerReviewLabel(marker);

  if (reviewLabel) {
    chips.push({
      accentColor: activityReviewAccentColor(marker),
      label: 'Status',
      value: reviewLabel,
    });
  }

  if (marker.details?.source === 'detected' && typeof marker.details.confidence === 'number') {
    chips.push({
      accentColor: getHeartIntradayMarkerTrustState(marker) === 'suggested' ? colors.heart : colors.cyan,
      label: 'Confidence',
      value: `${Math.round(marker.details.confidence * 100)}%`,
    });
  }

  return chips;
}

function buildUpdatedActivityMarker(
  marker: HeartIntradayMarker,
  updates: { label?: ManualActivityKind; reviewState?: 'confirmed' | 'relabelled' },
): HeartIntradayMarker {
  const nextLabel = updates.label ?? (marker.label as ManualActivityKind);

  return {
    ...marker,
    kind: nextLabel === 'Nap' ? 'nap' : 'activity',
    label: nextLabel,
    details: {
      ...marker.details,
      durationMinutes: marker.details?.durationMinutes ?? null,
      source: marker.details?.source ?? 'detected',
      reviewState: updates.reviewState ?? marker.details?.reviewState ?? 'none',
    },
  };
}

function applyHeartMarkerOverrides(
  markers: readonly HeartIntradayMarker[],
  overrides: Readonly<Record<string, HeartIntradayMarker | null>>,
) {
  return markers.flatMap((marker) => {
    const override = overrides[marker.id];

    if (override === null) {
      return [];
    }

    return [override ?? marker];
  });
}

function buildFocusedHeartCardContent(
  snapshot: HeartCardSnapshot,
  marker: HeartIntradayMarker | null,
): FocusedHeartCardContent | null {
  if (!marker) {
    return null;
  }

  const presentation = getHeartIntradayMarkerPresentation(marker);
  const seriesSummary = summarizeMarkerHeartValues(snapshot, marker);

  if (marker.kind === 'sleep') {
    const sleepDetails = marker.details;
    const stageTotals = buildSleepStageTotals(sleepDetails?.stages);
    const asleepMinutes = sleepDetails?.asleepMinutes ?? sleepDetails?.durationMinutes ?? null;
    const timeInBedMinutes = sleepDetails?.timeInBedMinutes ?? sleepDetails?.durationMinutes ?? null;
    const efficiency =
      asleepMinutes !== null && timeInBedMinutes !== null && timeInBedMinutes > 0
        ? Math.round((asleepMinutes / timeInBedMinutes) * 100)
        : null;

    return {
      accentColor: presentation.accentColor,
      chartAccentColor: presentation.accentColor,
      iconName: presentation.iconName,
      subtitle: marker.timeLabel,
      title: marker.label,
      metrics: [
        {
          label: 'Score',
          value: formatMetricValue(sleepDetails?.score ?? null, 0),
          unit: '%',
        },
        {
          label: 'Asleep',
          value: formatCompactDuration(asleepMinutes),
        },
        {
          label: 'Efficiency',
          value: formatMetricValue(efficiency, 0),
          unit: '%',
        },
      ],
      chips: [],
      stageChips: stageTotals.map((stage) => ({
        accentColor: sleepStageColors[stage.stage],
        label: formatSleepStageName(stage.stage),
        value: formatShortDuration(stage.minutes),
      })),
    };
  }

  return {
    accentColor: presentation.accentColor,
    chartAccentColor: presentation.accentColor,
    iconName: presentation.iconName,
    subtitle: marker.timeLabel,
    title: marker.label,
    metrics: [
      {
        label: 'Duration',
        value: formatCompactDuration(marker.details?.durationMinutes ?? null),
      },
      {
        label: 'Average',
        value: formatMetricValue(seriesSummary.averageHr, 0),
        unit: 'BPM',
      },
      marker.kind === 'nap'
        ? {
            label: 'Lowest',
            value: formatMetricValue(seriesSummary.minHr, 0),
            unit: 'BPM',
            valueColor: colors.aqua,
          }
        : {
            label: 'Max',
            value: formatMetricValue(seriesSummary.maxHr, 0),
            unit: 'BPM',
            valueColor: colors.heart,
          },
    ],
      chips: buildActivityMarkerChips(marker),
    stageChips: [],
  };
}

export function HeartSnapshotCard({
  activityReviewActions,
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
  activityReviewActions?: HeartActivityReviewActions;
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
  const [activityMarkerOverrides, setActivityMarkerOverrides] = useState<Record<string, HeartIntradayMarker | null>>({});
  const [pendingActivityActionKey, setPendingActivityActionKey] = useState<string | null>(null);
  const [activityActionError, setActivityActionError] = useState<string | null>(null);
  const [relabelModalVisible, setRelabelModalVisible] = useState(false);
  const resolvedMarkers = useMemo(
    () => applyHeartMarkerOverrides(snapshot.markers, activityMarkerOverrides),
    [activityMarkerOverrides, snapshot.markers],
  );
  const [focusedMarkerTarget, setFocusedMarkerTarget] = useState<HeartIntradayMarker | null>(null);
  const [focusedMarker, setFocusedMarker] = useState<HeartIntradayMarker | null>(null);
  const [selectedSleepStage, setSelectedSleepStage] = useState<SleepStage | null>(null);
  const [isSleepStagePanelMounted, setIsSleepStagePanelMounted] = useState(false);
  const [isActivityDetailPanelMounted, setIsActivityDetailPanelMounted] = useState(false);
  const [renderedSleepStageChips, setRenderedSleepStageChips] = useState<HeartMetricChip[]>([]);
  const isFocusTransitioningRef = useRef(false);
  const pendingFocusedMarkerRef = useRef<HeartIntradayMarker | null>(null);
  const sleepStagePanelUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityDetailPanelUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showsLatestWindowButton = trailingLabel === 'Last 12h';
  const focusedCardTargetContent = buildFocusedHeartCardContent(snapshot, focusedMarkerTarget);
  const focusedCardContent = buildFocusedHeartCardContent(snapshot, focusedMarker);
  const cardAccentColor = focusedCardTargetContent?.accentColor ?? colors.success;
  const chartAccentColor = focusedCardTargetContent?.chartAccentColor ?? colors.primary;
  const isSleepFocused = focusedMarker?.kind === 'sleep';
  const isActivityFocused = focusedMarker?.kind === 'activity' || focusedMarker?.kind === 'nap';
  const canManageFocusedActivity = Boolean(activityReviewActions && focusedMarker && canManageHeartIntradayMarker(focusedMarker));
  const activityDetailChips = isActivityFocused ? focusedCardContent?.chips ?? [] : [];
  const sleepStageChips = focusedCardContent?.stageChips ?? [];
  const sleepStageChipSignature = sleepStageChips
    .map((chip) => `${chip.label}:${chip.value}:${chip.accentColor}`)
    .join('|');
  const sleepStagePanelVisible = isSleepFocused && sleepStageChips.length > 0;
  const activityDetailPanelVisible =
    isActivityFocused &&
    (activityDetailChips.length > 0 || canManageFocusedActivity || activityActionError !== null);
  const cardHeaderTransitionProgress = useSharedValue(1);
  const cardMetricsTransitionProgress = useSharedValue(1);
  const cardChipsTransitionProgress = useSharedValue(1);
  const sleepStagePanelMaxHeight = useSharedValue(0);
  const sleepStagePanelOpacity = useSharedValue(0);
  const sleepStagePanelMarginTop = useSharedValue(0);
  const sleepStageChipTransitionProgress = useSharedValue(0);
  const activityDetailPanelMaxHeight = useSharedValue(0);
  const activityDetailPanelOpacity = useSharedValue(0);
  const activityDetailPanelMarginTop = useSharedValue(0);
  const activityDetailTransitionProgress = useSharedValue(0);
  const chartHeight = HEART_CARD_CHART_HEIGHT;
  const cardTitle = focusedCardContent?.title ?? 'Heart Rate';
  const defaultCardSubtitle =
    showLiveHeartRate && liveHeartRateLabel ? liveHeartRateLabel : 'Explore your heart rate';
  const cardSubtitle = focusedCardContent?.subtitle ?? defaultCardSubtitle;
  const metricColumns: HeartMetricColumn[] = focusedCardContent?.metrics ?? [
    {
      label: 'Resting HR',
      value: formatMetricValue(snapshot.restingHr, 0),
      unit: 'BPM',
    },
    {
      label: 'Average',
      value: formatMetricValue(snapshot.averageHr, 0),
      unit: 'BPM',
    },
    {
      label: 'Max',
      value: formatMetricValue(snapshot.maxHr, 0),
      unit: 'BPM',
      valueColor: colors.heart,
    },
  ];

  const animateCardChromeStages = useCallback(
    (target: 0 | 1) => {
      const duration =
        target === 0 ? HEART_CARD_CHROME_OUT_DURATION_MS : HEART_CARD_CHROME_IN_DURATION_MS;

      cancelAnimation(cardHeaderTransitionProgress);
      cancelAnimation(cardMetricsTransitionProgress);
      cancelAnimation(cardChipsTransitionProgress);

      cardHeaderTransitionProgress.value = withDelay(
        0,
        withTiming(target, {
          duration,
          easing: Easing.out(Easing.cubic),
        }),
      );
      cardMetricsTransitionProgress.value = withDelay(
        HEART_CARD_CHROME_STAGE_DELAY_MS,
        withTiming(target, {
          duration,
          easing: Easing.out(Easing.cubic),
        }),
      );
      cardChipsTransitionProgress.value = withDelay(
        HEART_CARD_CHROME_STAGE_DELAY_MS * 2,
        withTiming(target, {
          duration,
          easing: Easing.out(Easing.cubic),
        }),
      );
    },
    [cardChipsTransitionProgress, cardHeaderTransitionProgress, cardMetricsTransitionProgress],
  );

  const handleFocusedMarkerChange = useCallback((nextMarker: HeartIntradayMarker | null) => {
    pendingFocusedMarkerRef.current = nextMarker;
    setFocusedMarkerTarget((current) => (current === nextMarker ? current : nextMarker));

    if (isFocusTransitioningRef.current) {
      return;
    }

    startTransition(() => {
      setFocusedMarker(nextMarker);
    });
  }, []);

  const handleFocusTransitionStateChange = useCallback((isTransitioning: boolean) => {
    isFocusTransitioningRef.current = isTransitioning;

    if (isTransitioning) {
      animateCardChromeStages(0);
      return;
    }

    startTransition(() => {
      setFocusedMarker(pendingFocusedMarkerRef.current);
    });
  }, [animateCardChromeStages]);

  const clearActivityMarkerOverride = useCallback((activityId: string) => {
    setActivityMarkerOverrides((current) => {
      const next = { ...current };
      delete next[activityId];
      return next;
    });
  }, []);

  const handleConfirmFocusedActivity = useCallback(async () => {
    if (!activityReviewActions || !focusedMarker || !canManageHeartIntradayMarker(focusedMarker)) {
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey(`confirm:${focusedMarker.id}`);
    setActivityMarkerOverrides((current) => ({
      ...current,
      [focusedMarker.id]: buildUpdatedActivityMarker(focusedMarker, { reviewState: 'confirmed' }),
    }));

    try {
      await activityReviewActions.confirmActivity(focusedMarker.id);
    } catch (error) {
      clearActivityMarkerOverride(focusedMarker.id);
      setActivityActionError(error instanceof Error ? error.message : 'Unable to confirm this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [activityReviewActions, clearActivityMarkerOverride, focusedMarker]);

  const handleDismissFocusedActivity = useCallback(async () => {
    if (!activityReviewActions || !focusedMarker || !canManageHeartIntradayMarker(focusedMarker)) {
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey(`dismiss:${focusedMarker.id}`);
    setActivityMarkerOverrides((current) => ({
      ...current,
      [focusedMarker.id]: null,
    }));
    setLatestJumpVersion((current) => current + 1);

    try {
      await activityReviewActions.dismissActivity(focusedMarker.id);
    } catch (error) {
      clearActivityMarkerOverride(focusedMarker.id);
      setActivityActionError(error instanceof Error ? error.message : 'Unable to dismiss this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [activityReviewActions, clearActivityMarkerOverride, focusedMarker]);

  const handleRelabelFocusedActivity = useCallback(async (activity: ManualActivityKind) => {
    if (!activityReviewActions || !focusedMarker || !canManageHeartIntradayMarker(focusedMarker)) {
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey(`relabel:${focusedMarker.id}`);
    setActivityMarkerOverrides((current) => ({
      ...current,
      [focusedMarker.id]: buildUpdatedActivityMarker(focusedMarker, {
        label: activity,
        reviewState: 'relabelled',
      }),
    }));

    try {
      await activityReviewActions.relabelActivity(focusedMarker.id, activity);
      setRelabelModalVisible(false);
    } catch (error) {
      clearActivityMarkerOverride(focusedMarker.id);
      setActivityActionError(error instanceof Error ? error.message : 'Unable to relabel this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [activityReviewActions, clearActivityMarkerOverride, focusedMarker]);

  useEffect(() => {
    setIsViewingLatestWindow(true);
    setLatestJumpVersion(0);
    setActivityMarkerOverrides({});
    setPendingActivityActionKey(null);
    setActivityActionError(null);
    setRelabelModalVisible(false);
    isFocusTransitioningRef.current = false;
    pendingFocusedMarkerRef.current = null;
    cardHeaderTransitionProgress.value = 1;
    cardMetricsTransitionProgress.value = 1;
    cardChipsTransitionProgress.value = 1;
    sleepStageChipTransitionProgress.value = 0;
    activityDetailTransitionProgress.value = 0;
    if (sleepStagePanelUnmountTimeoutRef.current !== null) {
      clearTimeout(sleepStagePanelUnmountTimeoutRef.current);
      sleepStagePanelUnmountTimeoutRef.current = null;
    }
    if (activityDetailPanelUnmountTimeoutRef.current !== null) {
      clearTimeout(activityDetailPanelUnmountTimeoutRef.current);
      activityDetailPanelUnmountTimeoutRef.current = null;
    }
    setIsSleepStagePanelMounted(false);
    setIsActivityDetailPanelMounted(false);
    setRenderedSleepStageChips([]);
    setFocusedMarkerTarget(null);
    setFocusedMarker(null);
    setSelectedSleepStage(null);
  }, [
    cardChipsTransitionProgress,
    cardHeaderTransitionProgress,
    cardMetricsTransitionProgress,
    activityDetailTransitionProgress,
    sleepStageChipTransitionProgress,
    viewportKey,
  ]);

  useEffect(() => {
    if (isFocusTransitioningRef.current) {
      return;
    }

    animateCardChromeStages(1);
  }, [animateCardChromeStages, focusedMarker?.id]);

  useEffect(() => {
    setSelectedSleepStage(null);
  }, [focusedMarker?.id]);

  useEffect(() => {
    setActivityActionError(null);

    if (!canManageFocusedActivity) {
      setRelabelModalVisible(false);
    }
  }, [canManageFocusedActivity, focusedMarker?.id]);

  const handleSleepStagePress = useCallback((stage: SleepStage) => {
    setSelectedSleepStage((current) => (current === stage ? null : stage));
  }, []);

  useEffect(() => {
    if (sleepStagePanelVisible) {
      if (sleepStagePanelUnmountTimeoutRef.current !== null) {
        clearTimeout(sleepStagePanelUnmountTimeoutRef.current);
        sleepStagePanelUnmountTimeoutRef.current = null;
      }

      setRenderedSleepStageChips(sleepStageChips);
      setIsSleepStagePanelMounted(true);
      return;
    }

    if (!isSleepStagePanelMounted) {
      return;
    }

    if (sleepStagePanelUnmountTimeoutRef.current !== null) {
      clearTimeout(sleepStagePanelUnmountTimeoutRef.current);
    }

    sleepStagePanelUnmountTimeoutRef.current = setTimeout(() => {
      sleepStagePanelUnmountTimeoutRef.current = null;
      setIsSleepStagePanelMounted(false);
      setRenderedSleepStageChips([]);
    }, SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS);
  }, [isSleepStagePanelMounted, sleepStageChipSignature, sleepStagePanelVisible]);

  useEffect(() => {
    if (activityDetailPanelVisible) {
      if (activityDetailPanelUnmountTimeoutRef.current !== null) {
        clearTimeout(activityDetailPanelUnmountTimeoutRef.current);
        activityDetailPanelUnmountTimeoutRef.current = null;
      }

      setIsActivityDetailPanelMounted(true);
      return;
    }

    if (!isActivityDetailPanelMounted) {
      return;
    }

    if (activityDetailPanelUnmountTimeoutRef.current !== null) {
      clearTimeout(activityDetailPanelUnmountTimeoutRef.current);
    }

    activityDetailPanelUnmountTimeoutRef.current = setTimeout(() => {
      activityDetailPanelUnmountTimeoutRef.current = null;
      setIsActivityDetailPanelMounted(false);
    }, SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS);
  }, [activityDetailPanelVisible, isActivityDetailPanelMounted]);

  useEffect(() => {
    const nextMaxHeight = sleepStagePanelVisible ? SLEEP_STAGE_PANEL_MAX_HEIGHT : 0;
    const nextOpacity = sleepStagePanelVisible ? 1 : 0;
    const nextMarginTop = sleepStagePanelVisible ? 12 : 0;
    const panelDelay = sleepStagePanelVisible ? SLEEP_STAGE_PANEL_STAGE_DELAY_MS : 0;
    const chipDelay = sleepStagePanelVisible ? SLEEP_STAGE_CHIP_STAGE_DELAY_MS : 0;

    cancelAnimation(sleepStagePanelMaxHeight);
    cancelAnimation(sleepStagePanelOpacity);
    cancelAnimation(sleepStagePanelMarginTop);
    cancelAnimation(sleepStageChipTransitionProgress);

    sleepStagePanelMaxHeight.value = withDelay(
      panelDelay,
      withTiming(nextMaxHeight, {
        duration: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
    sleepStagePanelOpacity.value = withDelay(
      panelDelay,
      withTiming(nextOpacity, {
        duration: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
    sleepStagePanelMarginTop.value = withDelay(
      panelDelay,
      withTiming(nextMarginTop, {
        duration: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
    sleepStageChipTransitionProgress.value = withDelay(
      chipDelay,
      withTiming(sleepStagePanelVisible ? 1 : 0, {
        duration:
          sleepStagePanelVisible ? HEART_CARD_CHROME_IN_DURATION_MS : HEART_CARD_CHROME_OUT_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
  }, [
    sleepStageChipTransitionProgress,
    sleepStagePanelMaxHeight,
    sleepStagePanelMarginTop,
    sleepStagePanelOpacity,
    sleepStagePanelVisible,
  ]);

  useEffect(() => {
    const nextMaxHeight = activityDetailPanelVisible ? ACTIVITY_DETAIL_PANEL_MAX_HEIGHT : 0;
    const nextOpacity = activityDetailPanelVisible ? 1 : 0;
    const nextMarginTop = activityDetailPanelVisible ? 12 : 0;
    const panelDelay = activityDetailPanelVisible ? ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS : 0;
    const contentDelay = activityDetailPanelVisible ? ACTIVITY_DETAIL_CHIP_STAGE_DELAY_MS : 0;

    cancelAnimation(activityDetailPanelMaxHeight);
    cancelAnimation(activityDetailPanelOpacity);
    cancelAnimation(activityDetailPanelMarginTop);
    cancelAnimation(activityDetailTransitionProgress);

    activityDetailPanelMaxHeight.value = withDelay(
      panelDelay,
      withTiming(nextMaxHeight, {
        duration: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
    activityDetailPanelOpacity.value = withDelay(
      panelDelay,
      withTiming(nextOpacity, {
        duration: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
    activityDetailPanelMarginTop.value = withDelay(
      panelDelay,
      withTiming(nextMarginTop, {
        duration: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
    activityDetailTransitionProgress.value = withDelay(
      contentDelay,
      withTiming(activityDetailPanelVisible ? 1 : 0, {
        duration:
          activityDetailPanelVisible ? HEART_CARD_CHROME_IN_DURATION_MS : HEART_CARD_CHROME_OUT_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    );
  }, [
    activityDetailPanelMarginTop,
    activityDetailPanelMaxHeight,
    activityDetailPanelOpacity,
    activityDetailPanelVisible,
    activityDetailTransitionProgress,
  ]);

  useEffect(
    () => () => {
      if (sleepStagePanelUnmountTimeoutRef.current !== null) {
        clearTimeout(sleepStagePanelUnmountTimeoutRef.current);
      }

      if (activityDetailPanelUnmountTimeoutRef.current !== null) {
        clearTimeout(activityDetailPanelUnmountTimeoutRef.current);
      }
    },
    [],
  );

  const animatedSleepStagePanelStyle = useAnimatedStyle(
    () => ({
      maxHeight: sleepStagePanelMaxHeight.value,
      marginTop: sleepStagePanelMarginTop.value,
      opacity: sleepStagePanelOpacity.value,
    }),
    [sleepStagePanelMarginTop, sleepStagePanelMaxHeight, sleepStagePanelOpacity],
  );

  const animatedSleepStageChipStageStyle = useAnimatedStyle(
    () => ({
      opacity: sleepStageChipTransitionProgress.value,
      transform: [
        { translateY: (1 - sleepStageChipTransitionProgress.value) * -6 },
        { scale: 0.99 + sleepStageChipTransitionProgress.value * 0.01 },
      ],
    }),
    [sleepStageChipTransitionProgress],
  );

  const animatedActivityDetailPanelStyle = useAnimatedStyle(
    () => ({
      maxHeight: activityDetailPanelMaxHeight.value,
      marginTop: activityDetailPanelMarginTop.value,
      opacity: activityDetailPanelOpacity.value,
    }),
    [activityDetailPanelMarginTop, activityDetailPanelMaxHeight, activityDetailPanelOpacity],
  );

  const animatedActivityDetailStageStyle = useAnimatedStyle(
    () => ({
      opacity: activityDetailTransitionProgress.value,
      transform: [
        { translateY: (1 - activityDetailTransitionProgress.value) * -6 },
        { scale: 0.99 + activityDetailTransitionProgress.value * 0.01 },
      ],
    }),
    [activityDetailTransitionProgress],
  );

  const animatedCardHeaderStageStyle = useAnimatedStyle(
    () => ({
      opacity: cardHeaderTransitionProgress.value,
      transform: [
        { translateY: (1 - cardHeaderTransitionProgress.value) * -12 },
        { scale: 0.99 + cardHeaderTransitionProgress.value * 0.01 },
      ],
    }),
    [cardHeaderTransitionProgress],
  );

  const animatedCardMetricsStageStyle = useAnimatedStyle(
    () => ({
      opacity: cardMetricsTransitionProgress.value,
      transform: [
        { translateY: (1 - cardMetricsTransitionProgress.value) * -8 },
        { scale: 0.988 + cardMetricsTransitionProgress.value * 0.012 },
      ],
    }),
    [cardMetricsTransitionProgress],
  );

  const animatedCardChipsStageStyle = useAnimatedStyle(
    () => ({
      opacity: cardChipsTransitionProgress.value,
      transform: [
        { translateY: (1 - cardChipsTransitionProgress.value) * -6 },
        { scale: 0.99 + cardChipsTransitionProgress.value * 0.01 },
      ],
    }),
    [cardChipsTransitionProgress],
  );

  return (
    <GlassCard accentColor={cardAccentColor}>
      <Animated.View style={animatedCardHeaderStageStyle}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            {focusedCardContent ? (
              <View
                style={[
                  styles.cardIconWrap,
                  {
                    backgroundColor: `${cardAccentColor}18`,
                    borderColor: `${cardAccentColor}33`,
                  },
                ]}>
                <Ionicons color={cardAccentColor} name={focusedCardContent.iconName} size={16} />
              </View>
            ) : (
              <View
                style={[
                  styles.cardIconWrap,
                  {
                    backgroundColor: `${colors.success}18`,
                    borderColor: `${colors.success}33`,
                  },
                ]}>
                <PulsingHeartIcon
                  bpm={showLiveHeartRate ? Number(liveHeartRateLabel?.replace(' bpm', '') ?? 0) : null}
                  color={colors.success}
                  name="heart-circle-outline"
                  size={16}
                />
              </View>
            )}
            <View style={styles.cardHeaderTextStack}>
              <Text style={styles.cardTitle} testID={chartTestID ? `${chartTestID}-title` : undefined}>
                {cardTitle}
              </Text>
              <Text style={styles.cardSubtitle}>{cardSubtitle}</Text>
            </View>
          </View>
          {focusedCardContent ? (
            <View style={styles.actionWrap}>
              <View style={styles.actionButtonRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setLatestJumpVersion((current) => current + 1);
                  }}
                  style={({ pressed }) => [
                    styles.focusedActionButton,
                    {
                      backgroundColor: `${cardAccentColor}14`,
                      borderColor: `${cardAccentColor}33`,
                    },
                    pressed ? styles.actionPressed : null,
                  ]}
                  testID={chartTestID ? `${chartTestID}-return-button` : undefined}>
                  <Ionicons color={cardAccentColor} name="arrow-back-outline" size={12} />
                  <Text style={[styles.focusedActionText, { color: cardAccentColor }]}>Return</Text>
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
          ) : showsLatestWindowButton ? (
            <View style={styles.actionWrap}>
              <View style={styles.actionButtonRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isViewingLatestWindow }}
                  disabled={isViewingLatestWindow}
                  onPress={() => {
                    setIsViewingLatestWindow(true);
                    setLatestJumpVersion((current) => current + 1);
                  }}
                  style={({ pressed }) => [
                    styles.latestButton,
                    isViewingLatestWindow ? styles.latestButtonIdle : styles.latestButtonActive,
                    pressed && !isViewingLatestWindow ? styles.actionPressed : null,
                  ]}
                  testID={chartTestID ? `${chartTestID}-latest-button` : undefined}>
                  <View style={styles.latestButtonIconSlot}>
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
      </Animated.View>

      <Animated.View style={animatedCardMetricsStageStyle}>
        <View style={styles.metricRow}>
          {metricColumns.map((metric) => (
            <View key={metric.label} style={styles.metricColumn}>
              <Text style={styles.metricLabel}>{metric.label}</Text>
              <Text style={[styles.metricValue, metric.valueColor ? { color: metric.valueColor } : null]}>
                {metric.value}
                {metric.unit ? <Text style={styles.metricUnit}> {metric.unit}</Text> : null}
              </Text>
            </View>
          ))}
        </View>
      </Animated.View>

      <Animated.View style={animatedCardChipsStageStyle}>
        {focusedCardContent?.chips.length && !isActivityFocused ? (
          <View style={styles.cardChipRow}>
            {focusedCardContent.chips.map((chip) => (
              <StatChip accent={chip.accentColor} key={`${chip.label}-${chip.value}`} label={chip.label} value={chip.value} />
            ))}
          </View>
        ) : null}
      </Animated.View>

      <PannableHeartChart
        accentColor={chartAccentColor}
        anchorDayKey={viewportKey}
        axisTestID={chartTestID ? `${chartTestID}-axis` : undefined}
        canLoadMore={canLoadMore}
        chartTestID={chartTestID}
        height={chartHeight}
        highlightedSleepStage={isSleepFocused ? selectedSleepStage : null}
        isLoadingMore={isLoadingMore}
        markers={resolvedMarkers}
        jumpToLatestSignal={latestJumpVersion}
        onFocusedMarkerChange={handleFocusedMarkerChange}
        onFocusTransitionStateChange={handleFocusTransitionStateChange}
        onLoadMore={onLoadMore}
        onViewingLatestWindowChange={setIsViewingLatestWindow}
        points={snapshot.series}
        resetKey={viewportKey}
        windowPointCount={resolvedWindowPointCount}
      />
      <Animated.View
        pointerEvents={sleepStagePanelVisible ? 'auto' : 'none'}
        style={[styles.sleepStagePanelWrap, animatedSleepStagePanelStyle]}>
        <View style={styles.sleepStagePanel}>
          {isSleepStagePanelMounted ? (
            <Animated.View style={animatedSleepStageChipStageStyle}>
              <View style={styles.sleepStageChipRow}>
                {renderedSleepStageChips.map((chip) => {
                  const stage = chip.label.toLowerCase() === 'rem' ? 'rem' : chip.label.toLowerCase() as SleepStage;
                  const isSelected = selectedSleepStage === stage;

                  return (
                    <Pressable
                      accessibilityRole="button"
                      key={`${chip.label}-${chip.value}`}
                      onPress={() => handleSleepStagePress(stage)}
                      style={({ pressed }) => [
                        styles.sleepStageChipPressable,
                        pressed ? styles.sleepStageChipPressed : null,
                      ]}
                      testID={chartTestID ? `${chartTestID}-stage-${stage}` : undefined}>
                      <StatChip
                        accent={chip.accentColor}
                        label={chip.label}
                        style={[
                          styles.sleepStageChip,
                          isSelected
                            ? {
                                backgroundColor: `${chip.accentColor}18`,
                                borderColor: `${chip.accentColor}55`,
                              }
                            : null,
                        ]}
                        value={chip.value}
                      />
                    </Pressable>
                  );
                })}
              </View>
            </Animated.View>
          ) : null}
        </View>
      </Animated.View>
      <Animated.View
        pointerEvents={activityDetailPanelVisible ? 'auto' : 'none'}
        style={[styles.sleepStagePanelWrap, animatedActivityDetailPanelStyle]}>
        <View style={styles.sleepStagePanel}>
          {isActivityDetailPanelMounted ? (
            <Animated.View
              style={[styles.activityDetailContent, animatedActivityDetailStageStyle]}
              testID={chartTestID ? `${chartTestID}-activity-detail-panel` : undefined}>
              {activityDetailChips.length ? (
                <View style={styles.activityDetailChipRow}>
                  {activityDetailChips.map((chip) => (
                    <StatChip
                      accent={chip.accentColor}
                      key={`${chip.label}-${chip.value}`}
                      label={chip.label}
                      value={chip.value}
                    />
                  ))}
                </View>
              ) : null}
              {activityActionError ? <Text style={styles.reviewActionError}>{activityActionError}</Text> : null}
              {canManageFocusedActivity ? (
                <View style={styles.reviewActionRow}>
                  <ReviewActionButton
                    accentColor={colors.success}
                    disabled={pendingActivityActionKey !== null}
                    label={pendingActivityActionKey === `confirm:${focusedMarker?.id}` ? 'Saving...' : 'Confirm'}
                    onPress={() => {
                      void handleConfirmFocusedActivity();
                    }}
                    testID={chartTestID ? `${chartTestID}-activity-confirm` : undefined}
                  />
                  <ReviewActionButton
                    accentColor={colors.aqua}
                    disabled={pendingActivityActionKey !== null}
                    label={pendingActivityActionKey === `relabel:${focusedMarker?.id}` ? 'Saving...' : 'Relabel'}
                    onPress={() => setRelabelModalVisible(true)}
                    testID={chartTestID ? `${chartTestID}-activity-relabel` : undefined}
                  />
                  <ReviewActionButton
                    accentColor={colors.alert}
                    disabled={pendingActivityActionKey !== null}
                    label={pendingActivityActionKey === `dismiss:${focusedMarker?.id}` ? 'Saving...' : 'Dismiss'}
                    onPress={() => {
                      void handleDismissFocusedActivity();
                    }}
                    testID={chartTestID ? `${chartTestID}-activity-dismiss` : undefined}
                  />
                </View>
              ) : null}
            </Animated.View>
          ) : null}
        </View>
      </Animated.View>
      {isLoadingMore ? (
        <View style={styles.historyLoaderRow}>
          <ActivityIndicator color={colors.primary} size="small" />
          <Text style={styles.historyLoaderText}>Loading more heart history...</Text>
        </View>
      ) : null}

      <Modal
        animationType="fade"
        onRequestClose={() => {
          if (pendingActivityActionKey === null) {
            setRelabelModalVisible(false);
          }
        }}
        transparent
        visible={relabelModalVisible}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID={chartTestID ? `${chartTestID}-relabel-modal` : undefined}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Relabel activity</Text>
              <Pressable
                accessibilityRole="button"
                disabled={pendingActivityActionKey !== null}
                onPress={() => setRelabelModalVisible(false)}
                style={({ pressed }) => [styles.modalClose, pressed ? styles.actionPressed : null]}
                testID={chartTestID ? `${chartTestID}-relabel-close-button` : undefined}>
                <Text style={styles.modalCloseLabel}>Close</Text>
              </Pressable>
            </View>

            <Text style={styles.modalCopy}>Choose the corrected label for this suggested activity.</Text>
            {activityActionError ? <Text style={styles.reviewActionError}>{activityActionError}</Text> : null}

            <View style={styles.modalOptionGrid}>
              {REVIEW_ACTIVITY_OPTIONS.map((option) => {
                const selected = focusedMarker?.label === option;

                return (
                  <Pressable
                    accessibilityRole="button"
                    disabled={pendingActivityActionKey !== null}
                    key={option}
                    onPress={() => {
                      void handleRelabelFocusedActivity(option);
                    }}
                    style={({ pressed }) => [
                      styles.modalOptionButton,
                      selected ? styles.modalOptionButtonSelected : null,
                      pressed ? styles.actionPressed : null,
                    ]}
                    testID={chartTestID ? `${chartTestID}-relabel-option-${option.toLowerCase()}` : undefined}>
                    <Text style={[styles.modalOptionLabel, selected ? styles.modalOptionLabelSelected : null]}>{option}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
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
        style={[styles.heartStatusChartShell, { minHeight: HEART_CARD_CHART_HEIGHT }]}
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
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
  },
  cardHeaderTextStack: {
    gap: 2,
  },
  cardTitle: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 22,
    lineHeight: 26,
  },
  cardSubtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
  },
  cardIconWrap: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    height: 28,
    justifyContent: 'center',
    marginTop: 1,
    width: 28,
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
  focusedActionButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  focusedActionText: {
    fontFamily: typography.bodySemiBold,
    fontSize: 11,
  },
  cardChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 10,
  },
  activityDetailContent: {
    gap: 12,
  },
  activityDetailChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  reviewActionError: {
    color: colors.alert,
    fontFamily: typography.body,
    fontSize: 12,
    lineHeight: 18,
  },
  reviewActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  reviewActionButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceStrong,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reviewActionButtonDisabled: {
    opacity: 0.52,
  },
  reviewActionButtonLabel: {
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  sleepStagePanelWrap: {
    overflow: 'hidden',
  },
  sleepStagePanel: {
    paddingTop: 0,
  },
  sleepStagePanelLabel: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  sleepStageChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  sleepStageChipPressable: {
    alignSelf: 'flex-start',
  },
  sleepStageChip: {
    minWidth: 0,
  },
  sleepStageChipPressed: {
    opacity: 0.84,
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
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(2, 6, 13, 0.76)',
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    maxWidth: 420,
    padding: 18,
    width: '100%',
  },
  modalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalTitle: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 22,
  },
  modalClose: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  modalCloseLabel: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  modalCopy: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
  },
  modalOptionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  modalOptionButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    minWidth: 92,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modalOptionButtonSelected: {
    backgroundColor: 'rgba(86, 255, 209, 0.12)',
    borderColor: 'rgba(86, 255, 209, 0.34)',
  },
  modalOptionLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  modalOptionLabelSelected: {
    color: colors.aqua,
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
