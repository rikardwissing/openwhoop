import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
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
import {
  PannableHeartChart,
  type HeartActivityDraft,
  type HeartMarkerDraftKind,
  type HeartPinchZoomStep,
} from './PannableHeartChart';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { PulsingHeartIcon } from '@/components/ui/PulsingHeartIcon';
import { StatChip } from '@/components/ui/StatChip';
import { colors, sleepStageColors, typography } from '@/constants/theme';
import type { ManualActivityKind } from '@/data/HealthRepository';
import type {
  ActivitySummary,
  DashboardInsight,
  FocusedHeartDetail,
  HeartCardData,
  HeartIntradayMarker,
  SleepStage,
  SleepCardData,
  StrainCardData,
} from '@/types/health';
import { addMinutes, dateKey, formatClock } from '@/utils/dateTime';
import { formatCompactDuration, formatMetricValue, formatShortDuration } from '@/utils/formatters';
import {
  canManageHeartIntradayMarker,
  getHeartIntradayMarkerPresentation,
} from '@/utils/heartChartMarkers';
import { logMobilePerf, logMobilePerfError } from '@/utils/mobilePerf';

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
const ACTIVITY_DETAIL_IDLE_PANEL_MAX_HEIGHT = 52;
const ACTIVITY_DETAIL_MANAGE_PANEL_MAX_HEIGHT = 72;
const ACTIVITY_DETAIL_DRAFT_PANEL_MAX_HEIGHT = 120;
const ACTIVITY_DETAIL_DRAFT_ERROR_PANEL_MAX_HEIGHT = 148;
const ACTIVITY_DETAIL_MANAGE_ERROR_PANEL_MAX_HEIGHT = 100;
const ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS = HEART_CARD_CHROME_STAGE_DELAY_MS * 3;
const ACTIVITY_DETAIL_CHIP_STAGE_DELAY_MS = ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS + 20;
const ACTIVITY_DRAFT_ACTION_STAGE_DELAY_MS = ACTIVITY_DETAIL_CHIP_STAGE_DELAY_MS + 50;
const HEART_CARD_CHROME_SWAP_DELAY_MS = HEART_CARD_CHROME_OUT_DURATION_MS + HEART_CARD_CHROME_STAGE_DELAY_MS * 2;
const HEART_CARD_CHROME_REVEAL_DELAY_AFTER_SWAP_MS = 40;
const DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES = 5;
const DEFAULT_NEW_ACTIVITY_DURATION_MINUTES = 60;
const REVIEW_ACTIVITY_OPTIONS: ManualActivityKind[] = ['Activity', 'Walk', 'Workout', 'Nap'];
const REVIEW_DRAFT_OPTIONS: HeartMarkerDraftKind[] = [...REVIEW_ACTIVITY_OPTIONS, 'Sleep'];

interface HeartActivityReviewActions {
  createManualActivity: (activity: ManualActivityKind, start: Date, end: Date) => Promise<string>;
  createManualSleep: (start: Date, end: Date) => Promise<string>;
  updateActivity: (activityId: string, activity: ManualActivityKind, start: Date, end: Date) => Promise<void>;
  updateSleep: (sleepId: string, start: Date, end: Date) => Promise<void>;
  confirmActivity: (activityId: string) => Promise<void>;
  dismissActivity: (activityId: string) => Promise<void>;
  relabelActivity: (activityId: string, activity: ManualActivityKind) => Promise<void>;
}

