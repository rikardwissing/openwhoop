import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  type SharedValue,
  cancelAnimation,
  interpolateColor,
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
import type { ActiveActivity, ManualActivityKind } from '@/data/HealthRepository';
import { SleepStageBreakdownChip } from '../ui/SleepStageBreakdownChip';
import type {
  ActivitySummary,
  DashboardInsight,
  FocusedHeartDetail,
  HeartCardData,
  HeartIntradayMarker,
  SleepStage,
  SleepStageSelection,
  SleepCardData,
  StrainCardData,
} from '@/types/health';
import { addMinutes, dateKey, formatClock } from '@/utils/dateTime';
import { formatCompactDuration, formatMetricValue, formatShortDuration } from '@/utils/formatters';
import { getManualActivityIconName } from '@/utils/activityIcons';
import {
  canManageHeartIntradayMarker,
  getHeartIntradayMarkerPresentation,
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
const ACTIVITY_DETAIL_DRAFT_PANEL_MAX_HEIGHT = 188;
const ACTIVITY_DETAIL_DRAFT_ERROR_PANEL_MAX_HEIGHT = 220;
const ACTIVITY_DETAIL_MANAGE_ERROR_PANEL_MAX_HEIGHT = 100;
const ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS = HEART_CARD_CHROME_STAGE_DELAY_MS * 3;
const ACTIVITY_DETAIL_CHIP_STAGE_DELAY_MS = ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS + 20;
const HEART_CARD_CHROME_SWAP_DELAY_MS = HEART_CARD_CHROME_OUT_DURATION_MS + HEART_CARD_CHROME_STAGE_DELAY_MS * 2;
const HEART_CARD_CHROME_REVEAL_DELAY_AFTER_SWAP_MS = 40;
const HEART_CARD_ACCENT_TRANSITION_DURATION_MS = 240;
const DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES = 5;
const MIN_HEART_ACTIVITY_DRAFT_MINUTE_SPAN = 1;
const DEFAULT_NEW_ACTIVITY_DURATION_MINUTES = 60;
const REVIEW_ACTIVITY_OPTIONS: ManualActivityKind[] = ['Activity', 'Walk', 'Workout', 'Running', 'Nap'];
const LIVE_ACTIVITY_OPTIONS: ManualActivityKind[] = ['Activity', 'Walk', 'Workout', 'Running'];
const REVIEW_DRAFT_OPTIONS: HeartMarkerDraftKind[] = [...REVIEW_ACTIVITY_OPTIONS, 'Sleep'];
const REVEAL_EASING = Easing.out(Easing.cubic);
const SLEEP_STAGE_BREAKDOWN_ORDER: SleepStage[] = ['deep', 'light', 'rem', 'awake'];

function formatSleepStageBreakdownLabel(stage: SleepStage) {
  return stage === 'rem' ? 'REM' : `${stage[0].toUpperCase()}${stage.slice(1)}`;
}

interface HeartActivityReviewActions {
  createManualActivity?: (activity: ManualActivityKind, start: Date, end: Date) => Promise<string>;
  createManualSleep?: (start: Date, end: Date) => Promise<string>;
  startActiveActivity?: (activity: ManualActivityKind, start: Date) => Promise<ActiveActivity>;
  stopActiveActivity?: () => Promise<void> | void;
  cancelActiveActivity?: () => Promise<void>;
  updateActivity?: (activityId: string, activity: ManualActivityKind, start: Date, end: Date) => Promise<void>;
  updateSleep?: (sleepId: string, start: Date, end: Date) => Promise<void>;
  confirmActivity: (activityId: string) => Promise<void>;
  dismissActivity: (activityId: string) => Promise<void>;
  relabelActivity: (activityId: string, activity: ManualActivityKind) => Promise<void>;
}

interface HeartChartViewportState {
  windowPointCount: number;
  windowStart: number;
}

type HeartCardScreen =
  | {
      kind: 'overview';
    }
  | {
      kind: 'draft';
      draft: HeartActivityDraft;
      editingMarkerId: string | null;
    };

interface HeartCardFocusRequest {
  marker: HeartIntradayMarker | null;
  markerId: string | null;
}

interface PendingHeartCardNavigation {
  focusRequest: HeartCardFocusRequest | null;
  id: number;
  screen: HeartCardScreen;
  waitForChartOverview: boolean;
}

function summarizeHeartCardMarker(marker: HeartIntradayMarker | null | undefined) {
  if (!marker) {
    return null;
  }

  return {
    endTimeMs: marker.endTimeMs ?? null,
    id: marker.id,
    kind: marker.kind,
    label: marker.label,
    startTimeMs: marker.startTimeMs ?? null,
  };
}

function buildHeartCardMarkerSignature(marker: HeartIntradayMarker | null | undefined) {
  if (!marker) {
    return 'none';
  }

  return [
    marker.id,
    marker.kind,
    marker.startTimeMs ?? 'none',
    marker.endTimeMs ?? 'none',
    marker.startFraction,
    marker.endFraction,
  ].join(':');
}

function buildHeartCardPersistedMarkerSignature(marker: HeartIntradayMarker | null | undefined) {
  if (!marker) {
    return 'none';
  }

  return [
    marker.id,
    marker.kind,
    marker.startTimeMs ?? 'none',
    marker.endTimeMs ?? 'none',
    String(marker.label ?? '').trim().toLowerCase(),
  ].join(':');
}

function summarizeHeartCardScreen(screen: HeartCardScreen) {
  if (screen.kind === 'overview') {
    return {
      kind: 'overview',
    };
  }

  return {
    draftKind: screen.draft.kind,
    editingMarkerId: screen.editingMarkerId,
    endMinuteOffset: screen.draft.endMinuteOffset,
    kind: 'draft',
    startMinuteOffset: screen.draft.startMinuteOffset,
  };
}

function summarizeHeartCardFocusRequest(request: HeartCardFocusRequest | null | undefined) {
  if (!request) {
    return null;
  }

  return {
    marker: summarizeHeartCardMarker(request.marker),
    markerId: request.markerId,
  };
}

function logHeartCardDebug(event: string, details?: Record<string, unknown>) {
  if (!__DEV__) {
    return;
  }

  console.log(`[heart-card] ${event}`, details ?? {});
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

function clearTimerRef(timerRef: { current: ReturnType<typeof setTimeout> | null }) {
  if (timerRef.current === null) {
    return;
  }

  clearTimeout(timerRef.current);
  timerRef.current = null;
}

function animateSharedNumber(
  value: SharedValue<number>,
  target: number,
  {
    delayMs = 0,
    durationMs,
  }: {
    delayMs?: number;
    durationMs: number;
  },
) {
  cancelAnimation(value);

  const animation = withTiming(target, {
    duration: durationMs,
    easing: REVEAL_EASING,
  });

  value.value = delayMs > 0 ? withDelay(delayMs, animation) : animation;
}

function animateStaggeredReveal(
  values: SharedValue<number>[],
  target: 0 | 1,
  {
    enterDelayMs = 0,
    enterDurationMs,
    exitDelayMs = 0,
    exitDurationMs,
    stageDelayMs = 0,
  }: {
    enterDelayMs?: number;
    enterDurationMs: number;
    exitDelayMs?: number;
    exitDurationMs: number;
    stageDelayMs?: number;
  },
) {
  const durationMs = target === 1 ? enterDurationMs : exitDurationMs;
  const baseDelayMs = target === 1 ? enterDelayMs : exitDelayMs;

  values.forEach((value, index) => {
    animateSharedNumber(value, target, {
      delayMs: baseDelayMs + index * stageDelayMs,
      durationMs,
    });
  });
}

function syncMountedVisibility({
  mounted,
  onUnmount,
  setMounted,
  timerRef,
  unmountDelayMs,
  visible,
}: {
  mounted: boolean;
  onUnmount?: () => void;
  setMounted: (mounted: boolean) => void;
  timerRef: { current: ReturnType<typeof setTimeout> | null };
  unmountDelayMs: number;
  visible: boolean;
}) {
  if (visible) {
    clearTimerRef(timerRef);

    if (!mounted) {
      setMounted(true);
    }

    return;
  }

  if (!mounted) {
    return;
  }

  clearTimerRef(timerRef);
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    setMounted(false);
    onUnmount?.();
  }, unmountDelayMs);
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
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)?$/i.exec(trimmed);

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

  if (!meridiem) {
    if (rawHours < 0 || rawHours > 23) {
      return null;
    }

    return rawHours * 60 + minutes + seconds / 60;
  }

  return (rawHours % 12 + (meridiem === 'PM' ? 12 : 0)) * 60 + minutes + seconds / 60;
}