interface HeartChartViewportState {
  windowPointCount: number;
  windowStart: number;
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

function summarizeMarkerHeartValues(snapshot: HeartCardData, marker: HeartIntradayMarker) {
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

function summarizeViewportHeartValues(snapshot: HeartCardData, viewportState: HeartChartViewportState) {
  if (snapshot.series.length === 0) {
    return {
      averageHr: null,
      minHr: null,
      maxHr: null,
    };
  }

  const safeWindowPointCount = Math.min(
    Math.max(viewportState.windowPointCount, 2),
    Math.max(snapshot.series.length, 1),
  );
  const maxWindowStart = Math.max(0, snapshot.series.length - safeWindowPointCount);
  const safeWindowStart = clampIndex(viewportState.windowStart, 0, maxWindowStart);
  const values = snapshot.series
    .slice(safeWindowStart, safeWindowStart + safeWindowPointCount)
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

function parseHeartPointLabelMinutes(label: string) {
  const trimmed = label.trim();
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)$/i.exec(trimmed);

  if (!match) {
    return null;
  }

  const rawHours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  const seconds = Number(match[3] ?? '0');
  const meridiem = match[4]?.toUpperCase();

  if (!Number.isFinite(rawHours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return (rawHours % 12 + (meridiem === 'PM' ? 12 : 0)) * 60 + minutes + seconds / 60;
}

function resolveHeartPointDate(
  points: readonly { label: string }[],
  anchorDayKey: string | undefined,
  minuteOffset: number,
  pointIntervalMinutes = DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES,
) {
  if (!anchorDayKey || points.length === 0) {
    return null;
  }

  const latestLabel = points.at(-1)?.label;
  if (!latestLabel) {
    return null;
  }

  const latestPointMinutes = parseHeartPointLabelMinutes(latestLabel);
  if (latestPointMinutes === null) {
    return null;
  }

  const anchorDate = new Date(`${anchorDayKey}T00:00:00`);
  const latestPointDate = addMinutes(anchorDate, latestPointMinutes);
  const totalSeriesMinutes = Math.max(points.length - 1, 0) * pointIntervalMinutes;

  return addMinutes(latestPointDate, Math.round(minuteOffset) - totalSeriesMinutes);
}

function buildInitialHeartActivityDraft(
  kind: HeartMarkerDraftKind,
  viewportState: HeartChartViewportState,
  pointCount: number,
  pointIntervalMinutes = DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES,
): HeartActivityDraft {
  const safePointCount = Math.max(pointCount, 2);
  const visibleWindowStartMinuteOffset = viewportState.windowStart * pointIntervalMinutes;
  const visibleWindowEndMinuteOffset = Math.min(
    Math.max(safePointCount - 1, 0) * pointIntervalMinutes,
    (viewportState.windowStart + Math.max(viewportState.windowPointCount - 1, 1)) * pointIntervalMinutes,
  );
  const visibleWindowDurationMinutes = Math.max(
    visibleWindowEndMinuteOffset - visibleWindowStartMinuteOffset,
    pointIntervalMinutes,
  );
  const spanMinutes = Math.max(
    1,
    Math.min(DEFAULT_NEW_ACTIVITY_DURATION_MINUTES, visibleWindowDurationMinutes),
  );
  const centeredStartMinuteOffset = Math.round(
    visibleWindowStartMinuteOffset + (visibleWindowDurationMinutes - spanMinutes) / 2,
  );
  const startMinuteOffset = Math.max(
    visibleWindowStartMinuteOffset,
    Math.min(centeredStartMinuteOffset, visibleWindowEndMinuteOffset - spanMinutes),
  );

  return {
    kind,
    endMinuteOffset: startMinuteOffset + spanMinutes,
    startMinuteOffset,
  };
}

function isManualActivityKind(kind: HeartMarkerDraftKind): kind is ManualActivityKind {
  return kind !== 'Sleep';
}

function resolveDraftKind(marker: HeartIntradayMarker): HeartMarkerDraftKind {
  if (marker.kind === 'sleep') {
    return 'Sleep';
  }

  const exactMatch = REVIEW_ACTIVITY_OPTIONS.find((option) => option.toLowerCase() === marker.label.toLowerCase());

  if (exactMatch) {
    return exactMatch;
  }

  return marker.kind === 'nap' ? 'Nap' : 'Activity';
}

function buildHeartActivityDraftFromMarker(
  marker: HeartIntradayMarker,
  pointCount: number,
  pointIntervalMinutes = DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES,
): HeartActivityDraft | null {
  if (pointCount < 2) {
    return null;
  }

  const totalSeriesMinutes = Math.max((pointCount - 1) * pointIntervalMinutes, 1);
  const startMinuteOffset = clampIndex(
    Math.round(Math.max(0, Math.min(1, marker.startFraction)) * totalSeriesMinutes),
    0,
    totalSeriesMinutes,
  );
  const endMinuteOffset = clampIndex(
    Math.round(Math.max(0, Math.min(1, marker.endFraction)) * totalSeriesMinutes),
    startMinuteOffset + 1,
    totalSeriesMinutes,
  );

  return {
    kind: resolveDraftKind(marker),
    endMinuteOffset,
    startMinuteOffset,
  };
}

function buildHeartActivityDraftMarker(
  draft: HeartActivityDraft | null,
  points: HeartCardData['series'],
  anchorDayKey: string | undefined,
  pointIntervalMinutes = DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES,
): HeartIntradayMarker | null {
  if (!draft || points.length < 2) {
    return null;
  }

  const start = resolveHeartPointDate(points, anchorDayKey, draft.startMinuteOffset, pointIntervalMinutes);
  const end = resolveHeartPointDate(points, anchorDayKey, draft.endMinuteOffset, pointIntervalMinutes);
  if (!start || !end || end.getTime() <= start.getTime()) {
    return null;
  }

  const totalSeriesMinutes = Math.max((points.length - 1) * pointIntervalMinutes, 1);
  const markerKind = draft.kind === 'Sleep' ? 'sleep' : draft.kind === 'Nap' ? 'nap' : 'activity';
  const markerLabel = draft.kind;

  return {
    id: draft.kind === 'Sleep' ? `sleep-${dateKey(end)}` : 'draft-activity',
    kind: markerKind,
    label: markerLabel,
    timeLabel: `${formatClock(start)} - ${formatClock(end)}`,
    startFraction: draft.startMinuteOffset / totalSeriesMinutes,
    endFraction: draft.endMinuteOffset / totalSeriesMinutes,
    startTimeMs: start.getTime(),
    endTimeMs: end.getTime(),
    details: {
      durationMinutes: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)),
      reviewState: 'confirmed',
      source: 'manual',
    },
  } satisfies HeartIntradayMarker;
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

function resolveActiveHeartMarker(
  marker: HeartIntradayMarker | null,
  markers: readonly HeartIntradayMarker[],
  optimisticMarker: HeartIntradayMarker | null,
) {
  if (!marker) {
    return null;
  }

  const resolvedMarker = markers.find((candidate) => candidate.id === marker.id);

  if (resolvedMarker) {
    return resolvedMarker;
  }

  if (optimisticMarker?.id === marker.id) {
    return optimisticMarker;
  }

  return null;
}

function buildFocusedHeartCardContent(
  snapshot: HeartCardData,
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
    chips: [],
    stageChips: [],
  };
}

function buildFocusedHeartCardData(
  baseSnapshot: HeartCardData,
  detailSnapshot: FocusedHeartDetail,
): HeartCardData {
  return {
    ...baseSnapshot,
    averageHr: detailSnapshot.averageHr,
    maxHr: detailSnapshot.maxHr,
    pointIntervalMinutes: detailSnapshot.pointIntervalMinutes,
    series: detailSnapshot.series,
    markers: [detailSnapshot.marker],
    missingReason: detailSnapshot.missingReason ?? baseSnapshot.missingReason,
  };
}

export function HeartCard({
  activityReviewActions,
  canLoadMore = false,
  chartTestID,
  isLoadingMore = false,
  isRefreshing = false,
  latestWindowLabel,
  liveHeartRateLabel,
  loadFocusedDetail,
  onLoadMore,
  onOpen,
  onPinchZoomStepChange,
  openTestID,
  showLiveHeartRate = false,
  cardData: cardData,
  trailingLabel,
  viewportKey,
  windowPointCount,
  pinchZoomSteps,
}: {
  activityReviewActions?: HeartActivityReviewActions;
  canLoadMore?: boolean;
  chartTestID: string;
  isLoadingMore?: boolean;
  isRefreshing?: boolean;
  latestWindowLabel?: string;
  liveHeartRateLabel?: string | null;
  loadFocusedDetail?: (marker: HeartIntradayMarker) => Promise<FocusedHeartDetail>;
  onLoadMore?: () => void;
  onOpen?: () => void;
  onPinchZoomStepChange?: (value: string) => void;
  openTestID?: string;
  showLiveHeartRate?: boolean;
  cardData: HeartCardData;
  trailingLabel: string;
  viewportKey?: string;
  windowPointCount?: number;
  pinchZoomSteps?: readonly HeartPinchZoomStep[];
}) {
  const resolvedWindowPointCount = windowPointCount ?? cardData.series.length;
  const basePointIntervalMinutes = cardData.pointIntervalMinutes ?? DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES;
  const [chartViewportState, setChartViewportState] = useState<HeartChartViewportState>(() => ({
    windowPointCount: resolvedWindowPointCount,
    windowStart: Math.max(cardData.series.length - resolvedWindowPointCount, 0),
  }));
  const [isViewingLatestWindow, setIsViewingLatestWindow] = useState(true);
  const [latestJumpVersion, setLatestJumpVersion] = useState(0);
  const [activityMarkerOverrides, setActivityMarkerOverrides] = useState<Record<string, HeartIntradayMarker | null>>({});
  const [activityDraft, setActivityDraft] = useState<HeartActivityDraft | null>(null);
  const [presentedActivityDraft, setPresentedActivityDraft] = useState<HeartActivityDraft | null>(null);
  const [pendingEditActivityDraft, setPendingEditActivityDraft] = useState<HeartActivityDraft | null>(null);
  const [editingActivityMarker, setEditingActivityMarker] = useState<HeartIntradayMarker | null>(null);
  const [requestedSavedFocusMarker, setRequestedSavedFocusMarker] = useState<HeartIntradayMarker | null>(null);
  const [requestedFocusMarkerId, setRequestedFocusMarkerId] = useState<string | null>(null);
  const [pendingActivityActionKey, setPendingActivityActionKey] = useState<string | null>(null);
  const [activityActionError, setActivityActionError] = useState<string | null>(null);
  const [relabelModalVisible, setRelabelModalVisible] = useState(false);
  const [focusedMarkerTarget, setFocusedMarkerTarget] = useState<HeartIntradayMarker | null>(null);
  const [focusedMarker, setFocusedMarker] = useState<HeartIntradayMarker | null>(null);
  const [focusedDetailState, setFocusedDetailState] = useState<{
    key: string | null;
    snapshot: FocusedHeartDetail | null;
    status: 'idle' | 'loading' | 'ready' | 'error';
  }>({
    key: null,
    snapshot: null,
    status: 'idle',
  });
  const [appliedFocusedDetailState, setAppliedFocusedDetailState] = useState<{
    key: string | null;
    snapshot: FocusedHeartDetail | null;
  }>({
    key: null,
    snapshot: null,
  });
  const [isChartFocusTransitioning, setIsChartFocusTransitioning] = useState(false);
  const [selectedSleepStage, setSelectedSleepStage] = useState<SleepStage | null>(null);
  const [isSleepStagePanelMounted, setIsSleepStagePanelMounted] = useState(false);
  const [isActivityDetailPanelMounted, setIsActivityDetailPanelMounted] = useState(false);
  const [activityDetailMeasuredHeight, setActivityDetailMeasuredHeight] = useState(0);
  const [renderedSleepStageChips, setRenderedSleepStageChips] = useState<HeartMetricChip[]>([]);
  const focusedDetailRequestKeyRef = useRef<string | null>(null);
  const previousActivityDetailPanelVisibleRef = useRef(false);
  const isFocusTransitioningRef = useRef(false);
  const pendingFocusedMarkerRef = useRef<HeartIntradayMarker | null>(null);
  const sleepStagePanelUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityDetailPanelUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedLatestWindowLabel = latestWindowLabel ?? (trailingLabel === 'Last 12h' ? trailingLabel : null);
  const showsLatestWindowButton = resolvedLatestWindowLabel !== null;
  const isDraftEditing = activityDraft !== null;
  const [isDraftPresentationActive, setIsDraftPresentationActive] = useState(false);
  const hiddenEditingMarkerId =
    editingActivityMarker && (isDraftEditing || isDraftPresentationActive) ? editingActivityMarker.id : null;
  const baseResolvedMarkers = useMemo(
    () => {
      const nextMarkers = applyHeartMarkerOverrides(cardData.markers, activityMarkerOverrides);

      if (!hiddenEditingMarkerId) {
        return nextMarkers;
      }

      return nextMarkers.filter((marker) => marker.id !== hiddenEditingMarkerId);
    },
    [activityMarkerOverrides, hiddenEditingMarkerId, cardData.markers],
  );
  const previousDraftEditingRef = useRef(isDraftEditing);
  const draftChromeTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayedActivityDraft = isDraftEditing ? activityDraft : presentedActivityDraft;
  const displayedActivityDraftMarker = useMemo(
    () => buildHeartActivityDraftMarker(displayedActivityDraft, cardData.series, viewportKey, basePointIntervalMinutes),
    [basePointIntervalMinutes, displayedActivityDraft, cardData.series, viewportKey],
  );
  const isPresentedDraftEditing = isDraftPresentationActive && displayedActivityDraft !== null;
  const resolvedBaseFocusedMarkerTarget = useMemo(
    () => resolveActiveHeartMarker(focusedMarkerTarget, baseResolvedMarkers, requestedSavedFocusMarker),
    [baseResolvedMarkers, focusedMarkerTarget, requestedSavedFocusMarker],
  );
  const focusedDetailKey = useMemo(() => {
    if (
      !loadFocusedDetail ||
      isDraftEditing ||
      isDraftPresentationActive ||
      !resolvedBaseFocusedMarkerTarget ||
      resolvedBaseFocusedMarkerTarget.startTimeMs === undefined ||
      resolvedBaseFocusedMarkerTarget.endTimeMs === undefined
    ) {
      return null;
    }

    return `${resolvedBaseFocusedMarkerTarget.id}:${resolvedBaseFocusedMarkerTarget.startTimeMs}:${resolvedBaseFocusedMarkerTarget.endTimeMs}`;
  }, [isDraftEditing, isDraftPresentationActive, loadFocusedDetail, resolvedBaseFocusedMarkerTarget]);
  const preparedFocusedDetailSnapshot =
    focusedDetailKey !== null &&
    focusedDetailState.status === 'ready' &&
    focusedDetailState.key === focusedDetailKey
      ? focusedDetailState.snapshot
      : null;
  const activeFocusedDetailSnapshot =
    focusedDetailKey !== null &&
    appliedFocusedDetailState.key === focusedDetailKey
      ? appliedFocusedDetailState.snapshot
      : null;
  const displayedChartSnapshot = useMemo(
    () => (activeFocusedDetailSnapshot ? buildFocusedHeartCardData(cardData, activeFocusedDetailSnapshot) : cardData),
    [activeFocusedDetailSnapshot, cardData],
  );
  const resolvedMarkers = useMemo(
    () => {
      const nextMarkers = applyHeartMarkerOverrides(displayedChartSnapshot.markers, activityMarkerOverrides);

      if (!hiddenEditingMarkerId) {
        return nextMarkers;
      }

      return nextMarkers.filter((marker) => marker.id !== hiddenEditingMarkerId);
    },
    [activityMarkerOverrides, displayedChartSnapshot.markers, hiddenEditingMarkerId],
  );
  const resolvedFocusedMarkerTarget = useMemo(
    () => resolveActiveHeartMarker(focusedMarkerTarget, resolvedMarkers, requestedSavedFocusMarker),
    [focusedMarkerTarget, requestedSavedFocusMarker, resolvedMarkers],
  );
  const resolvedFocusedMarker = useMemo(
    () => resolveActiveHeartMarker(focusedMarker, resolvedMarkers, requestedSavedFocusMarker),
    [focusedMarker, requestedSavedFocusMarker, resolvedMarkers],
  );
  const presentedMarkerTarget = isPresentedDraftEditing
    ? displayedActivityDraftMarker ?? resolvedFocusedMarkerTarget
    : resolvedFocusedMarkerTarget;
  const presentedMarker = isPresentedDraftEditing
    ? displayedActivityDraftMarker ?? resolvedFocusedMarker
    : resolvedFocusedMarker;
  const focusedCardTargetContent = buildFocusedHeartCardContent(displayedChartSnapshot, presentedMarkerTarget);
  const focusedChartTargetContent = buildFocusedHeartCardContent(displayedChartSnapshot, resolvedFocusedMarkerTarget);
  const focusedCardContent = buildFocusedHeartCardContent(displayedChartSnapshot, presentedMarker);
  const displayedFocusedMarker = presentedMarker ?? presentedMarkerTarget;
  const displayedFocusedCardContent = focusedCardContent ?? focusedCardTargetContent;
  const actionableFocusedMarker = useMemo(() => {
    if (resolvedFocusedMarker) {
      const resolvedBaseMarker = baseResolvedMarkers.find((candidate) => candidate.id === resolvedFocusedMarker.id);

      if (resolvedBaseMarker) {
        return resolvedBaseMarker;
      }
    }

    return resolvedBaseFocusedMarkerTarget ?? focusedMarker;
  }, [baseResolvedMarkers, focusedMarker, resolvedBaseFocusedMarkerTarget, resolvedFocusedMarker]);
  const cardAccentColor = focusedCardTargetContent?.accentColor ?? colors.success;
  const chartAccentColor = focusedChartTargetContent?.chartAccentColor ?? colors.primary;
  const isSleepFocused = displayedFocusedMarker?.kind === 'sleep';
  const isActivityFocused = displayedFocusedMarker?.kind === 'activity' || displayedFocusedMarker?.kind === 'nap';
  const canManageFocusedActivity = Boolean(
    !isPresentedDraftEditing &&
      activityReviewActions &&
      actionableFocusedMarker &&
      canManageHeartIntradayMarker(actionableFocusedMarker),
  );
  const canEditFocusedActivity = Boolean(
    !isPresentedDraftEditing &&
      activityReviewActions &&
      actionableFocusedMarker &&
      actionableFocusedMarker.kind !== 'sleep' &&
      !canManageHeartIntradayMarker(actionableFocusedMarker) &&
      actionableFocusedMarker.id !== 'draft-activity' &&
      pendingActivityActionKey !== 'draft:save' &&
      pendingEditActivityDraft === null,
  );
  const canEditFocusedSleep = Boolean(
    !isPresentedDraftEditing &&
      activityReviewActions?.updateSleep &&
      actionableFocusedMarker?.kind === 'sleep' &&
      pendingActivityActionKey !== 'draft:save' &&
      pendingEditActivityDraft === null,
  );
  const canCreateGraphActivity = Boolean(activityReviewActions?.createManualActivity && activityReviewActions?.createManualSleep) && !isPresentedDraftEditing;
  const isAwaitingSavedActivityFocus = requestedFocusMarkerId !== null;
  const displayedWindowPointCount = activeFocusedDetailSnapshot
    ? displayedChartSnapshot.series.length
    : resolvedWindowPointCount;
  const viewportSeriesSummary = useMemo(
    () => summarizeViewportHeartValues(displayedChartSnapshot, chartViewportState),
    [chartViewportState, displayedChartSnapshot],
  );
  const showIdleCreateGraphActivity =
    canCreateGraphActivity &&
    displayedFocusedMarker === null &&
    pendingEditActivityDraft === null &&
    !isAwaitingSavedActivityFocus;
  const activityDetailChips = isActivityFocused ? displayedFocusedCardContent?.chips ?? [] : [];
  const sleepStageChips = displayedFocusedCardContent?.stageChips ?? [];
  const draftTypeOptions: HeartMarkerDraftKind[] = editingActivityMarker?.kind === 'sleep'
    ? ['Sleep']
    : editingActivityMarker
      ? REVIEW_ACTIVITY_OPTIONS
      : REVIEW_DRAFT_OPTIONS;
  const sleepStageChipSignature = sleepStageChips
    .map((chip) => `${chip.label}:${chip.value}:${chip.accentColor}`)
    .join('|');
  const sleepStagePanelVisible = isSleepFocused && sleepStageChips.length > 0;
  const activityDetailPanelVisible =
    showIdleCreateGraphActivity ||
    isDraftEditing ||
    ((isActivityFocused || isSleepFocused) && (
      activityDetailChips.length > 0 ||
      canManageFocusedActivity ||
      canEditFocusedActivity ||
      canEditFocusedSleep ||
      activityActionError !== null
    ));
  const activityDetailPanelFallbackMaxHeight = !activityDetailPanelVisible
    ? 0
    : isPresentedDraftEditing
      ? activityActionError
        ? ACTIVITY_DETAIL_DRAFT_ERROR_PANEL_MAX_HEIGHT
        : ACTIVITY_DETAIL_DRAFT_PANEL_MAX_HEIGHT
      : showIdleCreateGraphActivity
        ? ACTIVITY_DETAIL_IDLE_PANEL_MAX_HEIGHT
        : activityActionError
          ? ACTIVITY_DETAIL_MANAGE_ERROR_PANEL_MAX_HEIGHT
          : ACTIVITY_DETAIL_MANAGE_PANEL_MAX_HEIGHT;
  const activityDetailPanelTargetMaxHeight = activityDetailPanelVisible
    ? Math.max(activityDetailMeasuredHeight, activityDetailPanelFallbackMaxHeight)
    : 0;
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
  const cardTitle = displayedFocusedCardContent?.title ?? 'Heart Rate';
  const defaultCardSubtitle =
    showLiveHeartRate && liveHeartRateLabel ? liveHeartRateLabel : 'Explore your heart rate';
  const cardSubtitle = displayedFocusedCardContent?.subtitle ?? defaultCardSubtitle;
  const metricColumns: HeartMetricColumn[] = displayedFocusedCardContent?.metrics ?? [
    {
      label: 'Low',
      value: formatMetricValue(viewportSeriesSummary.minHr, 0),
      unit: 'BPM',
      valueColor: colors.aqua,
    },
    {
      label: 'Average',
      value: formatMetricValue(viewportSeriesSummary.averageHr, 0),
      unit: 'BPM',
    },
    {
      label: 'Max',
      value: formatMetricValue(viewportSeriesSummary.maxHr, 0),
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

  const animateActivityDetailStage = useCallback(
    (target: 0 | 1) => {
      const duration =
        target === 0 ? HEART_CARD_CHROME_OUT_DURATION_MS : HEART_CARD_CHROME_IN_DURATION_MS;

      cancelAnimation(activityDetailTransitionProgress);
      activityDetailTransitionProgress.value = withDelay(
        HEART_CARD_CHROME_STAGE_DELAY_MS * 2,
        withTiming(target, {
          duration,
          easing: Easing.out(Easing.cubic),
        }),
      );
    },
    [activityDetailTransitionProgress],
  );

  const isSavedActivityFocusPending = requestedSavedFocusMarker !== null || requestedFocusMarkerId !== null;

  const handleFocusedMarkerChange = useCallback((nextMarker: HeartIntradayMarker | null) => {
    pendingFocusedMarkerRef.current = nextMarker;
    setFocusedMarkerTarget((current) => (current === nextMarker ? current : nextMarker));

    if (nextMarker === null) {
      setRequestedSavedFocusMarker(null);
      setRequestedFocusMarkerId(null);
    }

    if (isFocusTransitioningRef.current) {
      return;
    }

    startTransition(() => {
      setFocusedMarker(nextMarker);
    });
  }, []);

  const handleFocusTransitionStateChange = useCallback((isTransitioning: boolean) => {
    isFocusTransitioningRef.current = isTransitioning;
    setIsChartFocusTransitioning(isTransitioning);
    const nextFocusedMarker = pendingFocusedMarkerRef.current;

    if (isTransitioning) {
      animateCardChromeStages(0);
      animateActivityDetailStage(0);
      return;
    }

    startTransition(() => {
      setFocusedMarker(nextFocusedMarker);
    });

    if (nextFocusedMarker === null) {
      if (canCreateGraphActivity) {
        animateActivityDetailStage(1);
      }
      return;
    }

    if (nextFocusedMarker.kind === 'activity' || nextFocusedMarker.kind === 'nap') {
      animateActivityDetailStage(1);
    }
  }, [animateActivityDetailStage, animateCardChromeStages, canCreateGraphActivity]);

  const clearFocusedDetail = useCallback(() => {
    focusedDetailRequestKeyRef.current = null;
    setAppliedFocusedDetailState((current) => {
      if (current.key === null && current.snapshot === null) {
        return current;
      }

      return {
        key: null,
        snapshot: null,
      };
    });
    setFocusedDetailState((current) => {
      if (current.key === null && current.snapshot === null && current.status === 'idle') {
        return current;
      }

      return {
        key: null,
        snapshot: null,
        status: 'idle',
      };
    });
  }, []);

  useEffect(() => {
    if (!focusedDetailKey || !preparedFocusedDetailSnapshot) {
      setAppliedFocusedDetailState((current) => {
        if (current.key === null && current.snapshot === null) {
          return current;
        }

        return {
          key: null,
          snapshot: null,
        };
      });
      return;
    }

    if (isChartFocusTransitioning) {
      return;
    }

    setAppliedFocusedDetailState((current) => {
      if (current.key === focusedDetailKey && current.snapshot === preparedFocusedDetailSnapshot) {
        return current;
      }

      return {
        key: focusedDetailKey,
        snapshot: preparedFocusedDetailSnapshot,
      };
    });
  }, [focusedDetailKey, isChartFocusTransitioning, preparedFocusedDetailSnapshot]);

  useEffect(() => {
    if (!focusedDetailKey || !loadFocusedDetail || !resolvedBaseFocusedMarkerTarget) {
      clearFocusedDetail();
      return;
    }

    if (
      focusedDetailState.key === focusedDetailKey &&
      (focusedDetailState.status === 'loading' || focusedDetailState.status === 'ready')
    ) {
      return;
    }

    focusedDetailRequestKeyRef.current = focusedDetailKey;
    const detailLoadStartedAt = Date.now();
    setFocusedDetailState((current) => {
      if (current.key === focusedDetailKey && current.status === 'loading') {
        return current;
      }

      return {
        key: focusedDetailKey,
        snapshot: current.key === focusedDetailKey ? current.snapshot : null,
        status: 'loading',
      };
    });

    void loadFocusedDetail(resolvedBaseFocusedMarkerTarget)
      .then((detailSnapshot) => {
        if (focusedDetailRequestKeyRef.current !== focusedDetailKey) {
          return;
        }

        logMobilePerf('chart.heart.focusedDetail.load', detailLoadStartedAt, {
          chart: chartTestID,
          markerId: resolvedBaseFocusedMarkerTarget.id,
          markerKind: resolvedBaseFocusedMarkerTarget.kind,
          pointIntervalMinutes: detailSnapshot.pointIntervalMinutes,
          points: detailSnapshot.series.length,
        });

        setFocusedDetailState({
          key: focusedDetailKey,
          snapshot: detailSnapshot,
          status: 'ready',
        });
      })
      .catch((error) => {
        if (focusedDetailRequestKeyRef.current !== focusedDetailKey) {
          return;
        }

        logMobilePerfError('chart.heart.focusedDetail.load', error, {
          chart: chartTestID,
          markerId: resolvedBaseFocusedMarkerTarget.id,
          markerKind: resolvedBaseFocusedMarkerTarget.kind,
        });

        setFocusedDetailState({
          key: focusedDetailKey,
          snapshot: null,
          status: 'error',
        });
      });
  }, [clearFocusedDetail, focusedDetailKey, focusedDetailState.key, focusedDetailState.status, loadFocusedDetail, resolvedBaseFocusedMarkerTarget]);

  const clearActivityMarkerOverride = useCallback((activityId: string) => {
    setActivityMarkerOverrides((current) => {
      const next = { ...current };
      delete next[activityId];
      return next;
    });
  }, []);

  const handleConfirmFocusedActivity = useCallback(async () => {
    if (!activityReviewActions || !actionableFocusedMarker || !canManageHeartIntradayMarker(actionableFocusedMarker)) {
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey(`confirm:${actionableFocusedMarker.id}`);
    setActivityMarkerOverrides((current) => ({
      ...current,
      [actionableFocusedMarker.id]: buildUpdatedActivityMarker(actionableFocusedMarker, { reviewState: 'confirmed' }),
    }));

    try {
      await activityReviewActions.confirmActivity(actionableFocusedMarker.id);
    } catch (error) {
      clearActivityMarkerOverride(actionableFocusedMarker.id);
      setActivityActionError(error instanceof Error ? error.message : 'Unable to confirm this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [actionableFocusedMarker, activityReviewActions, clearActivityMarkerOverride]);

  const handleDismissFocusedActivity = useCallback(async () => {
    if (!activityReviewActions || !actionableFocusedMarker || actionableFocusedMarker.kind === 'sleep') {
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey(`dismiss:${actionableFocusedMarker.id}`);
    setActivityMarkerOverrides((current) => ({
      ...current,
      [actionableFocusedMarker.id]: null,
    }));
    setLatestJumpVersion((current) => current + 1);

    try {
      await activityReviewActions.dismissActivity(actionableFocusedMarker.id);
    } catch (error) {
      clearActivityMarkerOverride(actionableFocusedMarker.id);
      setActivityActionError(error instanceof Error ? error.message : 'Unable to dismiss this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [actionableFocusedMarker, activityReviewActions, clearActivityMarkerOverride]);

  const handleRelabelFocusedActivity = useCallback(async (activity: ManualActivityKind) => {
    if (!activityReviewActions || !actionableFocusedMarker || !canManageHeartIntradayMarker(actionableFocusedMarker)) {
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey(`relabel:${actionableFocusedMarker.id}`);
    setActivityMarkerOverrides((current) => ({
      ...current,
      [actionableFocusedMarker.id]: buildUpdatedActivityMarker(actionableFocusedMarker, {
        label: activity,
        reviewState: 'relabelled',
      }),
    }));

    try {
      await activityReviewActions.relabelActivity(actionableFocusedMarker.id, activity);
      setRelabelModalVisible(false);
    } catch (error) {
      clearActivityMarkerOverride(actionableFocusedMarker.id);
      setActivityActionError(error instanceof Error ? error.message : 'Unable to relabel this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [actionableFocusedMarker, activityReviewActions, clearActivityMarkerOverride]);

  const handleStartDraftActivity = useCallback(() => {
    clearFocusedDetail();
    setActivityActionError(null);
    setPendingActivityActionKey(null);
    setEditingActivityMarker(null);
    setPendingEditActivityDraft(null);
    setRequestedSavedFocusMarker(null);
    setRequestedFocusMarkerId(null);

    const nextViewportState = chartViewportState ?? {
      windowPointCount: resolvedWindowPointCount,
      windowStart: Math.max(cardData.series.length - resolvedWindowPointCount, 0),
    };

    setActivityDraft(
      buildInitialHeartActivityDraft(
        'Activity',
        nextViewportState,
        cardData.series.length,
        basePointIntervalMinutes,
      ),
    );
  }, [basePointIntervalMinutes, chartViewportState, clearFocusedDetail, resolvedWindowPointCount, cardData.series.length]);

  const handleEditFocusedActivity = useCallback(() => {
    if (!actionableFocusedMarker) {
      return;
    }

    const nextDraft = buildHeartActivityDraftFromMarker(
      actionableFocusedMarker,
      cardData.series.length,
      basePointIntervalMinutes,
    );
    if (!nextDraft) {
      setActivityActionError('Unable to edit this activity from the chart right now.');
      return;
    }

    clearFocusedDetail();
    setActivityActionError(null);
    setPendingActivityActionKey(null);
    setRequestedSavedFocusMarker(null);
    setRequestedFocusMarkerId(null);
    setEditingActivityMarker(actionableFocusedMarker);
    setPendingEditActivityDraft(nextDraft);
    setLatestJumpVersion((current) => current + 1);
  }, [actionableFocusedMarker, basePointIntervalMinutes, clearFocusedDetail, cardData.series.length]);

  const handleSelectDraftActivityType = useCallback((activity: HeartMarkerDraftKind) => {
    setActivityActionError(null);
    setActivityDraft((current) => (current ? { ...current, kind: activity } : current));
  }, []);

  const handleCancelDraftActivity = useCallback(() => {
    clearFocusedDetail();
    setActivityActionError(null);
    setPendingActivityActionKey(null);
    setEditingActivityMarker(null);
    setPendingEditActivityDraft(null);
    setRequestedSavedFocusMarker(null);
    setRequestedFocusMarkerId(null);
    setActivityDraft(null);
  }, [clearFocusedDetail]);

  const handleSaveDraftActivity = useCallback(async () => {
    const draftToSave = activityDraft;
    const activityToEdit = editingActivityMarker;
    const reviewActions = activityReviewActions;

    if (!draftToSave || !reviewActions) {
      return;
    }

    const start = resolveHeartPointDate(
      cardData.series,
      viewportKey,
      draftToSave.startMinuteOffset,
      basePointIntervalMinutes,
    );
    const end = resolveHeartPointDate(
      cardData.series,
      viewportKey,
      draftToSave.endMinuteOffset,
      basePointIntervalMinutes,
    );

    if (!start || !end || end.getTime() <= start.getTime()) {
      setActivityActionError('Unable to resolve the draft activity time range from the chart.');
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey('draft:save');

    const optimisticFocusMarker = buildHeartActivityDraftMarker(
      draftToSave,
      cardData.series,
      viewportKey,
      basePointIntervalMinutes,
    );
    if (!optimisticFocusMarker) {
      setActivityActionError('Unable to resolve the draft activity time range from the chart.');
      setPendingActivityActionKey(null);
      return;
    }

    const nextOptimisticFocusMarker = activityToEdit
      ? {
          ...optimisticFocusMarker,
          id: activityToEdit.id,
        }
      : optimisticFocusMarker;

    if (draftChromeTransitionTimeoutRef.current !== null) {
      clearTimeout(draftChromeTransitionTimeoutRef.current);
      draftChromeTransitionTimeoutRef.current = null;
    }

    previousDraftEditingRef.current = false;
    setIsDraftPresentationActive(false);
    setPresentedActivityDraft(null);
    setPendingEditActivityDraft(null);
    setRequestedSavedFocusMarker(nextOptimisticFocusMarker);
    setFocusedMarkerTarget(nextOptimisticFocusMarker);
    setFocusedMarker(nextOptimisticFocusMarker);
    setActivityDraft(null);

    try {
      if (draftToSave.kind === 'Sleep') {
        if (activityToEdit?.kind === 'sleep') {
          await reviewActions.updateSleep(activityToEdit.id, start, end);
          setRequestedFocusMarkerId(nextOptimisticFocusMarker.id);
        } else {
          const sleepId = await reviewActions.createManualSleep(start, end);
          setRequestedFocusMarkerId(sleepId);
        }
        setEditingActivityMarker(null);
      } else if (activityToEdit) {
        await reviewActions.updateActivity(activityToEdit.id, draftToSave.kind, start, end);
        setEditingActivityMarker(null);
      } else {
        const activityId = await reviewActions.createManualActivity(draftToSave.kind, start, end);
        setRequestedFocusMarkerId(activityId);
      }
    } catch (error) {
      previousDraftEditingRef.current = true;
      setIsDraftPresentationActive(true);
      setPresentedActivityDraft(draftToSave);
      setActivityDraft(draftToSave);
      setEditingActivityMarker(activityToEdit);
      setPendingEditActivityDraft(null);
      setRequestedSavedFocusMarker(null);
      setRequestedFocusMarkerId(null);
      if (activityToEdit) {
        setFocusedMarkerTarget(activityToEdit);
        setFocusedMarker(activityToEdit);
      }
      setActivityActionError(error instanceof Error ? error.message : 'Unable to save this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [activityDraft, activityReviewActions, basePointIntervalMinutes, editingActivityMarker, cardData.series, viewportKey]);

  useEffect(() => {
    const shouldShowIdleActivityPanelAfterReset = Boolean(activityReviewActions?.createManualActivity && activityReviewActions?.createManualSleep);

    clearFocusedDetail();
    setChartViewportState({
      windowPointCount: resolvedWindowPointCount,
      windowStart: Math.max(cardData.series.length - resolvedWindowPointCount, 0),
    });
    setIsViewingLatestWindow(true);
    setLatestJumpVersion(0);
    setActivityMarkerOverrides({});
    setActivityDraft(null);
    setPresentedActivityDraft(null);
    setPendingEditActivityDraft(null);
    setEditingActivityMarker(null);
    setRequestedSavedFocusMarker(null);
    setRequestedFocusMarkerId(null);
    setPendingActivityActionKey(null);
    setActivityActionError(null);
    setRelabelModalVisible(false);
    isFocusTransitioningRef.current = false;
    pendingFocusedMarkerRef.current = null;
    previousDraftEditingRef.current = false;
    cardHeaderTransitionProgress.value = 1;
    cardMetricsTransitionProgress.value = 1;
    cardChipsTransitionProgress.value = 1;
    sleepStageChipTransitionProgress.value = 0;
    activityDetailPanelMaxHeight.value = shouldShowIdleActivityPanelAfterReset ? ACTIVITY_DETAIL_IDLE_PANEL_MAX_HEIGHT : 0;
    activityDetailPanelOpacity.value = shouldShowIdleActivityPanelAfterReset ? 1 : 0;
    activityDetailPanelMarginTop.value = shouldShowIdleActivityPanelAfterReset ? 12 : 0;
    activityDetailTransitionProgress.value = shouldShowIdleActivityPanelAfterReset ? 1 : 0;
    if (sleepStagePanelUnmountTimeoutRef.current !== null) {
      clearTimeout(sleepStagePanelUnmountTimeoutRef.current);
      sleepStagePanelUnmountTimeoutRef.current = null;
    }
    if (activityDetailPanelUnmountTimeoutRef.current !== null) {
      clearTimeout(activityDetailPanelUnmountTimeoutRef.current);
      activityDetailPanelUnmountTimeoutRef.current = null;
    }
    if (draftChromeTransitionTimeoutRef.current !== null) {
      clearTimeout(draftChromeTransitionTimeoutRef.current);
      draftChromeTransitionTimeoutRef.current = null;
    }
    setIsSleepStagePanelMounted(false);
    setIsActivityDetailPanelMounted(shouldShowIdleActivityPanelAfterReset);
    setActivityDetailMeasuredHeight(0);
    previousActivityDetailPanelVisibleRef.current = shouldShowIdleActivityPanelAfterReset;
    setIsDraftPresentationActive(false);
    setRenderedSleepStageChips([]);
    setFocusedMarkerTarget(null);
    setFocusedMarker(null);
    setSelectedSleepStage(null);
  }, [
    activityReviewActions?.createManualActivity,
    activityReviewActions?.createManualSleep,
    activityDetailPanelMarginTop,
    activityDetailPanelMaxHeight,
    activityDetailPanelOpacity,
    clearFocusedDetail,
    cardChipsTransitionProgress,
    cardHeaderTransitionProgress,
    cardMetricsTransitionProgress,
    activityDetailTransitionProgress,
    sleepStageChipTransitionProgress,
    viewportKey,
  ]);

  useEffect(() => {
    if (activityDraft && isDraftPresentationActive) {
      setPresentedActivityDraft(activityDraft);
      return;
    }

    if (!isDraftPresentationActive) {
      setPresentedActivityDraft(null);
    }
  }, [activityDraft, isDraftPresentationActive]);

  useEffect(() => {
    if (!pendingEditActivityDraft) {
      return;
    }

    if (isFocusTransitioningRef.current) {
      return;
    }

    if (focusedMarkerTarget !== null || focusedMarker !== null) {
      return;
    }

    setActivityDraft(pendingEditActivityDraft);
    setPendingEditActivityDraft(null);
  }, [focusedMarker, focusedMarkerTarget, pendingEditActivityDraft]);

  useEffect(() => {
    if (!requestedFocusMarkerId) {
      return;
    }

    const resolvedRequestedMarker = baseResolvedMarkers.find((marker) => marker.id === requestedFocusMarkerId);

    if (!resolvedRequestedMarker) {
      return;
    }

    setRequestedSavedFocusMarker(null);
    setFocusedMarkerTarget((current) => (current?.id === resolvedRequestedMarker.id ? current : resolvedRequestedMarker));
  }, [baseResolvedMarkers, requestedFocusMarkerId]);

  useEffect(() => {
    if (!requestedFocusMarkerId) {
      return;
    }

    if (focusedMarker?.id !== requestedFocusMarkerId) {
      return;
    }

    setRequestedFocusMarkerId(null);
  }, [focusedMarker?.id, requestedFocusMarkerId]);

  useEffect(() => {
    if (previousDraftEditingRef.current === isDraftEditing) {
      return;
    }

    previousDraftEditingRef.current = isDraftEditing;

    if (draftChromeTransitionTimeoutRef.current !== null) {
      clearTimeout(draftChromeTransitionTimeoutRef.current);
      draftChromeTransitionTimeoutRef.current = null;
    }

    animateCardChromeStages(0);
    animateActivityDetailStage(0);
    draftChromeTransitionTimeoutRef.current = setTimeout(() => {
      setIsDraftPresentationActive(isDraftEditing);
      draftChromeTransitionTimeoutRef.current = setTimeout(() => {
        draftChromeTransitionTimeoutRef.current = null;
        animateCardChromeStages(1);
        animateActivityDetailStage(1);
      }, HEART_CARD_CHROME_REVEAL_DELAY_AFTER_SWAP_MS);
    }, HEART_CARD_CHROME_SWAP_DELAY_MS);
  }, [
    animateActivityDetailStage,
    animateCardChromeStages,
    isDraftEditing,
  ]);

  useEffect(() => {
    return () => {
      if (draftChromeTransitionTimeoutRef.current !== null) {
        clearTimeout(draftChromeTransitionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isFocusTransitioningRef.current) {
      return;
    }

    animateCardChromeStages(1);
  }, [animateCardChromeStages, focusedMarker?.id]);

  useEffect(() => {
    setSelectedSleepStage(null);
  }, [focusedMarker?.id]);

  const handleActivityDetailContentLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);

    setActivityDetailMeasuredHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);

  useEffect(() => {
    setActivityActionError(null);

    if (!canManageFocusedActivity) {
      setRelabelModalVisible(false);
    }
  }, [actionableFocusedMarker?.id, canManageFocusedActivity]);

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
    const wasVisible = previousActivityDetailPanelVisibleRef.current;
    previousActivityDetailPanelVisibleRef.current = activityDetailPanelVisible;

    const nextMaxHeight = activityDetailPanelVisible ? activityDetailPanelTargetMaxHeight : 0;
    const nextOpacity = activityDetailPanelVisible ? 1 : 0;
    const nextMarginTop = activityDetailPanelVisible ? 12 : 0;
    const panelDelay = activityDetailPanelVisible && !wasVisible ? ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS : 0;
    const contentDelay = activityDetailPanelVisible && !wasVisible ? ACTIVITY_DETAIL_CHIP_STAGE_DELAY_MS : 0;

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
    activityDetailPanelTargetMaxHeight,
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

  const requestedChartFocusMarker = requestedSavedFocusMarker ?? activeFocusedDetailSnapshot?.marker ?? null;
  const chartResetKey = viewportKey ?? 'heart';
  const handleReturnFromFocus = useCallback(() => {
    clearFocusedDetail();
    setLatestJumpVersion((current) => current + 1);
  }, [clearFocusedDetail]);

  return (
    <GlassCard accentColor={cardAccentColor}>
      <Animated.View style={animatedCardHeaderStageStyle}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            {displayedFocusedCardContent ? (
              <View
                style={[
                  styles.cardIconWrap,
                  {
                    backgroundColor: `${cardAccentColor}18`,
                    borderColor: `${cardAccentColor}33`,
                  },
                ]}>
                <Ionicons color={cardAccentColor} name={displayedFocusedCardContent.iconName} size={16} />
              </View>
            ) : (
              <PulsingHeartIcon
                bpm={showLiveHeartRate ? Number(liveHeartRateLabel?.replace(' bpm', '') ?? 0) : null}
                color={colors.success}
                name="heart-outline"
                size={20}
                style={styles.cardTitleIcon}
              />
            )}
            <View style={styles.cardHeaderTextStack}>
              <Text style={styles.cardTitle} testID={chartTestID ? `${chartTestID}-title` : undefined}>
                {cardTitle}
              </Text>
              <Text style={styles.cardSubtitle}>{cardSubtitle}</Text>
            </View>
          </View>
          {isPresentedDraftEditing ? (
            <Text style={styles.actionMeta}>Draft activity</Text>
          ) : displayedFocusedCardContent ? (
            <View style={styles.actionWrap}>
              <View style={styles.actionButtonRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleReturnFromFocus}
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
          ) : showsLatestWindowButton || onOpen ? (
            <View style={styles.actionWrap}>
              {!showsLatestWindowButton && !onOpen ? <Text style={styles.actionMeta}>{trailingLabel}</Text> : null}
              <View style={styles.actionButtonRow}>
                {showsLatestWindowButton ? (
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
                      {resolvedLatestWindowLabel}
                    </Text>
                  </Pressable>
                ) : null}
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
        {displayedFocusedCardContent?.chips.length && !isActivityFocused ? (
          <View style={styles.cardChipRow}>
            {displayedFocusedCardContent.chips.map((chip) => (
              <StatChip accent={chip.accentColor} key={`${chip.label}-${chip.value}`} label={chip.label} value={chip.value} />
            ))}
          </View>
        ) : null}
      </Animated.View>

      <PannableHeartChart
        accentColor={chartAccentColor}
        activityDraft={activityDraft}
        anchorDayKey={viewportKey}
        axisTestID={chartTestID ? `${chartTestID}-axis` : undefined}
        canLoadMore={canLoadMore}
        chartTestID={chartTestID}
        height={chartHeight}
        highlightedSleepStage={isSleepFocused ? selectedSleepStage : null}
        isLoadingMore={isLoadingMore}
        markers={resolvedMarkers}
        onActivityDraftChange={setActivityDraft}
        jumpToLatestSignal={latestJumpVersion}
        requestedFocusedMarker={requestedChartFocusMarker}
        requestedFocusedMarkerId={requestedFocusMarkerId}
        onFocusedMarkerChange={handleFocusedMarkerChange}
        onFocusTransitionStateChange={handleFocusTransitionStateChange}
        onLoadMore={onLoadMore}
        onPinchZoomStepChange={onPinchZoomStepChange}
        onViewportWindowChange={setChartViewportState}
        onViewingLatestWindowChange={setIsViewingLatestWindow}
        pinchZoomSteps={pinchZoomSteps}
        pointIntervalMinutes={displayedChartSnapshot.pointIntervalMinutes ?? basePointIntervalMinutes}
        points={displayedChartSnapshot.series}
        resetKey={chartResetKey}
        windowPointCount={displayedWindowPointCount}
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
              onLayout={handleActivityDetailContentLayout}
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
              {showIdleCreateGraphActivity ? (
                <View style={styles.reviewActionRow}>
                  <ReviewActionButton
                    accentColor={colors.heart}
                    disabled={isDraftEditing || pendingActivityActionKey !== null}
                    label="Add New Activity"
                    onPress={handleStartDraftActivity}
                    testID={chartTestID ? `${chartTestID}-add-activity-button` : undefined}
                  />
                </View>
              ) : null}
              {isPresentedDraftEditing && displayedActivityDraft && !isAwaitingSavedActivityFocus ? (
                <View>
                  <View style={styles.draftTypeChipRow}>
                    {draftTypeOptions.map((option) => {
                      const accentColor = option === 'Sleep' ? colors.indigo : option === 'Nap' ? colors.aqua : colors.heart;
                      const selected = displayedActivityDraft.kind === option;

                      return (
                        <Pressable
                          accessibilityRole="button"
                          disabled={!isDraftEditing || pendingActivityActionKey !== null}
                          key={option}
                          onPress={() => handleSelectDraftActivityType(option)}
                          style={({ pressed }) => [
                            styles.draftTypeChipButton,
                            {
                              borderColor: selected ? `${accentColor}55` : colors.border,
                              backgroundColor: selected ? `${accentColor}16` : colors.surfaceMuted,
                            },
                            pendingActivityActionKey !== null ? styles.reviewActionButtonDisabled : null,
                            pressed ? styles.actionPressed : null,
                          ]}
                          testID={chartTestID ? `${chartTestID}-draft-type-${option.toLowerCase()}` : undefined}>
                          <View style={[styles.draftTypeChipDot, { backgroundColor: accentColor }]} />
                          <Text
                            style={[
                              styles.draftTypeChipText,
                              { color: selected ? accentColor : colors.text },
                            ]}>
                            {option}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}
              {activityActionError ? <Text style={styles.reviewActionError}>{activityActionError}</Text> : null}
              {isPresentedDraftEditing && !isAwaitingSavedActivityFocus ? (
                <View>
                  <View style={styles.reviewActionRow}>
                    <ReviewActionButton
                      accentColor={colors.muted}
                      disabled={!isDraftEditing || pendingActivityActionKey !== null}
                      label="Cancel"
                      onPress={handleCancelDraftActivity}
                      testID={chartTestID ? `${chartTestID}-draft-cancel` : undefined}
                    />
                    <ReviewActionButton
                      accentColor={colors.success}
                      disabled={!isDraftEditing || pendingActivityActionKey !== null}
                      label={pendingActivityActionKey === 'draft:save' ? 'Saving...' : 'Save'}
                      onPress={() => {
                        void handleSaveDraftActivity();
                      }}
                      testID={chartTestID ? `${chartTestID}-draft-save` : undefined}
                    />
                  </View>
                </View>
              ) : canManageFocusedActivity ? (
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
              ) : canEditFocusedSleep ? (
                <View style={styles.reviewActionRow}>
                  <ReviewActionButton
                    accentColor={colors.indigo}
                    disabled={pendingActivityActionKey !== null}
                    label="Edit Sleep"
                    onPress={handleEditFocusedActivity}
                    testID={chartTestID ? `${chartTestID}-sleep-edit` : undefined}
                  />
                </View>
              ) : canEditFocusedActivity ? (
                <View style={styles.reviewActionRow}>
                  <ReviewActionButton
                    accentColor={colors.heart}
                    disabled={pendingActivityActionKey !== null}
                    label="Edit"
                    onPress={handleEditFocusedActivity}
                    testID={chartTestID ? `${chartTestID}-activity-edit` : undefined}
                  />
                  <ReviewActionButton
                    accentColor={colors.alert}
                    disabled={pendingActivityActionKey !== null}
                    label={pendingActivityActionKey === `dismiss:${focusedMarker?.id}` ? 'Removing...' : 'Remove'}
                    onPress={() => {
                      void handleDismissFocusedActivity();
                    }}
                    testID={chartTestID ? `${chartTestID}-activity-remove` : undefined}
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

export function HeartCardStatus({
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
          <PulsingHeartIcon
            bpm={null}
            color={colors.success}
            name="heart-outline"
            size={20}
            style={styles.cardTitleIcon}
          />
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

export function SleepCard({
  chartTestID,
  onOpen,
  openTestID,
  cardData: cardData,
  trailingLabel,
}: {
  chartTestID: string;
  onOpen: () => void;
  openTestID: string;
  cardData: SleepCardData;
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
          <Text style={styles.sleepScore}>{formatMetricValue(cardData.score, 0)}%</Text>
          <Text style={styles.sleepDuration}>{formatCompactDuration(cardData.durationMinutes)}</Text>
        </View>
        <View style={styles.sleepMeta}>
          <Text style={styles.metricLabel}>In bed</Text>
          <Text style={styles.sleepMetaValue}>{formatCompactDuration(cardData.timeInBedMinutes)}</Text>
          <Text style={styles.sleepMetaCaption}>
            {cardData.startLabel} to {cardData.endLabel}
          </Text>
        </View>
      </View>

      <SleepStageChart
        accentColor={colors.violet}
        endLabel={cardData.endLabel}
        middleLabel={cardData.middleLabel}
        segments={cardData.stages}
        startLabel={cardData.startLabel}
        testID={chartTestID}
      />
    </GlassCard>
  );
}

export function ActivityCard({
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
  strainCard: StrainCardData;
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
  cardTitleIcon: {
    marginTop: 2,
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
  draftTypeChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  draftTypeChipButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  draftTypeChipDot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  draftTypeChipText: {
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
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