function resolveHeartPointDate(
  points: readonly { label: string; minuteOffset?: number }[],
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

  const latestPointMinutes = points.at(-1)?.minuteOffset ?? parseHeartPointLabelMinutes(latestLabel);
  if (latestPointMinutes === null) {
    return null;
  }

  const anchorDate = new Date(`${anchorDayKey}T00:00:00`);
  const latestPointDate = addMinutes(anchorDate, latestPointMinutes);
  const totalSeriesMinutes = Math.max(points.length - 1, 0) * pointIntervalMinutes;

  return addMinutes(latestPointDate, Math.round(minuteOffset) - totalSeriesMinutes);
}

function resolveHeartMinuteOffset(
  points: readonly { label: string }[],
  anchorDayKey: string | undefined,
  timestampMs: number,
  pointIntervalMinutes = DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES,
) {
  if (!anchorDayKey || points.length === 0 || !Number.isFinite(timestampMs)) {
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
  const totalSeriesMinutes = Math.max((points.length - 1) * pointIntervalMinutes, 1);
  const minuteOffset = totalSeriesMinutes + (timestampMs - latestPointDate.getTime()) / 60000;

  return clampIndex(minuteOffset, 0, totalSeriesMinutes);
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
  points: readonly { label: string }[],
  anchorDayKey: string | undefined,
  pointIntervalMinutes = DEFAULT_HEART_CHART_POINT_INTERVAL_MINUTES,
): HeartActivityDraft | null {
  const pointCount = points.length;
  if (pointCount < 2) {
    return null;
  }

  const totalSeriesMinutes = Math.max((pointCount - 1) * pointIntervalMinutes, 1);
  const fractionStartMinuteOffset = clampIndex(
    Math.round(Math.max(0, Math.min(1, marker.startFraction)) * totalSeriesMinutes),
    0,
    totalSeriesMinutes,
  );
  const fractionEndMinuteOffset = clampIndex(
    Math.round(Math.max(0, Math.min(1, marker.endFraction)) * totalSeriesMinutes),
    fractionStartMinuteOffset + 1,
    totalSeriesMinutes,
  );
  const exactStartMinuteOffset =
    marker.startTimeMs !== undefined
      ? resolveHeartMinuteOffset(points, anchorDayKey, marker.startTimeMs, pointIntervalMinutes)
      : null;
  const exactEndMinuteOffset =
    marker.endTimeMs !== undefined
      ? resolveHeartMinuteOffset(points, anchorDayKey, marker.endTimeMs, pointIntervalMinutes)
      : null;
  const startMinuteOffset = exactStartMinuteOffset ?? fractionStartMinuteOffset;
  const endMinuteOffset = clampIndex(
    exactEndMinuteOffset ?? fractionEndMinuteOffset,
    startMinuteOffset + MIN_HEART_ACTIVITY_DRAFT_MINUTE_SPAN,
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

function buildHeartLiveActivityDraftMarker(draft: HeartActivityDraft | null): HeartIntradayMarker | null {
  if (!draft || !isManualActivityKind(draft.kind) || draft.kind === 'Nap') {
    return null;
  }

  return {
    id: 'draft-live-activity',
    kind: 'activity',
    label: draft.kind,
    timeLabel: 'Starts when you press Start',
    startFraction: 1,
    endFraction: 1,
    details: {
      durationMinutes: null,
      isInProgress: true,
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
      iconName: presentation.iconName,
      subtitle: marker.timeLabel,
      title: marker.label,
      metrics: [
        sleepDetails?.isInProgress
          ? {
              label: 'Status',
              value: 'Active',
            }
          : {
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
    iconName: presentation.iconName,
    subtitle: marker.timeLabel,
    title: marker.label,
    metrics: [
      {
        label: marker.details?.isInProgress ? 'Start' : 'Duration',
        value: marker.details?.isInProgress ? 'Now' : formatCompactDuration(marker.details?.durationMinutes ?? null),
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
  activeActivity,
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
  activeActivity?: ActiveActivity | null;
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
  const [screen, setScreen] = useState<HeartCardScreen>({ kind: 'overview' });
  const [pendingNavigation, setPendingNavigation] = useState<PendingHeartCardNavigation | null>(null);
  const [navigationPhase, setNavigationPhase] = useState<'idle' | 'hiding' | 'revealing'>('idle');
  const [navigationReadyId, setNavigationReadyId] = useState<number | null>(null);
  const [chartFocusRequest, setChartFocusRequest] = useState<HeartCardFocusRequest | null>(null);
  const [chartFocusedMarker, setChartFocusedMarker] = useState<HeartIntradayMarker | null>(null);
  const [presentedOverviewFocusedMarker, setPresentedOverviewFocusedMarker] = useState<HeartIntradayMarker | null>(null);
  const [pendingSavedMarkerFocusRequest, setPendingSavedMarkerFocusRequest] = useState<HeartCardFocusRequest | null>(null);
  const [pendingActivityActionKey, setPendingActivityActionKey] = useState<string | null>(null);
  const [activityActionError, setActivityActionError] = useState<string | null>(null);
  const [draftLiveActivityEnabled, setDraftLiveActivityEnabled] = useState(false);
  const [isLiveStartTransitioning, setIsLiveStartTransitioning] = useState(false);
  const [relabelModalVisible, setRelabelModalVisible] = useState(false);
  const [focusedDetailState, setFocusedDetailState] = useState<{
    key: string | null;
    snapshot: FocusedHeartDetail | null;
    status: 'idle' | 'loading' | 'ready' | 'error';
  }>({
    key: null,
    snapshot: null,
    status: 'idle',
  });
  const [isChartFocusTransitioning, setIsChartFocusTransitioning] = useState(false);
  const [cardAccentTransitionDurationMs, setCardAccentTransitionDurationMs] = useState(
    HEART_CARD_ACCENT_TRANSITION_DURATION_MS,
  );
  const [selectedSleepStage, setSelectedSleepStage] = useState<SleepStage | null>(null);
  const [isSleepStagePanelMounted, setIsSleepStagePanelMounted] = useState(false);
  const [isActivityDetailPanelMounted, setIsActivityDetailPanelMounted] = useState(false);
  const [activityDetailMeasuredHeight, setActivityDetailMeasuredHeight] = useState(0);
  const [renderedSleepStageChips, setRenderedSleepStageChips] = useState<HeartMetricChip[]>([]);

  const focusedDetailRequestKeyRef = useRef<string | null>(null);
  const previousActivityDetailPanelVisibleRef = useRef(false);
  const sleepStagePanelUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityDetailPanelUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationRevealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overviewFocusSwapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationIdRef = useRef(0);
  const resolvedLatestWindowLabel = latestWindowLabel ?? (trailingLabel === 'Last 12h' ? trailingLabel : null);
  const showsLatestWindowButton = resolvedLatestWindowLabel !== null;
  const activityDraft = screen.kind === 'draft' ? screen.draft : null;
  const isDraftEditing = activityDraft !== null;
  const editingMarkerId = screen.kind === 'draft' ? screen.editingMarkerId : null;
  const draftLiveActivityMode = Boolean(
    draftLiveActivityEnabled &&
    activityDraft &&
    editingMarkerId === null &&
    !activeActivity &&
    activityReviewActions?.startActiveActivity,
  );
  const hiddenEditingMarkerId = editingMarkerId && activityDraft !== null ? editingMarkerId : null;
  const activityDraftMarker = useMemo(
    () => draftLiveActivityMode
      ? buildHeartLiveActivityDraftMarker(activityDraft)
      : buildHeartActivityDraftMarker(activityDraft, cardData.series, viewportKey, basePointIntervalMinutes),
    [activityDraft, basePointIntervalMinutes, cardData.series, draftLiveActivityMode, viewportKey],
  );
  const allBaseResolvedMarkers = useMemo(
    () => applyHeartMarkerOverrides(cardData.markers, activityMarkerOverrides),
    [activityMarkerOverrides, cardData.markers],
  );
  const baseResolvedMarkers = useMemo(() => {
    if (!hiddenEditingMarkerId) {
      return allBaseResolvedMarkers;
    }

    return allBaseResolvedMarkers.filter((marker) => marker.id !== hiddenEditingMarkerId);
  }, [allBaseResolvedMarkers, hiddenEditingMarkerId]);
  const editingBaseMarker = useMemo(
    () => (editingMarkerId ? allBaseResolvedMarkers.find((marker) => marker.id === editingMarkerId) ?? null : null),
    [allBaseResolvedMarkers, editingMarkerId],
  );
  const resolvedBaseFocusedMarker = useMemo(
    () => resolveActiveHeartMarker(chartFocusedMarker, baseResolvedMarkers, chartFocusRequest?.marker ?? null),
    [baseResolvedMarkers, chartFocusRequest, chartFocusedMarker],
  );
  const focusedDetailKey = useMemo(() => {
    if (
      !loadFocusedDetail ||
      isDraftEditing ||
      !resolvedBaseFocusedMarker ||
      resolvedBaseFocusedMarker.startTimeMs === undefined ||
      resolvedBaseFocusedMarker.endTimeMs === undefined
    ) {
      return null;
    }

    return `${resolvedBaseFocusedMarker.id}:${resolvedBaseFocusedMarker.startTimeMs}:${resolvedBaseFocusedMarker.endTimeMs}`;
  }, [isDraftEditing, loadFocusedDetail, resolvedBaseFocusedMarker]);
  const chartFocusedDetailSnapshot =
    focusedDetailKey !== null &&
    focusedDetailState.status === 'ready' &&
    focusedDetailState.key === focusedDetailKey
      ? focusedDetailState.snapshot
      : null;
  const chartSnapshot = useMemo(
    () => (chartFocusedDetailSnapshot ? buildFocusedHeartCardData(cardData, chartFocusedDetailSnapshot) : cardData),
    [cardData, chartFocusedDetailSnapshot],
  );
  const chartMarkers = useMemo(
    () => {
      const nextMarkers = applyHeartMarkerOverrides(chartSnapshot.markers, activityMarkerOverrides);

      if (!hiddenEditingMarkerId) {
        return nextMarkers;
      }

      return nextMarkers.filter((marker) => marker.id !== hiddenEditingMarkerId);
    },
    [activityMarkerOverrides, chartSnapshot.markers, hiddenEditingMarkerId],
  );
  const resolvedChartFocusedMarker = useMemo(
    () => resolveActiveHeartMarker(chartFocusedMarker, chartMarkers, chartFocusRequest?.marker ?? null),
    [chartFocusRequest, chartFocusedMarker, chartMarkers],
  );
  const resolvedPresentedOverviewFocusedMarker = useMemo(
    () => resolveActiveHeartMarker(presentedOverviewFocusedMarker, chartMarkers, chartFocusRequest?.marker ?? null),
    [chartFocusRequest, chartMarkers, presentedOverviewFocusedMarker],
  );
  const readySavedMarkerFromDb = useMemo(() => {
    if (!pendingSavedMarkerFocusRequest?.markerId || !pendingSavedMarkerFocusRequest.marker) {
      return null;
    }

    const candidate = allBaseResolvedMarkers.find((marker) => marker.id === pendingSavedMarkerFocusRequest.markerId);

    if (!candidate) {
      return null;
    }

    return buildHeartCardPersistedMarkerSignature(candidate) ===
      buildHeartCardPersistedMarkerSignature(pendingSavedMarkerFocusRequest.marker)
      ? candidate
      : null;
  }, [allBaseResolvedMarkers, pendingSavedMarkerFocusRequest]);
  const isDraftNavigationPending = pendingNavigation?.screen.kind === 'draft';
  const displayedFocusedMarker = isDraftEditing
    ? activityDraftMarker
    : resolvedPresentedOverviewFocusedMarker;
  const displayedFocusedCardContent = displayedFocusedMarker
    ? buildFocusedHeartCardContent(chartSnapshot, displayedFocusedMarker)
    : null;
  const actionableFocusedMarker = useMemo(() => {
    if (isDraftEditing) {
      return editingBaseMarker;
    }

    if (displayedFocusedMarker) {
      return baseResolvedMarkers.find((candidate) => candidate.id === displayedFocusedMarker.id) ?? displayedFocusedMarker;
    }

    return null;
  }, [baseResolvedMarkers, displayedFocusedMarker, editingBaseMarker, isDraftEditing]);
  const cardAccentColor = displayedFocusedCardContent?.accentColor ?? colors.success;
  const chartOverlayAccentColor = isDraftEditing
    ? colors.primary
    : displayedFocusedCardContent?.accentColor ?? colors.primary;
  const isSleepFocused = displayedFocusedMarker?.kind === 'sleep';
  const isActivityFocused = displayedFocusedMarker?.kind === 'activity' || displayedFocusedMarker?.kind === 'nap';
  const cardAccentTransitionProgress = useSharedValue(1);
  const previousCardAccentColor = useSharedValue(cardAccentColor);
  const nextCardAccentColor = useSharedValue(cardAccentColor);
  const canManageFocusedActivity = Boolean(
    !isDraftEditing &&
      activityReviewActions &&
      actionableFocusedMarker &&
      canManageHeartIntradayMarker(actionableFocusedMarker),
  );
  const canEditFocusedActivity = Boolean(
    !isDraftEditing &&
      !isDraftNavigationPending &&
      activityReviewActions?.updateActivity &&
      actionableFocusedMarker &&
      actionableFocusedMarker.kind !== 'sleep' &&
      !canManageHeartIntradayMarker(actionableFocusedMarker) &&
      actionableFocusedMarker.id !== 'draft-activity' &&
      pendingActivityActionKey !== 'draft:save',
  );
  const canRemoveFocusedActivity = Boolean(
    !isDraftEditing &&
      !isDraftNavigationPending &&
      activityReviewActions?.dismissActivity &&
      actionableFocusedMarker &&
      actionableFocusedMarker.kind !== 'sleep' &&
      !canManageHeartIntradayMarker(actionableFocusedMarker) &&
      actionableFocusedMarker.id !== 'draft-activity' &&
      pendingActivityActionKey !== 'draft:save',
  );
  const canEditManagedActivity = Boolean(
    !isDraftEditing &&
      !isDraftNavigationPending &&
      activityReviewActions?.updateActivity &&
      actionableFocusedMarker &&
      canManageHeartIntradayMarker(actionableFocusedMarker) &&
      pendingActivityActionKey !== 'draft:save',
  );
  const canEditFocusedSleep = Boolean(
    !isDraftEditing &&
      !isDraftNavigationPending &&
      activityReviewActions?.updateSleep &&
      actionableFocusedMarker?.kind === 'sleep' &&
      pendingActivityActionKey !== 'draft:save',
  );
  const canCreateGraphActivity = Boolean(activityReviewActions?.createManualActivity && activityReviewActions?.createManualSleep) && !isDraftEditing;
  const canStartActiveActivity = Boolean(activityReviewActions?.startActiveActivity) && !editingBaseMarker;
  const canToggleDraftLiveActivity = Boolean(
    canStartActiveActivity &&
    isDraftEditing &&
    !editingBaseMarker &&
    !activeActivity,
  );
  const liveActivityDraftEnabled = Boolean(
    (draftLiveActivityMode && canToggleDraftLiveActivity) ||
    (isLiveStartTransitioning && isDraftEditing),
  );
  const isAwaitingChartFocus = Boolean(
    chartFocusRequest?.markerId != null && chartFocusedMarker?.id !== chartFocusRequest.markerId,
  );
  const displayedWindowPointCount = chartFocusedDetailSnapshot
    ? chartSnapshot.series.length
    : resolvedWindowPointCount;
  const viewportSeriesSummary = useMemo(
    () => summarizeViewportHeartValues(chartSnapshot, chartViewportState),
    [chartSnapshot, chartViewportState],
  );
  const showIdleCreateGraphActivity =
    canCreateGraphActivity &&
    !activeActivity &&
    displayedFocusedMarker === null &&
    !isDraftNavigationPending &&
    !isAwaitingChartFocus;
  const activityDetailChips = isActivityFocused ? displayedFocusedCardContent?.chips ?? [] : [];
  const sleepStageChips = displayedFocusedCardContent?.stageChips ?? [];
  const sleepStageChipSignature = useMemo(
    () => sleepStageChips.map((chip) => `${chip.label}:${chip.value}:${chip.accentColor}`).join('|'),
    [sleepStageChips],
  );
  const draftTypeOptions: HeartMarkerDraftKind[] = editingBaseMarker?.kind === 'sleep'
    ? ['Sleep']
    : editingBaseMarker
      ? REVIEW_ACTIVITY_OPTIONS
      : liveActivityDraftEnabled
        ? LIVE_ACTIVITY_OPTIONS
      : REVIEW_DRAFT_OPTIONS;
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
    : isDraftEditing
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
  const [isOverviewFocusSwapping, setIsOverviewFocusSwapping] = useState(false);
  const cardChromeVisible = navigationPhase !== 'hiding' && !isOverviewFocusSwapping;
  const revealedSleepStagePanelVisible = sleepStagePanelVisible && cardChromeVisible;
  const revealedActivityDetailPanelVisible = activityDetailPanelVisible && cardChromeVisible;
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
  const [previousRenderedCardAccentColor, setPreviousRenderedCardAccentColor] = useState(cardAccentColor);

  useEffect(() => {
    setPreviousRenderedCardAccentColor(nextCardAccentColor.value);
    previousCardAccentColor.value = nextCardAccentColor.value;
    nextCardAccentColor.value = cardAccentColor;
    cardAccentTransitionProgress.value = 0;
    cardAccentTransitionProgress.value = withTiming(1, {
      duration: cardAccentTransitionDurationMs,
      easing: Easing.out(Easing.cubic),
    });
  }, [
    cardAccentColor,
    cardAccentTransitionDurationMs,
    cardAccentTransitionProgress,
    nextCardAccentColor,
    previousCardAccentColor,
  ]);

  const animatedFocusedCardTextAccentStyle = useAnimatedStyle(
    () => ({
      color: interpolateColor(
        cardAccentTransitionProgress.value,
        [0, 1],
        [previousCardAccentColor.value, nextCardAccentColor.value],
      ),
    }),
    [cardAccentTransitionProgress, nextCardAccentColor, previousCardAccentColor],
  );
  const animatedFocusedCardPreviousAccentOpacityStyle = useAnimatedStyle(
    () => ({
      opacity: 1 - cardAccentTransitionProgress.value,
    }),
    [cardAccentTransitionProgress],
  );
  const animatedFocusedCardNextAccentOpacityStyle = useAnimatedStyle(
    () => ({
      opacity: cardAccentTransitionProgress.value,
    }),
    [cardAccentTransitionProgress],
  );

  const animatedFocusedCardIconWrapStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(
        cardAccentTransitionProgress.value,
        [0, 1],
        [`${previousCardAccentColor.value}18`, `${nextCardAccentColor.value}18`],
      ),
      borderColor: interpolateColor(
        cardAccentTransitionProgress.value,
        [0, 1],
        [`${previousCardAccentColor.value}33`, `${nextCardAccentColor.value}33`],
      ),
    }),
    [cardAccentTransitionProgress, nextCardAccentColor, previousCardAccentColor],
  );

  const animatedFocusedActionButtonStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(
        cardAccentTransitionProgress.value,
        [0, 1],
        [`${previousCardAccentColor.value}14`, `${nextCardAccentColor.value}14`],
      ),
      borderColor: interpolateColor(
        cardAccentTransitionProgress.value,
        [0, 1],
        [`${previousCardAccentColor.value}33`, `${nextCardAccentColor.value}33`],
      ),
    }),
    [cardAccentTransitionProgress, nextCardAccentColor, previousCardAccentColor],
  );

  const setCardChromeVisibleAnimated = useCallback(
    (visible: boolean) => {
      animateStaggeredReveal(
        [cardHeaderTransitionProgress, cardMetricsTransitionProgress, cardChipsTransitionProgress],
        visible ? 1 : 0,
        {
          enterDurationMs: HEART_CARD_CHROME_IN_DURATION_MS,
          exitDurationMs: HEART_CARD_CHROME_OUT_DURATION_MS,
          stageDelayMs: HEART_CARD_CHROME_STAGE_DELAY_MS,
        },
      );
    },
    [cardChipsTransitionProgress, cardHeaderTransitionProgress, cardMetricsTransitionProgress],
  );

  const handleActivityDraftChange = useCallback((nextDraft: HeartActivityDraft) => {
    logHeartCardDebug('draft.change', {
      endMinuteOffset: nextDraft.endMinuteOffset,
      kind: nextDraft.kind,
      startMinuteOffset: nextDraft.startMinuteOffset,
    });
    setScreen((current) => (current.kind === 'draft' ? { ...current, draft: nextDraft } : current));
  }, []);

  const handleFocusedMarkerChange = useCallback((nextMarker: HeartIntradayMarker | null) => {
    logHeartCardDebug('chart.focus.change', {
      marker: summarizeHeartCardMarker(nextMarker),
    });
    setChartFocusedMarker(nextMarker);
  }, []);

  const handleFocusTransitionStateChange = useCallback((isTransitioning: boolean, transitionDurationMs?: number) => {
    logHeartCardDebug('chart.focus.transition', {
      durationMs: transitionDurationMs ?? null,
      isTransitioning,
    });
    setIsChartFocusTransitioning(isTransitioning);

    if (typeof transitionDurationMs === 'number' && transitionDurationMs > 0) {
      setCardAccentTransitionDurationMs(transitionDurationMs);
    }
  }, []);

  const clearFocusedDetail = useCallback(() => {
    focusedDetailRequestKeyRef.current = null;
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

  const clearChartFocusRequest = useCallback(() => {
    setChartFocusRequest(null);
  }, []);

  const cancelNavigationTimers = useCallback(() => {
    clearTimerRef(navigationHideTimeoutRef);
    clearTimerRef(navigationRevealTimeoutRef);
  }, []);

  const navigateHeartCard = useCallback(
    (
      nextScreen: HeartCardScreen,
      {
        clearActionError = true,
        clearActionState = true,
        clearChartFocus = false,
        clearFocusDetail = true,
        focusRequest = null,
        jumpToLatest = false,
        waitForChartOverview = false,
      }: {
        clearActionError?: boolean;
        clearActionState?: boolean;
        clearChartFocus?: boolean;
        clearFocusDetail?: boolean;
        focusRequest?: HeartCardFocusRequest | null;
        jumpToLatest?: boolean;
        waitForChartOverview?: boolean;
      } = {},
    ) => {
      const navigationId = navigationIdRef.current + 1;
      navigationIdRef.current = navigationId;

      logHeartCardDebug('navigate.request', {
        chartFocusedMarker: summarizeHeartCardMarker(chartFocusedMarker),
        clearActionError,
        clearActionState,
        clearChartFocus,
        clearFocusDetail,
        focusRequest: summarizeHeartCardFocusRequest(focusRequest),
        fromScreen: summarizeHeartCardScreen(screen),
        jumpToLatest,
        navigationId,
        navigationPhase,
        toScreen: summarizeHeartCardScreen(nextScreen),
        waitForChartOverview,
      });

      if (clearFocusDetail) {
        clearFocusedDetail();
      }

      if (clearActionError) {
        setActivityActionError(null);
      }

      if (clearActionState) {
        setPendingActivityActionKey(null);
      }

      if (clearChartFocus) {
        clearChartFocusRequest();
      }

      if (jumpToLatest) {
        setLatestJumpVersion((current) => current + 1);
      }

      cancelNavigationTimers();
      setPendingNavigation({
        focusRequest,
        id: navigationId,
        screen: nextScreen,
        waitForChartOverview,
      });
      setNavigationReadyId(null);
      setNavigationPhase('hiding');

      navigationHideTimeoutRef.current = setTimeout(() => {
        if (navigationIdRef.current !== navigationId) {
          return;
        }

        navigationHideTimeoutRef.current = null;
        logHeartCardDebug('navigate.ready', {
          navigationId,
        });
        setNavigationReadyId(navigationId);
      }, HEART_CARD_CHROME_SWAP_DELAY_MS);
    },
    [cancelNavigationTimers, chartFocusedMarker, clearChartFocusRequest, clearFocusedDetail, navigationPhase, screen],
  );

  const isChartOverviewResolved = !isChartFocusTransitioning && chartFocusedMarker === null;

  useEffect(() => {
    if (!pendingNavigation || navigationReadyId !== pendingNavigation.id) {
      return;
    }

    if (pendingNavigation.waitForChartOverview && !isChartOverviewResolved) {
      return;
    }

    const navigationId = pendingNavigation.id;

    logHeartCardDebug('navigate.commit', {
      focusRequest: summarizeHeartCardFocusRequest(pendingNavigation.focusRequest),
      navigationId,
      screen: summarizeHeartCardScreen(pendingNavigation.screen),
    });

    setScreen(pendingNavigation.screen);
    setChartFocusRequest(pendingNavigation.focusRequest);
    setPendingNavigation(null);
    setNavigationReadyId(null);
    setNavigationPhase('revealing');

    clearTimerRef(navigationRevealTimeoutRef);
    navigationRevealTimeoutRef.current = setTimeout(() => {
      if (navigationIdRef.current !== navigationId) {
        return;
      }

      navigationRevealTimeoutRef.current = null;
      logHeartCardDebug('navigate.reveal-complete', {
        navigationId,
      });
      setNavigationPhase('idle');
    }, HEART_CARD_CHROME_REVEAL_DELAY_AFTER_SWAP_MS);
  }, [isChartOverviewResolved, navigationReadyId, pendingNavigation]);

  useEffect(() => {
    if (!chartFocusRequest) {
      return;
    }

    if (chartFocusRequest.markerId === null) {
      if (chartFocusedMarker === null && !isChartFocusTransitioning) {
        logHeartCardDebug('focus-request.clear', {
          reason: 'chart-returned-to-overview',
          request: summarizeHeartCardFocusRequest(chartFocusRequest),
        });
        setChartFocusRequest(null);
      }

      return;
    }

    if (chartFocusedMarker?.id === chartFocusRequest.markerId) {
      logHeartCardDebug('focus-request.clear', {
        matchedMarker: summarizeHeartCardMarker(chartFocusedMarker),
        reason: 'target-marker-reached',
        request: summarizeHeartCardFocusRequest(chartFocusRequest),
      });
      setChartFocusRequest(null);
    }
  }, [chartFocusRequest, chartFocusedMarker, isChartFocusTransitioning]);

  const desiredOverviewFocusSignature = buildHeartCardMarkerSignature(resolvedChartFocusedMarker);
  const presentedOverviewFocusSignature = buildHeartCardMarkerSignature(resolvedPresentedOverviewFocusedMarker);

  useEffect(() => {
    if (isDraftEditing) {
      clearTimerRef(overviewFocusSwapTimeoutRef);
      setIsOverviewFocusSwapping(false);
      return;
    }

    if (navigationPhase !== 'idle') {
      clearTimerRef(overviewFocusSwapTimeoutRef);
      setIsOverviewFocusSwapping(false);
      setPresentedOverviewFocusedMarker(resolvedChartFocusedMarker);
      return;
    }

    if (desiredOverviewFocusSignature === presentedOverviewFocusSignature) {
      return;
    }

    clearTimerRef(overviewFocusSwapTimeoutRef);
    logHeartCardDebug('presentation.swap.start', {
      nextMarker: summarizeHeartCardMarker(resolvedChartFocusedMarker),
      previousMarker: summarizeHeartCardMarker(resolvedPresentedOverviewFocusedMarker),
    });
    setIsOverviewFocusSwapping(true);
    overviewFocusSwapTimeoutRef.current = setTimeout(() => {
      overviewFocusSwapTimeoutRef.current = null;
      logHeartCardDebug('presentation.swap.commit', {
        nextMarker: summarizeHeartCardMarker(resolvedChartFocusedMarker),
      });
      setPresentedOverviewFocusedMarker(resolvedChartFocusedMarker);
      setIsOverviewFocusSwapping(false);
    }, HEART_CARD_CHROME_SWAP_DELAY_MS);
  }, [
    desiredOverviewFocusSignature,
    isDraftEditing,
    navigationPhase,
    presentedOverviewFocusSignature,
    resolvedChartFocusedMarker,
    resolvedPresentedOverviewFocusedMarker,
  ]);

  useEffect(() => {
    logHeartCardDebug('presentation.focus', {
      awaitingChartFocus: isAwaitingChartFocus,
      chartFocusedMarker: summarizeHeartCardMarker(chartFocusedMarker),
      chartFocusRequest: summarizeHeartCardFocusRequest(chartFocusRequest),
      displayedFocusedMarker: summarizeHeartCardMarker(displayedFocusedMarker),
      isChartFocusTransitioning,
      navigationPhase,
      screen: summarizeHeartCardScreen(screen),
    });
  }, [
    chartFocusRequest,
    chartFocusedMarker?.id,
    displayedFocusedMarker?.id,
    isAwaitingChartFocus,
    isChartFocusTransitioning,
    navigationPhase,
    screen,
  ]);

  useEffect(() => {
    if (!focusedDetailKey || !loadFocusedDetail || !resolvedBaseFocusedMarker) {
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
    logHeartCardDebug('focused-detail.load-start', {
      key: focusedDetailKey,
      marker: summarizeHeartCardMarker(resolvedBaseFocusedMarker),
    });
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

    void loadFocusedDetail(resolvedBaseFocusedMarker)
      .then((detailSnapshot) => {
        if (focusedDetailRequestKeyRef.current !== focusedDetailKey) {
          return;
        }

        logHeartCardDebug('focused-detail.load-ready', {
          key: focusedDetailKey,
          marker: summarizeHeartCardMarker(resolvedBaseFocusedMarker),
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

        logHeartCardDebug('focused-detail.load-error', {
          error: error instanceof Error ? error.message : String(error),
          key: focusedDetailKey,
          marker: summarizeHeartCardMarker(resolvedBaseFocusedMarker),
        });

        setFocusedDetailState({
          key: focusedDetailKey,
          snapshot: null,
          status: 'error',
        });
      });
  }, [clearFocusedDetail, focusedDetailKey, focusedDetailState.key, focusedDetailState.status, loadFocusedDetail, resolvedBaseFocusedMarker]);

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
    const fallbackViewportState = {
      windowPointCount: resolvedWindowPointCount,
      windowStart: Math.max(cardData.series.length - resolvedWindowPointCount, 0),
    };
    const nextViewportState = chartViewportState ?? fallbackViewportState;

    logHeartCardDebug('action.start-draft', {
      nextViewportState,
    });

    setDraftLiveActivityEnabled(false);

    navigateHeartCard(
      {
        kind: 'draft',
        draft: buildInitialHeartActivityDraft(
          'Activity',
          nextViewportState,
          cardData.series.length,
          basePointIntervalMinutes,
        ),
        editingMarkerId: null,
      },
    );
  }, [basePointIntervalMinutes, chartViewportState, navigateHeartCard, resolvedWindowPointCount, cardData.series.length]);

  const handleEditFocusedActivity = useCallback(() => {
    if (!actionableFocusedMarker) {
      return;
    }

    if (actionableFocusedMarker.kind === 'sleep') {
      if (!activityReviewActions?.updateSleep) {
        return;
      }
    } else if (!activityReviewActions?.updateActivity) {
      return;
    }

    const nextDraft = buildHeartActivityDraftFromMarker(
      actionableFocusedMarker,
      cardData.series,
      viewportKey,
      basePointIntervalMinutes,
    );
    if (!nextDraft) {
      setActivityActionError('Unable to edit this activity from the chart right now.');
      return;
    }

    logHeartCardDebug('action.edit-focused', {
      draft: {
        endMinuteOffset: nextDraft.endMinuteOffset,
        kind: nextDraft.kind,
        startMinuteOffset: nextDraft.startMinuteOffset,
      },
      marker: summarizeHeartCardMarker(actionableFocusedMarker),
    });

    setDraftLiveActivityEnabled(false);
    navigateHeartCard(
      {
        kind: 'draft',
        draft: nextDraft,
        editingMarkerId: actionableFocusedMarker.id,
      },
      {
        clearChartFocus: true,
        jumpToLatest: true,
        waitForChartOverview: true,
      },
    );
  }, [
    actionableFocusedMarker,
    activityReviewActions?.updateActivity,
    activityReviewActions?.updateSleep,
    basePointIntervalMinutes,
    cardData.series,
    navigateHeartCard,
    viewportKey,
  ]);

  const handleSelectDraftActivityType = useCallback((activity: HeartMarkerDraftKind) => {
    setActivityActionError(null);
    setScreen((current) => {
      if (current.kind !== 'draft') {
        return current;
      }

      return {
        ...current,
        draft: {
          ...current.draft,
          kind: activity,
        },
      };
    });
  }, []);

  const handleDraftLiveActivityToggle = useCallback((enabled: boolean) => {
    setActivityActionError(null);
    setDraftLiveActivityEnabled(enabled);

    if (!enabled) {
      return;
    }

    setScreen((current) => {
      if (current.kind !== 'draft' || current.editingMarkerId !== null) {
        return current;
      }

      const kind = current.draft.kind === 'Sleep' || current.draft.kind === 'Nap'
        ? 'Running'
        : current.draft.kind;

      return {
        ...current,
        draft: {
          ...current.draft,
          kind,
        },
      };
    });
  }, []);

  const handleCancelDraftActivity = useCallback(() => {
    logHeartCardDebug('action.cancel-draft', {
      editingMarker: summarizeHeartCardMarker(editingBaseMarker),
      screen: summarizeHeartCardScreen(screen),
    });
    navigateHeartCard(
      { kind: 'overview' },
      {
        focusRequest: editingBaseMarker
          ? {
              marker: editingBaseMarker,
              markerId: editingBaseMarker.id,
            }
          : null,
      },
    );
  }, [editingBaseMarker, navigateHeartCard, screen]);

  const handleStartActiveDraftActivity = useCallback(async () => {
    const draftToStart = activityDraft;
    const reviewActions = activityReviewActions;

    if (!liveActivityDraftEnabled || !draftToStart || !reviewActions?.startActiveActivity || !isManualActivityKind(draftToStart.kind)) {
      return;
    }

    if (draftToStart.kind === 'Nap') {
      setActivityActionError('Start a live activity as Activity, Walk, Workout, or Running.');
      return;
    }

    setActivityActionError(null);
    setPendingActivityActionKey('draft:start-live');
    setIsLiveStartTransitioning(true);

    try {
      await reviewActions.startActiveActivity(draftToStart.kind, new Date());
      setLatestJumpVersion((current) => current + 1);
      navigateHeartCard({ kind: 'overview' }, { clearChartFocus: true, jumpToLatest: true });
    } catch (error) {
      setIsLiveStartTransitioning(false);
      setActivityActionError(error instanceof Error ? error.message : 'Unable to start this activity right now.');
    } finally {
      setPendingActivityActionKey(null);
    }
  }, [
    activityDraft,
    activityReviewActions,
    liveActivityDraftEnabled,
    navigateHeartCard,
  ]);

  const handleSaveDraftActivity = useCallback(async () => {
    const draftToSave = activityDraft;
    const activityToEdit = editingBaseMarker;
    const reviewActions = activityReviewActions;

    if (!draftToSave || !reviewActions) {
      return;
    }

    logHeartCardDebug('action.save-draft', {
      draft: {
        endMinuteOffset: draftToSave.endMinuteOffset,
        kind: draftToSave.kind,
        startMinuteOffset: draftToSave.startMinuteOffset,
      },
      editingMarker: summarizeHeartCardMarker(activityToEdit),
    });

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

    setPendingSavedMarkerFocusRequest(null);

    try {
      let nextFocusMarkerId: string;

      if (draftToSave.kind === 'Sleep') {
        if (activityToEdit?.kind === 'sleep') {
          if (!reviewActions.updateSleep) {
            throw new Error('Sleep editing is not available for this heart chart.');
          }

          await reviewActions.updateSleep(activityToEdit.id, start, end);
          nextFocusMarkerId = nextOptimisticFocusMarker.id;
        } else {
          if (!reviewActions.createManualSleep) {
            throw new Error('Sleep creation is not available for this heart chart.');
          }

          nextFocusMarkerId = await reviewActions.createManualSleep(start, end);
        }
      } else if (activityToEdit) {
        if (!reviewActions.updateActivity) {
          throw new Error('Activity editing is not available for this heart chart.');
        }

        await reviewActions.updateActivity(activityToEdit.id, draftToSave.kind, start, end);
        nextFocusMarkerId = nextOptimisticFocusMarker.id;
      } else {
        if (!reviewActions.createManualActivity) {
          throw new Error('Activity creation is not available for this heart chart.');
        }

        nextFocusMarkerId = await reviewActions.createManualActivity(draftToSave.kind, start, end);
      }

      const nextSavedMarkerFocusRequest = {
        marker: {
          ...nextOptimisticFocusMarker,
          id: nextFocusMarkerId,
        },
        markerId: nextFocusMarkerId,
      };

      logHeartCardDebug('action.save-draft-await-db-marker', {
        focusRequest: summarizeHeartCardFocusRequest(nextSavedMarkerFocusRequest),
      });
      setPendingSavedMarkerFocusRequest(nextSavedMarkerFocusRequest);
    } catch (error) {
      setPendingSavedMarkerFocusRequest(null);
      logHeartCardDebug('action.save-draft-error', {
        error: error instanceof Error ? error.message : String(error),
      });
      setActivityActionError(error instanceof Error ? error.message : 'Unable to save this activity right now.');
      setPendingActivityActionKey(null);
    }
  }, [
    activityDraft,
    activityReviewActions,
    basePointIntervalMinutes,
    cardData.series,
    editingBaseMarker,
    navigateHeartCard,
    viewportKey,
  ]);

  useEffect(() => {
    if (!readySavedMarkerFromDb || !pendingSavedMarkerFocusRequest) {
      return;
    }

    logHeartCardDebug('action.save-draft-db-marker-ready', {
      marker: summarizeHeartCardMarker(readySavedMarkerFromDb),
    });
    setPendingSavedMarkerFocusRequest(null);
    navigateHeartCard(
      { kind: 'overview' },
      {
        clearActionError: false,
        focusRequest: {
          marker: readySavedMarkerFromDb,
          markerId: readySavedMarkerFromDb.id,
        },
      },
    );
  }, [navigateHeartCard, pendingSavedMarkerFocusRequest, readySavedMarkerFromDb]);

  useEffect(() => {
    if (screen.kind !== 'draft' && isLiveStartTransitioning) {
      setIsLiveStartTransitioning(false);
    }
  }, [isLiveStartTransitioning, screen.kind]);

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
    navigationIdRef.current = 0;
    setScreen({ kind: 'overview' });
    setPendingNavigation(null);
    setNavigationPhase('idle');
    setNavigationReadyId(null);
    setChartFocusRequest(null);
    setChartFocusedMarker(null);
    setPresentedOverviewFocusedMarker(null);
    setPendingSavedMarkerFocusRequest(null);
    setPendingActivityActionKey(null);
    setActivityActionError(null);
    setIsLiveStartTransitioning(false);
    setRelabelModalVisible(false);
    cardHeaderTransitionProgress.value = 1;
    cardMetricsTransitionProgress.value = 1;
    cardChipsTransitionProgress.value = 1;
    sleepStageChipTransitionProgress.value = 0;
    activityDetailPanelMaxHeight.value = shouldShowIdleActivityPanelAfterReset ? ACTIVITY_DETAIL_IDLE_PANEL_MAX_HEIGHT : 0;
    activityDetailPanelOpacity.value = shouldShowIdleActivityPanelAfterReset ? 1 : 0;
    activityDetailPanelMarginTop.value = shouldShowIdleActivityPanelAfterReset ? 12 : 0;
    activityDetailTransitionProgress.value = shouldShowIdleActivityPanelAfterReset ? 1 : 0;
    clearTimerRef(sleepStagePanelUnmountTimeoutRef);
    clearTimerRef(activityDetailPanelUnmountTimeoutRef);
    clearTimerRef(navigationHideTimeoutRef);
    clearTimerRef(navigationRevealTimeoutRef);
    clearTimerRef(overviewFocusSwapTimeoutRef);
    setIsSleepStagePanelMounted(false);
    setIsActivityDetailPanelMounted(shouldShowIdleActivityPanelAfterReset);
    setActivityDetailMeasuredHeight(0);
    previousActivityDetailPanelVisibleRef.current = shouldShowIdleActivityPanelAfterReset;
    setIsOverviewFocusSwapping(false);
    setRenderedSleepStageChips([]);
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
    navigationHideTimeoutRef,
    navigationRevealTimeoutRef,
    overviewFocusSwapTimeoutRef,
    sleepStageChipTransitionProgress,
    viewportKey,
  ]);

  useEffect(() => {
    return () => {
      clearTimerRef(navigationHideTimeoutRef);
      clearTimerRef(navigationRevealTimeoutRef);
      clearTimerRef(overviewFocusSwapTimeoutRef);
    };
  }, []);

  useEffect(() => {
    setCardChromeVisibleAnimated(cardChromeVisible);
  }, [cardChromeVisible, setCardChromeVisibleAnimated]);

  useEffect(() => {
    setSelectedSleepStage(null);
  }, [displayedFocusedMarker?.id]);

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
    if (revealedSleepStagePanelVisible) {
      setRenderedSleepStageChips(sleepStageChips);
    }

    syncMountedVisibility({
      mounted: isSleepStagePanelMounted,
      onUnmount: () => {
        setRenderedSleepStageChips([]);
      },
      setMounted: setIsSleepStagePanelMounted,
      timerRef: sleepStagePanelUnmountTimeoutRef,
      unmountDelayMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
      visible: revealedSleepStagePanelVisible,
    });
  }, [isSleepStagePanelMounted, revealedSleepStagePanelVisible, sleepStageChipSignature]);

  useEffect(() => {
    syncMountedVisibility({
      mounted: isActivityDetailPanelMounted,
      setMounted: setIsActivityDetailPanelMounted,
      timerRef: activityDetailPanelUnmountTimeoutRef,
      unmountDelayMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
      visible: revealedActivityDetailPanelVisible,
    });
  }, [isActivityDetailPanelMounted, revealedActivityDetailPanelVisible]);

  useEffect(() => {
    const nextMaxHeight = revealedSleepStagePanelVisible ? SLEEP_STAGE_PANEL_MAX_HEIGHT : 0;
    const nextOpacity = revealedSleepStagePanelVisible ? 1 : 0;
    const nextMarginTop = revealedSleepStagePanelVisible ? 12 : 0;
    const panelDelay = revealedSleepStagePanelVisible ? SLEEP_STAGE_PANEL_STAGE_DELAY_MS : 0;

    animateSharedNumber(sleepStagePanelMaxHeight, nextMaxHeight, {
      delayMs: panelDelay,
      durationMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
    });
    animateSharedNumber(sleepStagePanelOpacity, nextOpacity, {
      delayMs: panelDelay,
      durationMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
    });
    animateSharedNumber(sleepStagePanelMarginTop, nextMarginTop, {
      delayMs: panelDelay,
      durationMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
    });
    animateStaggeredReveal([sleepStageChipTransitionProgress], revealedSleepStagePanelVisible ? 1 : 0, {
      enterDelayMs: SLEEP_STAGE_CHIP_STAGE_DELAY_MS,
      enterDurationMs: HEART_CARD_CHROME_IN_DURATION_MS,
      exitDurationMs: HEART_CARD_CHROME_OUT_DURATION_MS,
    });
  }, [
    revealedSleepStagePanelVisible,
    sleepStageChipTransitionProgress,
    sleepStagePanelMaxHeight,
    sleepStagePanelMarginTop,
    sleepStagePanelOpacity,
  ]);

  useEffect(() => {
    const wasVisible = previousActivityDetailPanelVisibleRef.current;
    previousActivityDetailPanelVisibleRef.current = revealedActivityDetailPanelVisible;

    const nextMaxHeight = revealedActivityDetailPanelVisible ? activityDetailPanelTargetMaxHeight : 0;
    const nextOpacity = revealedActivityDetailPanelVisible ? 1 : 0;
    const nextMarginTop = revealedActivityDetailPanelVisible ? 12 : 0;
    const panelDelay = revealedActivityDetailPanelVisible && !wasVisible ? ACTIVITY_DETAIL_PANEL_STAGE_DELAY_MS : 0;
    const contentDelay = revealedActivityDetailPanelVisible && !wasVisible ? ACTIVITY_DETAIL_CHIP_STAGE_DELAY_MS : 0;

    animateSharedNumber(activityDetailPanelMaxHeight, nextMaxHeight, {
      delayMs: panelDelay,
      durationMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
    });
    animateSharedNumber(activityDetailPanelOpacity, nextOpacity, {
      delayMs: panelDelay,
      durationMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
    });
    animateSharedNumber(activityDetailPanelMarginTop, nextMarginTop, {
      delayMs: panelDelay,
      durationMs: SLEEP_STAGE_PANEL_ANIMATION_DURATION_MS,
    });
    animateStaggeredReveal([activityDetailTransitionProgress], revealedActivityDetailPanelVisible ? 1 : 0, {
      enterDelayMs: contentDelay,
      enterDurationMs: HEART_CARD_CHROME_IN_DURATION_MS,
      exitDurationMs: HEART_CARD_CHROME_OUT_DURATION_MS,
    });
  }, [
    activityDetailPanelMarginTop,
    activityDetailPanelMaxHeight,
    activityDetailPanelOpacity,
    activityDetailPanelTargetMaxHeight,
    revealedActivityDetailPanelVisible,
    activityDetailTransitionProgress,
  ]);

  useEffect(
    () => () => {
      clearTimerRef(sleepStagePanelUnmountTimeoutRef);
      clearTimerRef(activityDetailPanelUnmountTimeoutRef);
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

  const requestedChartFocusMarker = chartFocusRequest?.marker ?? null;
  const pendingDraftPreview = pendingNavigation?.screen.kind === 'draft' ? pendingNavigation.screen.draft : null;
  const pendingDraftPreviewMarkerId = pendingNavigation?.screen.kind === 'draft'
    ? pendingNavigation.screen.editingMarkerId
    : null;
  const chartHiddenMarkerId = hiddenEditingMarkerId ?? pendingDraftPreviewMarkerId;
  const chartResetKey = viewportKey ?? 'heart';
  const handleReturnFromFocus = useCallback(() => {
    logHeartCardDebug('action.return-from-focus', {
      chartFocusedMarker: summarizeHeartCardMarker(chartFocusedMarker),
      displayedFocusedMarker: summarizeHeartCardMarker(displayedFocusedMarker),
    });
    navigateHeartCard(
      { kind: 'overview' },
      {
        clearChartFocus: true,
        jumpToLatest: true,
        waitForChartOverview: true,
      },
    );
  }, [chartFocusedMarker, displayedFocusedMarker, navigateHeartCard]);

  return (
    <GlassCard accentColor={cardAccentColor} accentTransitionDurationMs={cardAccentTransitionDurationMs}>
      <Animated.View style={animatedCardHeaderStageStyle}>
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            {displayedFocusedCardContent ? (
              <Animated.View
                style={[
                  styles.cardIconWrap,
                  animatedFocusedCardIconWrapStyle,
                ]}>
                <Animated.View pointerEvents="none" style={[styles.focusedAccentIconLayer, animatedFocusedCardPreviousAccentOpacityStyle]}>
                  <Ionicons color={previousRenderedCardAccentColor} name={displayedFocusedCardContent.iconName} size={16} />
                </Animated.View>
                <Animated.View pointerEvents="none" style={[styles.focusedAccentIconLayer, animatedFocusedCardNextAccentOpacityStyle]}>
                  <Ionicons color={cardAccentColor} name={displayedFocusedCardContent.iconName} size={16} />
                </Animated.View>
              </Animated.View>
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
          {isDraftEditing ? (
            <Text style={styles.actionMeta}>Draft activity</Text>
          ) : displayedFocusedCardContent ? (
            <View style={styles.actionWrap}>
              <View style={styles.actionButtonRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleReturnFromFocus}
                  style={({ pressed }) => [pressed ? styles.actionPressed : null]}
                  testID={chartTestID ? `${chartTestID}-return-button` : undefined}>
                  <Animated.View style={[styles.focusedActionButton, animatedFocusedActionButtonStyle]}>
                    <View pointerEvents="none" style={styles.focusedActionIconWrap}>
                      <Animated.View style={[styles.focusedAccentIconLayer, animatedFocusedCardPreviousAccentOpacityStyle]}>
                        <Ionicons color={previousRenderedCardAccentColor} name="arrow-back-outline" size={12} />
                      </Animated.View>
                      <Animated.View style={[styles.focusedAccentIconLayer, animatedFocusedCardNextAccentOpacityStyle]}>
                        <Ionicons color={cardAccentColor} name="arrow-back-outline" size={12} />
                      </Animated.View>
                    </View>
                    <Animated.Text style={[styles.focusedActionText, animatedFocusedCardTextAccentStyle]}>Return</Animated.Text>
                  </Animated.View>
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
        overlayAccentColor={chartOverlayAccentColor}
        activityDraft={liveActivityDraftEnabled ? null : activityDraft}
        disableMarkerFocus={liveActivityDraftEnabled}
        draftPreview={liveActivityDraftEnabled ? null : pendingDraftPreview}
        hiddenMarkerId={chartHiddenMarkerId}
        anchorDayKey={viewportKey}
        axisTestID={chartTestID ? `${chartTestID}-axis` : undefined}
        canLoadMore={canLoadMore}
        chartTestID={chartTestID}
        height={chartHeight}
        highlightedSleepStage={isSleepFocused ? selectedSleepStage : null}
        isLoadingMore={isLoadingMore}
        markers={chartMarkers}
        onActivityDraftChange={liveActivityDraftEnabled ? undefined : handleActivityDraftChange}
        jumpToLatestSignal={latestJumpVersion}
        requestedFocusedMarker={liveActivityDraftEnabled ? null : requestedChartFocusMarker}
        requestedFocusedMarkerId={liveActivityDraftEnabled ? null : chartFocusRequest?.markerId ?? null}
        onFocusedMarkerChange={liveActivityDraftEnabled ? undefined : handleFocusedMarkerChange}
        onFocusTransitionStateChange={handleFocusTransitionStateChange}
        onLoadMore={onLoadMore}
        onPinchZoomStepChange={onPinchZoomStepChange}
        onViewportWindowChange={setChartViewportState}
        onViewingLatestWindowChange={setIsViewingLatestWindow}
        pinchZoomSteps={pinchZoomSteps}
        pointIntervalMinutes={chartSnapshot.pointIntervalMinutes ?? basePointIntervalMinutes}
        points={chartSnapshot.series}
        resetKey={chartResetKey}
        windowPointCount={displayedWindowPointCount}
      />
      <Animated.View
        pointerEvents={revealedSleepStagePanelVisible ? 'auto' : 'none'}
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
        pointerEvents={revealedActivityDetailPanelVisible ? 'auto' : 'none'}
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
              {isDraftEditing && activityDraft && !isAwaitingChartFocus ? (
                <View>
                  <View style={styles.draftTypeChipRow}>
                    {draftTypeOptions.map((option) => {
                      const accentColor = option === 'Sleep' ? colors.indigo : option === 'Nap' ? colors.aqua : colors.heart;
                      const selected = activityDraft.kind === option;

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
              {isDraftEditing && !isAwaitingChartFocus ? (
                <View>
                  <View style={styles.reviewActionRow}>
                    <ReviewActionButton
                      accentColor={colors.muted}
                      disabled={!isDraftEditing || pendingActivityActionKey !== null}
                      label="Cancel"
                      onPress={handleCancelDraftActivity}
                      testID={chartTestID ? `${chartTestID}-draft-cancel` : undefined}
                    />
                    {!liveActivityDraftEnabled ? (
                      <ReviewActionButton
                        accentColor={colors.success}
                        disabled={!isDraftEditing || pendingActivityActionKey !== null}
                        label={pendingActivityActionKey === 'draft:save' ? 'Saving...' : 'Save'}
                        onPress={() => {
                          void handleSaveDraftActivity();
                        }}
                        testID={chartTestID ? `${chartTestID}-draft-save` : undefined}
                      />
                    ) : null}
                    {liveActivityDraftEnabled && isManualActivityKind(activityDraft.kind) && activityDraft.kind !== 'Nap' ? (
                      <ReviewActionButton
                        accentColor={colors.heart}
                        disabled={!isDraftEditing || pendingActivityActionKey !== null || Boolean(activeActivity)}
                        label={pendingActivityActionKey === 'draft:start-live' ? 'Starting...' : 'Start'}
                        onPress={() => {
                          void handleStartActiveDraftActivity();
                        }}
                        testID={chartTestID ? `${chartTestID}-draft-start-live` : undefined}
                      />
                    ) : null}
                    {canToggleDraftLiveActivity ? (
                      <View style={styles.draftLiveActivityToggleRow}>
                        <View style={styles.draftLiveActivityToggleText}>
                          <Text style={styles.draftLiveActivityToggleLabel}>Live</Text>
                        </View>
                        <Switch
                          disabled={pendingActivityActionKey !== null}
                          ios_backgroundColor={colors.surfaceStrong}
                          onValueChange={handleDraftLiveActivityToggle}
                          thumbColor={liveActivityDraftEnabled ? colors.heart : colors.subtle}
                          trackColor={{ false: colors.borderStrong, true: `${colors.heart}55` }}
                          value={liveActivityDraftEnabled}
                        />
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : canManageFocusedActivity ? (
                <View style={styles.reviewActionRow}>
                  <ReviewActionButton
                    accentColor={colors.success}
                    disabled={pendingActivityActionKey !== null}
                    label={pendingActivityActionKey === `confirm:${actionableFocusedMarker?.id}` ? 'Saving...' : 'Confirm'}
                    onPress={() => {
                      void handleConfirmFocusedActivity();
                    }}
                    testID={chartTestID ? `${chartTestID}-activity-confirm` : undefined}
                  />
                  {canEditManagedActivity ? (
                    <ReviewActionButton
                      accentColor={colors.heart}
                      disabled={pendingActivityActionKey !== null}
                      label="Edit"
                      onPress={handleEditFocusedActivity}
                      testID={chartTestID ? `${chartTestID}-activity-edit` : undefined}
                    />
                  ) : null}
                  <ReviewActionButton
                    accentColor={colors.alert}
                    disabled={pendingActivityActionKey !== null}
                    label={pendingActivityActionKey === `dismiss:${actionableFocusedMarker?.id}` ? 'Saving...' : 'Dismiss'}
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
              ) : canEditFocusedActivity || canRemoveFocusedActivity ? (
                <View style={styles.reviewActionRow}>
                  {canEditFocusedActivity ? (
                    <ReviewActionButton
                      accentColor={colors.heart}
                      disabled={pendingActivityActionKey !== null}
                      label="Edit"
                      onPress={handleEditFocusedActivity}
                      testID={chartTestID ? `${chartTestID}-activity-edit` : undefined}
                    />
                  ) : null}
                  {canRemoveFocusedActivity ? (
                    <ReviewActionButton
                      accentColor={colors.alert}
                      disabled={pendingActivityActionKey !== null}
                      label={pendingActivityActionKey === `dismiss:${actionableFocusedMarker?.id}` ? 'Removing...' : 'Remove'}
                      onPress={() => {
                        void handleDismissFocusedActivity();
                      }}
                      testID={chartTestID ? `${chartTestID}-activity-remove` : undefined}
                    />
                  ) : null}
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
                const selected = actionableFocusedMarker?.label === option;

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
  const [inspectedStage, setInspectedStage] = useState<SleepStage | null>(null);
  const [pinnedStage, setPinnedStage] = useState<SleepStage | null>(null);
  const stageBreakdown = useMemo(() => {
    const totals = cardData.stages.reduce<Record<SleepStage, number>>(
      (accumulator, segment) => {
        accumulator[segment.stage] += segment.minutes;
        return accumulator;
      },
      {
        awake: 0,
        deep: 0,
        light: 0,
        rem: 0,
      },
    );

    return SLEEP_STAGE_BREAKDOWN_ORDER
      .filter((stage) => totals[stage] > 0)
      .map((stage) => ({
        accentColor: sleepStageColors[stage],
        label: formatSleepStageBreakdownLabel(stage),
        stage,
        value: formatCompactDuration(totals[stage]),
      }));
  }, [cardData.stages]);
  const activeStage = inspectedStage ?? pinnedStage;

  useEffect(() => {
    setInspectedStage(null);
    setPinnedStage(null);
  }, [cardData.endLabel, cardData.startLabel, cardData.stages]);

  const handleSleepStageSelectionChange = useCallback((selection: SleepStageSelection | null) => {
    setInspectedStage(selection?.segment.stage ?? null);
  }, []);

  const handleSleepStageChipPress = useCallback((stage: SleepStage) => {
    setPinnedStage((currentStage) => (currentStage === stage ? null : stage));
  }, []);

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
            {cardData.isInProgress
              ? `${cardData.startLabel} - synced through ${cardData.endLabel}`
              : `${cardData.startLabel} to ${cardData.endLabel}`}
          </Text>
        </View>
      </View>

      <SleepStageChart
        accentColor={colors.violet}
        endLabel={cardData.isInProgress ? `Synced ${cardData.endLabel}` : cardData.endLabel}
        highlightedStage={pinnedStage}
        middleLabel={cardData.middleLabel}
        onSelectionChange={handleSleepStageSelectionChange}
        segments={cardData.stages}
        startAt={cardData.startAt}
        startLabel={cardData.startLabel}
        testID={chartTestID}
      />

      {stageBreakdown.length > 0 ? (
        <View style={styles.sleepStageBreakdownRow}>
          {stageBreakdown.map((stage) => (
            <SleepStageBreakdownChip
              accentColor={stage.accentColor}
              key={stage.stage}
              label={stage.label}
              onPress={() => {
                handleSleepStageChipPress(stage.stage);
              }}
              selected={activeStage === stage.stage}
              value={stage.value}
            />
          ))}
        </View>
      ) : null}
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
          <Ionicons color={colors.aqua} name={getManualActivityIconName('Activity')} size={20} />
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
                {activity.isInProgress
                  ? `${activity.timeLabel} · ${activity.durationMinutes} min · In progress`
                  : `${activity.timeLabel} · ${activity.durationMinutes} min`}
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
  focusedAccentIconLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  focusedActionIconWrap: {
    height: 12,
    position: 'relative',
    width: 12,
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
  draftLiveActivityToggleRow: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginLeft: 'auto',
    minHeight: 36,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 4,
  },
  draftLiveActivityToggleText: {
    minWidth: 0,
  },
  draftLiveActivityToggleLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
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
  sleepStageBreakdownRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
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
