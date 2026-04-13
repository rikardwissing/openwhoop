import { Ionicons } from '@expo/vector-icons';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
} from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, {
  ClipPath,
  Defs,
  G,
  LinearGradient as SvgLinearGradient,
  Line,
  Mask,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import {
  TREND_VIEWBOX_BASELINE,
  TREND_VIEWBOX_PLOT_BOTTOM,
  TREND_VIEWBOX_TOP,
  buildTrendDomain,
  buildTrendLineGeometry,
  mapTrendValueToY,
} from '@/components/charts/chartSelection';
import { ChartSelectionBubble } from '@/components/charts/ChartSelectionBubble';
import { ChartScrubOverlay } from '@/components/charts/ChartScrubOverlay';
import type { ManualActivityKind } from '@/data/HealthRepository';
import { useAcquireScreenScrollLock } from '@/components/layout/ScreenScrollContext';
import { colors, sleepStageColors, typography } from '@/constants/theme';
import type { HeartIntradayMarker, SleepStage, TrendPoint } from '@/types/health';
import { addMinutes, formatShortDate } from '@/utils/dateTime';
import { formatMetricNumber } from '@/utils/formatters';
import { getHeartIntradayMarkerPresentation, mapHeartIntradayMarkersToTrendMarkers } from '@/utils/heartChartMarkers';
import { logMobilePerfEvent, type PerformanceLogValue } from '@/utils/mobilePerf';

const DEFAULT_HEART_POINT_INTERVAL_MINUTES = 5;
const LOAD_MORE_EDGE_THRESHOLD_POINTS = 2;
const LOAD_MORE_TRIGGER_DRAG_PX = 18;
const SNAP_DURATION_MS = 110;
const FOCUS_ZOOM_DURATION_MS = 220;
const Y_AXIS_LAG_DURATION_MS = 180;
const HEART_CHART_VIEWBOX_HEIGHT = 40;
const MARKER_BADGE_SIZE = 24;
const MIN_MARKER_BAND_WIDTH = 0.15;
const ACTIVITY_DRAFT_BAND_HEIGHT = 31;
const ACTIVITY_DRAFT_BAND_TOP = 3;
const ACTIVITY_DRAFT_HANDLE_WIDTH = 18;
const ACTIVITY_DRAFT_BODY_MIN_WIDTH = 72;
const MIN_ACTIVITY_DRAFT_MINUTE_SPAN = 1;
const HEART_FILL_BASELINE = ACTIVITY_DRAFT_BAND_TOP + ACTIVITY_DRAFT_BAND_HEIGHT;
const AnimatedSvgGroup = Animated.createAnimatedComponent(G) as ComponentType<
  ComponentProps<typeof G> & { animatedProps?: object }
>;

export type HeartMarkerDraftKind = ManualActivityKind | 'Sleep';

export interface HeartActivityDraft {
  kind: HeartMarkerDraftKind;
  startMinuteOffset: number;
  endMinuteOffset: number;
}

interface HeartViewportWindowState {
  windowPointCount: number;
  windowStart: number;
}

function clamp(value: number, min: number, max: number) {
  'worklet';
  return Math.min(max, Math.max(min, value));
}

function clampFraction(value: number) {
  return Math.min(1, Math.max(0, value));
}

function sanitizeMarkerId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function colorStops(accent: string) {
  switch (accent) {
    case colors.alert:
      return [colors.alert, '#ffb15d'];
    case colors.heart:
      return [colors.heart, '#ffe39c'];
    case colors.violet:
      return [colors.violet, colors.cyan];
    case colors.indigo:
      return [colors.indigo, '#9aaeff'];
    case colors.aqua:
      return [colors.aqua, colors.cyan];
    case colors.cyan:
      return [colors.cyan, colors.primary];
    default:
      return [colors.cyan, colors.primary];
  }
}

function chartShadowColor(accent: string) {
  switch (accent) {
    case colors.alert:
      return 'rgba(255, 125, 112, 0.14)';
    case colors.heart:
      return 'rgba(255, 210, 107, 0.14)';
    case colors.violet:
      return 'rgba(200, 255, 99, 0.14)';
    case colors.indigo:
      return 'rgba(93, 120, 255, 0.16)';
    case colors.aqua:
      return 'rgba(86, 255, 209, 0.14)';
    case colors.cyan:
      return 'rgba(86, 246, 255, 0.12)';
    default:
      return 'rgba(86, 246, 255, 0.12)';
  }
}

function buildLine(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function buildHeartCoordinates(
  points: TrendPoint[],
  domain: ReturnType<typeof buildTrendDomain>,
  pointSpacing: number,
) {
  return points.map((point, index) => ({
    x: index * pointSpacing,
    y: point.value === null || !domain ? null : mapTrendValueToY(point.value, domain),
  }));
}

function formatHeartSelectionValue(value: number | null) {
  if (value === null) {
    return 'No data';
  }

  return formatMetricNumber(value, 'BPM');
}

function isZoomableHeartMarkerKind(kind: HeartIntradayMarker['kind']) {
  return kind === 'sleep' || kind === 'nap' || kind === 'activity';
}

export function getHeartViewportPointSpacing(viewportWidth: number, windowPointCount: number) {
  if (viewportWidth <= 0) {
    return 0;
  }

  return windowPointCount <= 1 ? viewportWidth : viewportWidth / Math.max(windowPointCount - 1, 1);
}

export function getHeartViewportContentWidth(
  viewportWidth: number,
  pointCount: number,
  windowPointCount: number,
) {
  if (viewportWidth <= 0) {
    return 0;
  }

  if (pointCount <= 1 || windowPointCount <= 1) {
    return viewportWidth;
  }

  return viewportWidth * (pointCount - 1) / Math.max(windowPointCount - 1, 1);
}

export function getHeartViewBoxWidth(windowPointCount: number) {
  'worklet';
  return Math.max(windowPointCount - 1, 1);
}

export function getHeartViewportZoomScale(baseWindowPointCount: number, windowPointCount: number) {
  const baseViewBoxWidth = getHeartViewBoxWidth(baseWindowPointCount);
  const visibleViewBoxWidth = getHeartViewBoxWidth(windowPointCount);

  if (baseViewBoxWidth <= 0 || visibleViewBoxWidth <= 0) {
    return 1;
  }

  return baseViewBoxWidth / visibleViewBoxWidth;
}

function parseHeartAxisLabelMinutes(label: string) {
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

  const normalizedHours = rawHours % 12 + (meridiem === 'PM' ? 12 : 0);
  return normalizedHours * 60 + minutes + seconds / 60;
}

export function buildHeartViewportDayLabel(
  points: readonly TrendPoint[],
  windowPointCount: number,
  anchorDayKey?: string,
  windowStart?: number,
  pointIntervalMinutes = DEFAULT_HEART_POINT_INTERVAL_MINUTES,
) {
  if (!anchorDayKey || points.length === 0) {
    return null;
  }

  const latestLabel = points.at(-1)?.label;
  if (!latestLabel) {
    return null;
  }

  const latestPointMinutes = parseHeartAxisLabelMinutes(latestLabel);
  if (latestPointMinutes === null) {
    return null;
  }

  const safeWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const safeWindowStart = clamp(windowStart ?? maxWindowStart, 0, maxWindowStart);
  const midpointIndex = safeWindowStart + Math.floor((safeWindowPointCount - 1) / 2);
  const pointsFromNewest = Math.max(0, points.length - 1 - midpointIndex);
  const anchorDate = new Date(`${anchorDayKey}T00:00:00`);
  const latestPointDate = addMinutes(anchorDate, latestPointMinutes);
  const viewportMidpointDate = addMinutes(latestPointDate, -pointsFromNewest * pointIntervalMinutes);

  return formatShortDate(viewportMidpointDate);
}

export function buildHeartViewportLabel(
  points: readonly TrendPoint[],
  windowPointCount: number,
  windowStart?: number,
  fallbackLabel = '',
) {
  if (points.length === 0) {
    return fallbackLabel;
  }

  const safeWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const safeWindowStart = clamp(windowStart ?? maxWindowStart, 0, maxWindowStart);
  const visiblePoints = points.slice(safeWindowStart, safeWindowStart + safeWindowPointCount);
  const startLabel = visiblePoints[0]?.label;
  const endLabel = visiblePoints.at(-1)?.label;

  if (!startLabel && !endLabel) {
    return fallbackLabel;
  }

  if (!endLabel || startLabel === endLabel) {
    return startLabel ?? endLabel ?? fallbackLabel;
  }

  return `${startLabel} - ${endLabel}`;
}

export function buildHeartAxisLabels(
  points: readonly TrendPoint[],
  windowPointCount: number,
  anchorDayKey?: string,
  windowStart?: number,
  pointIntervalMinutes = DEFAULT_HEART_POINT_INTERVAL_MINUTES,
): [string | undefined, string | undefined, string | undefined] {
  if (points.length === 0) {
    return [undefined, undefined, undefined];
  }

  const safeWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const safeWindowStart = clamp(windowStart ?? maxWindowStart, 0, maxWindowStart);
  const visiblePoints = points.slice(safeWindowStart, safeWindowStart + safeWindowPointCount);
  const firstLabel = visiblePoints[0]?.label;
  const viewportDayLabel = buildHeartViewportDayLabel(
    points,
    safeWindowPointCount,
    anchorDayKey,
    safeWindowStart,
    pointIntervalMinutes,
  );
  const leadingLabel =
    safeWindowStart < maxWindowStart && viewportDayLabel
      ? firstLabel
        ? `${viewportDayLabel} · ${firstLabel}`
        : viewportDayLabel
      : firstLabel;

  return [
    leadingLabel,
    visiblePoints[Math.floor(visiblePoints.length / 2)]?.label,
    visiblePoints.at(-1)?.label,
  ];
}

export function buildVisibleHeartDomain(
  points: readonly TrendPoint[],
  windowPointCount: number,
  windowStart?: number,
) {
  if (points.length === 0) {
    return null;
  }

  const safeWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const safeWindowStart = clamp(windowStart ?? maxWindowStart, 0, maxWindowStart);
  const visiblePoints = points.slice(safeWindowStart, safeWindowStart + safeWindowPointCount);

  return buildTrendDomain(visiblePoints, { mode: 'line' });
}

export function buildHeartMarkerDomain(
  points: readonly TrendPoint[],
  marker: Pick<HeartIntradayMarker, 'startFraction' | 'endFraction'> | null | undefined,
) {
  if (!marker || points.length === 0) {
    return null;
  }

  const lastIndex = points.length - 1;
  const clampedStartFraction = clampFraction(marker.startFraction);
  const clampedEndFraction = clampFraction(Math.max(marker.startFraction, marker.endFraction));
  const startIndex = clamp(Math.floor(clampedStartFraction * lastIndex), 0, lastIndex);
  const endIndex = clamp(Math.ceil(clampedEndFraction * lastIndex), startIndex, lastIndex);
  const visiblePoints = points.slice(startIndex, endIndex + 1);

  return buildTrendDomain(visiblePoints, { mode: 'line' });
}

export function buildHeartWindowDomains(
  points: readonly TrendPoint[],
  windowPointCount: number,
) {
  if (points.length === 0) {
    return null;
  }

  const safeWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const fallbackDomain = buildTrendDomain(points as TrendPoint[], { mode: 'line' });
  const mins: number[] = [];
  const maxs: number[] = [];
  let lastDomain = fallbackDomain;

  for (let start = 0; start <= maxWindowStart; start += 1) {
    const domain = buildVisibleHeartDomain(points, safeWindowPointCount, start) ?? lastDomain;

    if (!domain) {
      continue;
    }

    mins.push(domain.min);
    maxs.push(domain.max);
    lastDomain = domain;
  }

  return mins.length > 0 ? { mins, maxs } : null;
}

export function buildFocusedHeartMarkerWindow(
  marker: Pick<HeartIntradayMarker, 'startFraction' | 'endFraction'>,
  pointCount: number,
  _baseWindowPointCount: number,
) {
  if (pointCount <= 1) {
    return null;
  }

  const clampedStartFraction = clampFraction(marker.startFraction);
  const clampedEndFraction = clampFraction(Math.max(marker.startFraction, marker.endFraction));
  const lastIndex = pointCount - 1;
  const startIndex = clamp(Math.floor(clampedStartFraction * lastIndex), 0, lastIndex);
  const endIndex = clamp(Math.ceil(clampedEndFraction * lastIndex), startIndex, lastIndex);
  const durationPointCount = Math.max(endIndex - startIndex + 1, 2);
  const windowPointCount = clamp(durationPointCount, 2, pointCount);
  const maxWindowStart = Math.max(0, pointCount - windowPointCount);
  const windowStart = clamp(startIndex, 0, maxWindowStart);

  return {
    endIndex,
    startIndex,
    windowPointCount,
    windowStart,
  };
}

function mapHeartValueToYInDomain(value: number, domain: NonNullable<ReturnType<typeof buildTrendDomain>>) {
  'worklet';
  const span = Math.max(domain.max - domain.min, 0.0001);

  return TREND_VIEWBOX_TOP + ((domain.max - value) / span) * (TREND_VIEWBOX_PLOT_BOTTOM - TREND_VIEWBOX_TOP);
}
export function interpolateHeartDomain(
  windowStart: number,
  mins: readonly number[],
  maxs: readonly number[],
) {
  'worklet';

  if (mins.length === 0 || maxs.length === 0) {
    return null;
  }

  const lastIndex = Math.min(mins.length, maxs.length) - 1;
  const clampedWindowStart = clamp(windowStart, 0, lastIndex);
  const lowerIndex = Math.floor(clampedWindowStart);
  const upperIndex = Math.min(lowerIndex + 1, lastIndex);
  const progress = clampedWindowStart - lowerIndex;
  const min = mins[lowerIndex] + (mins[upperIndex] - mins[lowerIndex]) * progress;
  const max = maxs[lowerIndex] + (maxs[upperIndex] - maxs[lowerIndex]) * progress;

  return { min, max };
}

export function buildHeartDomainAnimation(
  previousDomain: ReturnType<typeof buildTrendDomain>,
  nextDomain: ReturnType<typeof buildTrendDomain>,
) {
  'worklet';

  if (!previousDomain || !nextDomain) {
    return { scaleY: 1, translateY: 0 };
  }

  const previousSpan = Math.max(previousDomain.max - previousDomain.min, 0.0001);
  const nextSpan = Math.max(nextDomain.max - nextDomain.min, 0.0001);
  const scaleY = previousSpan / nextSpan;
  const translateY =
    TREND_VIEWBOX_TOP * (1 - scaleY) +
    ((nextDomain.max - previousDomain.max) / nextSpan) * (TREND_VIEWBOX_PLOT_BOTTOM - TREND_VIEWBOX_TOP);

  if (Math.abs(scaleY - 1) < 0.0001 && Math.abs(translateY) < 0.0001) {
    return { scaleY: 1, translateY: 0 };
  }

  return {
    scaleY,
    translateY,
  };
}

export function buildHeartChartViewBox(windowStart: number, windowPointCount: number) {
  'worklet';
  return `${windowStart} 0 ${getHeartViewBoxWidth(windowPointCount)} ${HEART_CHART_VIEWBOX_HEIGHT}`;
}

export function getVisibleHeartWindowStart(maxWindowShift: number, pointsFromNewest: number) {
  'worklet';
  return clamp(maxWindowShift - Math.round(pointsFromNewest), 0, maxWindowShift);
}

export function getRetainedPointsFromNewestAfterGrowth(
  pointsFromNewest: number,
  _prependedPointCount: number,
  maxWindowShift: number,
) {
  return clamp(pointsFromNewest, 0, maxWindowShift);
}

export function getRetainedHeartWindowStartAfterGrowth(
  windowStart: number,
  prependedPointCount: number,
  maxWindowShift: number,
) {
  return clamp(windowStart + prependedPointCount, 0, maxWindowShift);
}

export function shouldTriggerHeartLoadMore(params: {
  canLoadMore: boolean;
  isLoadingMore: boolean;
  windowStart: number;
  translationX: number;
}) {
  'worklet';
  const { canLoadMore, isLoadingMore, windowStart, translationX } = params;

  return (
    canLoadMore &&
    !isLoadingMore &&
    windowStart <= LOAD_MORE_EDGE_THRESHOLD_POINTS &&
    translationX > LOAD_MORE_TRIGGER_DRAG_PX
  );
}

interface HeartMarkerVisual {
  accessibilityLabel?: string;
  accentColor: string;
  backgroundColor: string;
  badgeOpacity: number;
  bandWidth: number;
  centerX: number;
  endFraction: number;
  isZoomable: boolean;
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  id: string;
  kind: HeartIntradayMarker['kind'];
  label: string;
  startFraction: number;
  startX: number;
  testID?: string;
  timeLabel: string;
}

interface HeartSleepStageHighlight {
  stage: SleepStage;
  startX: number;
  width: number;
  testID?: string;
}

const EMPTY_HEART_SLEEP_STAGE_HIGHLIGHTS: HeartSleepStageHighlight[] = [];

function formatRenderTraceValue(value: PerformanceLogValue | undefined) {
  return value ?? 'null';
}

function useRenderTrace(label: string, details: Record<string, PerformanceLogValue>) {
  const renderCountRef = useRef(0);
  const previousDetailsRef = useRef<Record<string, PerformanceLogValue> | null>(null);

  useEffect(() => {
    renderCountRef.current += 1;
    const previousDetails = previousDetailsRef.current;
    const changes = previousDetails
      ? Object.entries(details)
          .filter(([key, value]) => previousDetails[key] !== value)
          .map(([key, value]) => `${key}:${formatRenderTraceValue(previousDetails[key])}->${formatRenderTraceValue(value)}`)
          .join('|')
      : Object.entries(details)
          .map(([key, value]) => `${key}:${formatRenderTraceValue(value)}`)
          .join('|');

    logMobilePerfEvent(`${label}.render`, {
      changes: changes || 'none',
      render: renderCountRef.current,
    });

    previousDetailsRef.current = details;
  });
}

interface HeartSleepStageSpan {
  endRatio: number;
  stage: SleepStage;
  startRatio: number;
}

interface HeartSleepStageSelectionRange {
  endIndex: number;
  startIndex: number;
}

function buildHeartSleepStageSpans(
  marker: HeartIntradayMarker | null,
  stage: SleepStage | null | undefined,
): HeartSleepStageSpan[] {
  if (!marker || marker.kind !== 'sleep' || !stage || !marker.details?.stages || marker.details.stages.length === 0) {
    return [];
  }

  const totalStageMinutes = marker.details.stages.reduce((sum, segment) => sum + segment.minutes, 0);
  if (totalStageMinutes <= 0) {
    return [];
  }

  const spans: HeartSleepStageSpan[] = [];
  let cursorRatio = 0;

  for (const [index, segment] of marker.details.stages.entries()) {
    const segmentRatio =
      index === marker.details.stages.length - 1 ? 1 - cursorRatio : segment.minutes / totalStageMinutes;
    const startRatio = cursorRatio;
    const endRatio = clampFraction(cursorRatio + segmentRatio);

    if (segment.stage === stage && endRatio > startRatio) {
      spans.push({
        endRatio,
        stage,
        startRatio,
      });
    }

    cursorRatio = endRatio;
  }

  return spans;
}

export function buildHeartSleepStageSelectionRanges(
  pointCount: number,
  marker: HeartIntradayMarker | null,
  stage: SleepStage | null | undefined,
): HeartSleepStageSelectionRange[] {
  if (pointCount <= 0) {
    return [];
  }

  const spans = buildHeartSleepStageSpans(marker, stage);
  if (spans.length === 0) {
    return [];
  }

  const lastIndex = pointCount - 1;
  const sessionStartIndex = clamp(Math.floor(clampFraction(marker!.startFraction) * lastIndex), 0, lastIndex);
  const sessionEndIndex = clamp(
    Math.ceil(clampFraction(Math.max(marker!.startFraction, marker!.endFraction)) * lastIndex),
    sessionStartIndex,
    lastIndex,
  );
  const sessionSpan = Math.max(sessionEndIndex - sessionStartIndex, 1);

  return spans.map((span) => ({
    endIndex: clamp(sessionStartIndex + Math.ceil(span.endRatio * sessionSpan), sessionStartIndex, sessionEndIndex),
    startIndex: clamp(sessionStartIndex + Math.floor(span.startRatio * sessionSpan), sessionStartIndex, sessionEndIndex),
  }));
}

function buildHeartSleepStageHighlights(
  marker: HeartIntradayMarker | null,
  stage: SleepStage | null | undefined,
  fullSeriesSpan: number,
  testIDPrefix?: string,
): HeartSleepStageHighlight[] {
  const spans = buildHeartSleepStageSpans(marker, stage);
  if (!marker || spans.length === 0) {
    return [];
  }

  const sessionStartX = clampFraction(marker.startFraction) * fullSeriesSpan;
  const sessionEndX = clampFraction(Math.max(marker.startFraction, marker.endFraction)) * fullSeriesSpan;
  const sessionWidth = Math.max(sessionEndX - sessionStartX, MIN_MARKER_BAND_WIDTH);

  return spans.map((span, index) => ({
    stage: span.stage,
    startX: sessionStartX + span.startRatio * sessionWidth,
    testID: testIDPrefix ? `${testIDPrefix}-stage-highlight-${stage}-${index}` : undefined,
    width: Math.max((span.endRatio - span.startRatio) * sessionWidth, 1),
  }));
}

function HeartMarkerBadge({
  marker,
  onPress,
  zoomScale,
}: {
  marker: HeartMarkerVisual;
  onPress?: () => void;
  zoomScale: SharedValue<number>;
}) {
  const animatedBadgeScaleStyle = useAnimatedStyle(
    () => ({
      transform: [{ scaleX: 1 / Math.max(zoomScale.value, 0.0001) }],
    }),
    [zoomScale],
  );

  const badgeWrapStyle = [
    styles.markerBadgeWrap,
    {
      left: marker.centerX - MARKER_BADGE_SIZE / 2,
      top: 8,
    },
    animatedBadgeScaleStyle,
  ];

  const badgeStyle = [
    styles.markerBadge,
    {
      backgroundColor: colors.surfaceStrong,
      borderColor: marker.accentColor,
      opacity: marker.badgeOpacity,
    },
  ];

  if (onPress) {
    return (
      <Animated.View pointerEvents="box-none" style={badgeWrapStyle}>
        <Pressable
          accessibilityLabel={marker.accessibilityLabel ? `Focus ${marker.accessibilityLabel}` : `Focus ${marker.label} ${marker.timeLabel}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onPress}
          style={({ pressed }) => [
            badgeStyle,
            pressed ? { opacity: marker.badgeOpacity * 0.82 } : null,
          ]}
          testID={marker.testID}>
          <Ionicons color={marker.accentColor} name={marker.iconName} size={12} />
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Animated.View pointerEvents="box-none" style={badgeWrapStyle}>
      <View
        accessibilityLabel={marker.accessibilityLabel}
        style={badgeStyle}
        testID={marker.testID}>
        <Ionicons color={marker.accentColor} name={marker.iconName} size={12} />
      </View>
    </Animated.View>
  );
}

const HeartChartSvgPlot = memo(function HeartChartSvgPlot({
  activeSleepStageColor,
  areas,
  bridgePaths,
  chartContentWidth,
  chartEndX,
  chartId,
  chartPointSpacingValue,
  chartTestID,
  gradientEnd,
  gradientStart,
  guideLineY,
  paths,
  shadowColor,
  sleepStageHighlightClipId,
  sleepStageHighlightFillId,
  sleepStageHighlights,
  viewportWidth,
  viewportZoomAnchorIndex,
  viewportZoomAnchorScreenX,
  viewportZoomScale,
}: {
  activeSleepStageColor: string | null;
  areas: string[];
  bridgePaths: string[];
  chartContentWidth: number;
  chartEndX: number;
  chartId: string;
  chartPointSpacingValue: SharedValue<number>;
  chartTestID?: string;
  gradientEnd: string;
  gradientStart: string;
  guideLineY: number;
  paths: string[];
  shadowColor: string;
  sleepStageHighlightClipId: string | null;
  sleepStageHighlightFillId: string | null;
  sleepStageHighlights: HeartSleepStageHighlight[];
  viewportWidth: number;
  viewportZoomAnchorIndex: SharedValue<number>;
  viewportZoomAnchorScreenX: SharedValue<number>;
  viewportZoomScale: SharedValue<number>;
}) {
  const chartPlotClipId = `${chartId}-plot-clip`;
  const plotPathSignature = `${paths.length}:${paths[0]?.length ?? 0}:${paths.at(-1)?.length ?? 0}`;
  const plotAreaSignature = `${areas.length}:${areas[0]?.length ?? 0}:${areas.at(-1)?.length ?? 0}`;
  const bridgeSignature = `${bridgePaths.length}:${bridgePaths[0]?.length ?? 0}:${bridgePaths.at(-1)?.length ?? 0}`;
  const sleepHighlightSignature =
    sleepStageHighlights.length > 0
      ? sleepStageHighlights
          .map((highlight) => `${highlight.stage}:${Math.round(highlight.startX * 10)}:${Math.round(highlight.width * 10)}`)
          .join(',')
      : 'none';

  useRenderTrace(`chart.heart.svgPlot.${chartTestID ?? 'default'}`, {
    activeSleepStageColor: activeSleepStageColor ?? 'none',
    areaSignature: plotAreaSignature,
    bridgeSignature,
    chartContentWidth: Math.round(chartContentWidth),
    chartEndX: Math.round(chartEndX),
    pathSignature: plotPathSignature,
    sleepHighlightSignature,
    viewportWidth: Math.round(viewportWidth),
  });

  const animatedChartCameraProps = useAnimatedProps(
    () => ({
      matrix: [
        viewportZoomScale.value,
        0,
        0,
        1,
        viewportZoomAnchorScreenX.value -
          viewportZoomScale.value * viewportZoomAnchorIndex.value * chartPointSpacingValue.value,
        0,
      ],
    }),
    [chartPointSpacingValue, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );

  return (
    <Animated.View pointerEvents="none" style={styles.chartCanvas}>
      <Svg
        height="100%"
        preserveAspectRatio="none"
        viewBox={`0 0 ${Math.max(viewportWidth, 1)} ${HEART_CHART_VIEWBOX_HEIGHT}`}
        width="100%">
        <Defs>
          <SvgLinearGradient id={`${chartId}-stroke`} x1="0%" x2="100%" y1="100%" y2="0%">
            <Stop offset="0%" stopColor={gradientStart} />
            <Stop offset="100%" stopColor={gradientEnd} />
          </SvgLinearGradient>
          <SvgLinearGradient id={`${chartId}-fill`} x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0%" stopColor={gradientEnd} stopOpacity="0.6" />
            <Stop offset="58%" stopColor={gradientStart} stopOpacity="0.2" />
            <Stop offset="100%" stopColor={gradientStart} stopOpacity="0" />
          </SvgLinearGradient>
          <SvgLinearGradient
            gradientUnits="userSpaceOnUse"
            id={`${chartId}-fill-mask-gradient`}
            x1="0"
            x2="0"
            y1={TREND_VIEWBOX_TOP}
            y2={TREND_VIEWBOX_BASELINE}>
            <Stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <Stop offset="72%" stopColor="#ffffff" stopOpacity="1" />
            <Stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </SvgLinearGradient>
          <Mask
            height={HEART_CHART_VIEWBOX_HEIGHT}
            id={`${chartId}-fill-mask`}
            maskContentUnits="userSpaceOnUse"
            maskUnits="userSpaceOnUse"
            width={chartContentWidth}
            x="0"
            y="0">
            <Rect fill="#000000" height={HEART_CHART_VIEWBOX_HEIGHT} width={chartContentWidth} x="0" y="0" />
            <Rect
              fill={`url(#${chartId}-fill-mask-gradient)`}
              height={TREND_VIEWBOX_BASELINE - TREND_VIEWBOX_TOP}
              width={chartContentWidth}
              x="0"
              y={TREND_VIEWBOX_TOP}
            />
          </Mask>
          <ClipPath id={chartPlotClipId}>
            <Rect height={HEART_CHART_VIEWBOX_HEIGHT} width={chartContentWidth} x="0" y="0" />
          </ClipPath>
          {sleepStageHighlights.length > 0 && sleepStageHighlightClipId && sleepStageHighlightFillId && activeSleepStageColor ? (
            <G>
              <ClipPath id={sleepStageHighlightClipId}>
                {sleepStageHighlights.map((highlight, index) => (
                  <Rect
                    height={HEART_CHART_VIEWBOX_HEIGHT}
                    key={`stage-highlight-clip-${highlight.stage}-${index}`}
                    width={highlight.width}
                    x={highlight.startX}
                    y="0"
                  />
                ))}
              </ClipPath>
              <SvgLinearGradient id={sleepStageHighlightFillId} x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop offset="0%" stopColor={activeSleepStageColor} stopOpacity="0.72" />
                <Stop offset="55%" stopColor={activeSleepStageColor} stopOpacity="0.26" />
                <Stop offset="100%" stopColor={activeSleepStageColor} stopOpacity="0" />
              </SvgLinearGradient>
            </G>
          ) : null}
        </Defs>
        <AnimatedSvgGroup animatedProps={animatedChartCameraProps}>
          <G clipPath={`url(#${chartPlotClipId})`}>
            {areas.map((area, index) => (
              <Path key={`area-${index}`} d={area} fill={`url(#${chartId}-fill)`} />
            ))}
          </G>
          <G clipPath={`url(#${chartPlotClipId})`}>
            <Line
              stroke="rgba(149, 162, 188, 0.22)"
              strokeDasharray="0.36 0.36"
              strokeWidth="0.7"
              vectorEffect="non-scaling-stroke"
              x1={0}
              x2={chartEndX}
              y1={guideLineY}
              y2={guideLineY}
            />
            {bridgePaths.map((path, index) => (
              <Path
                d={path}
                fill="none"
                key={`bridge-${index}`}
                stroke={colors.subtle}
                strokeDasharray="1.8 1.8"
                strokeLinecap="round"
                strokeOpacity="0.72"
                strokeWidth="0.68"
                testID={chartTestID ? `${chartTestID}-bridge-${index}` : undefined}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <G>
              {paths.map((path, index) => (
                <Path
                  key={`shadow-${index}`}
                  d={path}
                  fill="none"
                  stroke={shadowColor}
                  strokeWidth="1.6"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {paths.map((path, index) => (
                <Path
                  key={`line-${index}`}
                  d={path}
                  fill="none"
                  stroke={`url(#${chartId}-stroke)`}
                  strokeLinecap="round"
                  strokeWidth="0.8"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </G>
            {sleepStageHighlights.map((highlight, index) => (
              <Rect
                fill="transparent"
                height={HEART_CHART_VIEWBOX_HEIGHT}
                key={`stage-highlight-probe-${highlight.stage}-${index}`}
                testID={highlight.testID}
                width={highlight.width}
                x={highlight.startX}
                y="0"
              />
            ))}
            {sleepStageHighlights.length > 0 && sleepStageHighlightClipId && sleepStageHighlightFillId && activeSleepStageColor ? (
              <G clipPath={`url(#${sleepStageHighlightClipId})`}>
                <G mask={`url(#${chartId}-fill-mask)`}>
                  {areas.map((area, areaIndex) => (
                    <Path
                      key={`stage-area-${areaIndex}`}
                      d={area}
                      fill={`url(#${sleepStageHighlightFillId})`}
                    />
                  ))}
                </G>
                <G>
                  {paths.map((path, pathIndex) => (
                    <Path
                      key={`stage-shadow-${pathIndex}`}
                      d={path}
                      fill="none"
                      stroke={activeSleepStageColor}
                      strokeOpacity="0.22"
                      strokeWidth="2.4"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  {paths.map((path, pathIndex) => (
                    <Path
                      key={`stage-line-${pathIndex}`}
                      d={path}
                      fill="none"
                      stroke={activeSleepStageColor}
                      strokeLinecap="round"
                      strokeOpacity="0.96"
                      strokeWidth="1.3"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </G>
              </G>
            ) : null}
          </G>
        </AnimatedSvgGroup>
      </Svg>
    </Animated.View>
  );
});

export function PannableHeartChart({
  accentColor = colors.primary,
  activityDraft = null,
  anchorDayKey,
  axisTestID,
  canLoadMore = false,
  chartTestID,
  height = 150,
  highlightedSleepStage,
  isLoadingMore = false,
  jumpToLatestSignal,
  markers = [],
  onActivityDraftChange,
  onFocusedMarkerChange,
  onFocusTransitionStateChange,
  onPresetZoomTransitionStateChange,
  onLoadMore,
  onViewportWindowChange,
  onViewingLatestWindowChange,
  pointIntervalMinutes = DEFAULT_HEART_POINT_INTERVAL_MINUTES,
  points,
  requestedFocusedMarker = null,
  requestedFocusedMarkerId,
  resetKey,
  windowPointCount,
}: {
  accentColor?: string;
  activityDraft?: HeartActivityDraft | null;
  anchorDayKey?: string;
  axisTestID?: string;
  canLoadMore?: boolean;
  chartTestID?: string;
  height?: number;
  highlightedSleepStage?: SleepStage | null;
  isLoadingMore?: boolean;
  jumpToLatestSignal?: number;
  markers?: readonly HeartIntradayMarker[];
  onActivityDraftChange?: (draft: HeartActivityDraft) => void;
  onFocusedMarkerChange?: (marker: HeartIntradayMarker | null) => void;
  onFocusTransitionStateChange?: (isTransitioning: boolean) => void;
  onPresetZoomTransitionStateChange?: (isTransitioning: boolean) => void;
  onLoadMore?: () => void;
  onViewportWindowChange?: (window: HeartViewportWindowState) => void;
  onViewingLatestWindowChange?: (isViewingLatestWindow: boolean) => void;
  pointIntervalMinutes?: number;
  points: TrendPoint[];
  requestedFocusedMarker?: HeartIntradayMarker | null;
  requestedFocusedMarkerId?: string | null;
  resetKey?: string;
  windowPointCount: number;
}) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(height);
  const baseWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const [plotBaseWindowPointCount, setPlotBaseWindowPointCount] = useState(baseWindowPointCount);
  const [activeWindowPointCount, setActiveWindowPointCount] = useState(baseWindowPointCount);
  const activeWindowPointCountRef = useRef(baseWindowPointCount);
  const safeWindowPointCount = Math.min(Math.max(activeWindowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const [windowStart, setWindowStart] = useState(maxWindowStart);
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);
  const windowStartRef = useRef(maxWindowStart);
  const maxWindowStartRef = useRef(maxWindowStart);
  maxWindowStartRef.current = maxWindowStart;
  const [selectionIndex, setSelectionIndex] = useState<number | null>(null);
  const selectionRef = useRef<number | null>(null);
  const releaseScrollLockRef = useRef<(() => void) | null>(null);
  const previousPointCountRef = useRef(points.length);
  const previousWindowBeforeFocusRef = useRef<{ windowPointCount: number; windowStart: number } | null>(null);
  const draftGestureOriginRef = useRef<HeartActivityDraft | null>(activityDraft ?? null);
  const latestActivityDraftRef = useRef<HeartActivityDraft | null>(activityDraft);
  const previousRequestedFocusedMarkerRef = useRef<HeartIntradayMarker | null>(null);
  const previousPrecisionContextRef = useRef({
    markers,
    points,
    pointIntervalMinutes,
  });
  const previousTimelineZoomContextRef = useRef({
    baseWindowPointCount,
    pointIntervalMinutes,
    resetKey,
  });
  const requestedFocusMarkerIdRef = useRef<string | null>(null);
  const pendingLoadMoreRef = useRef(false);
  const previousJumpToLatestSignalRef = useRef<number | undefined>(jumpToLatestSignal);
  const skipLatestWindowChangeRef = useRef(true);
  const focusTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presetZoomTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartId = useId().replace(/[:]/g, '');
  const acquireScreenScrollLock = useAcquireScreenScrollLock();

  const animatedWindowStart = useSharedValue(maxWindowStart);
  const gestureStartWindowStart = useSharedValue(windowStart);
  const reportedWindowStart = useSharedValue(windowStart);
  const chartPointSpacingValue = useSharedValue(0);
  const maxWindowStartValue = useSharedValue(maxWindowStart);
  const isAxisDragging = useSharedValue(false);
  const loadRequested = useSharedValue(false);
  const viewportZoomScale = useSharedValue(1);
  const viewportZoomAnchorIndex = useSharedValue(maxWindowStart);
  const viewportZoomAnchorScreenX = useSharedValue(0);

  const pointSpacing = getHeartViewportPointSpacing(viewportWidth, safeWindowPointCount);
  const basePointSpacing = getHeartViewportPointSpacing(viewportWidth, plotBaseWindowPointCount);
  const chartPointSpacing = basePointSpacing > 0 ? basePointSpacing : 1;
  const viewBoxWidth = getHeartViewBoxWidth(safeWindowPointCount);
  const visibleDomain = useMemo(
    () => buildVisibleHeartDomain(points, safeWindowPointCount, windowStart),
    [points, safeWindowPointCount, windowStart],
  );
  const baseDomain = useMemo(() => buildTrendDomain(points, { mode: 'line' }), [points]);
  const focusTransitionProgress = useSharedValue(focusedMarkerId !== null ? 1 : 0);
  const focusSourceDomainMin = useSharedValue(baseDomain?.min ?? 0);
  const focusSourceDomainMax = useSharedValue(baseDomain?.max ?? 1);
  const focusTargetDomainMin = useSharedValue(baseDomain?.min ?? 0);
  const focusTargetDomainMax = useSharedValue(baseDomain?.max ?? 1);
  const isFocusDomainSourceFrozen = useSharedValue(0);
  const isTimelineDomainSourceFrozen = useSharedValue(0);
  const timelineDomainTransitionProgress = useSharedValue(1);
  const timelineSourceDomainMin = useSharedValue(visibleDomain?.min ?? baseDomain?.min ?? 0);
  const timelineSourceDomainMax = useSharedValue(visibleDomain?.max ?? baseDomain?.max ?? 1);
  const timelineTargetDomainMin = useSharedValue(visibleDomain?.min ?? baseDomain?.min ?? 0);
  const timelineTargetDomainMax = useSharedValue(visibleDomain?.max ?? baseDomain?.max ?? 1);
  const focusedDomainMin = useSharedValue(baseDomain?.min ?? 0);
  const focusedDomainMax = useSharedValue(baseDomain?.max ?? 1);
  const windowDomains = useMemo(
    () => buildHeartWindowDomains(points, safeWindowPointCount),
    [points, safeWindowPointCount],
  );
  const coordinates = useMemo(
    () => buildHeartCoordinates(points, baseDomain, chartPointSpacing),
    [baseDomain, chartPointSpacing, points],
  );
  const lineGeometry = useMemo(() => buildTrendLineGeometry(coordinates), [coordinates]);
  const paths = useMemo(() => lineGeometry.segments.map((segment) => buildLine(segment)), [lineGeometry]);
  const bridgePaths = useMemo(() => lineGeometry.bridges.map((bridge) => buildLine(bridge)), [lineGeometry]);
  const areas = useMemo(
    () =>
      lineGeometry.segments
        .filter((segment) => segment.length >= 2)
        .map((segment) => {
          const path = buildLine(segment);
          const startX = segment[0]?.x ?? 0;
          const endX = segment.at(-1)?.x ?? startX;
          return `${path} L ${endX} ${TREND_VIEWBOX_BASELINE} L ${startX} ${TREND_VIEWBOX_BASELINE} Z`;
        }),
    [lineGeometry],
  );
  const chartContentWidth = Math.max(
    getHeartViewportContentWidth(viewportWidth, points.length, plotBaseWindowPointCount),
    1,
  );
  const chartEndX = Math.max(chartContentWidth, chartPointSpacing);
  const guideLineY =
    baseDomain && baseDomain.min < 0 && baseDomain.max > 0
      ? mapTrendValueToY(0, baseDomain)
      : 24;
  const selectionPoint = selectionIndex === null ? null : points[selectionIndex] ?? null;
  const selectionX =
    selectionIndex !== null &&
    selectionIndex >= windowStart &&
    selectionIndex <= windowStart + viewBoxWidth
      ? safeWindowPointCount <= 1
        ? 50
        : ((selectionIndex - windowStart) / viewBoxWidth) * 100
      : null;

  const fullSeriesSpan = Math.max(chartContentWidth - chartPointSpacing, chartPointSpacing);
  const markerVisuals = useMemo(
    () =>
      mapHeartIntradayMarkersToTrendMarkers(markers).map((marker, index) => {
        const sourceMarker = markers[index];
        const presentation = sourceMarker ? getHeartIntradayMarkerPresentation(sourceMarker) : null;
        const startFraction = clampFraction(marker.startFraction);
        const endFraction = clampFraction(Math.max(marker.startFraction, marker.endFraction));
        const startX = startFraction * fullSeriesSpan;
        const endX = endFraction * fullSeriesSpan;
        const midpoint = clampFraction((startFraction + endFraction) / 2) * fullSeriesSpan;

        return {
          ...marker,
          bandWidth: Math.max(endX - startX, MIN_MARKER_BAND_WIDTH),
          centerX: midpoint,
          endFraction,
          isZoomable: sourceMarker ? isZoomableHeartMarkerKind(sourceMarker.kind) : false,
          kind: sourceMarker?.kind ?? 'activity',
          label: sourceMarker?.label ?? marker.id,
          badgeOpacity: presentation?.badgeOpacity ?? 1,
          startFraction,
          startX,
          testID: chartTestID ? `${chartTestID}-marker-${sanitizeMarkerId(marker.id)}` : undefined,
          timeLabel: sourceMarker?.timeLabel ?? '',
        } satisfies HeartMarkerVisual;
      }),
    [chartTestID, fullSeriesSpan, markers],
  );

  const axisLabels = useMemo(
    () => buildHeartAxisLabels(points, safeWindowPointCount, anchorDayKey, windowStart, pointIntervalMinutes),
    [anchorDayKey, pointIntervalMinutes, points, safeWindowPointCount, windowStart],
  );
  const focusedMarker = useMemo(
    () => markers.find((marker) => marker.id === focusedMarkerId) ?? (focusedMarkerId !== null ? requestedFocusedMarker : null),
    [focusedMarkerId, markers, requestedFocusedMarker],
  );
  const reportFocusTransitionStateChange = useCallback(
    (isTransitioning: boolean) => {
      onFocusTransitionStateChange?.(isTransitioning);
    },
    [onFocusTransitionStateChange],
  );
  const reportPresetZoomTransitionStateChange = useCallback(
    (isTransitioning: boolean) => {
      onPresetZoomTransitionStateChange?.(isTransitioning);
    },
    [onPresetZoomTransitionStateChange],
  );
  const clearFocusTransitionTimeout = useCallback(() => {
    if (focusTransitionTimeoutRef.current === null) {
      return;
    }

    clearTimeout(focusTransitionTimeoutRef.current);
    focusTransitionTimeoutRef.current = null;
  }, []);
  const clearPresetZoomTransitionTimeout = useCallback(() => {
    if (presetZoomTransitionTimeoutRef.current === null) {
      return;
    }

    clearTimeout(presetZoomTransitionTimeoutRef.current);
    presetZoomTransitionTimeoutRef.current = null;
  }, []);
  const scheduleFocusTransitionSettled = useCallback(() => {
    clearFocusTransitionTimeout();
    focusTransitionTimeoutRef.current = setTimeout(() => {
      focusTransitionTimeoutRef.current = null;
      reportFocusTransitionStateChange(false);
    }, FOCUS_ZOOM_DURATION_MS);
  }, [clearFocusTransitionTimeout, reportFocusTransitionStateChange]);
  const schedulePresetZoomTransitionSettled = useCallback(
    (durationMs: number) => {
      clearPresetZoomTransitionTimeout();
      presetZoomTransitionTimeoutRef.current = setTimeout(() => {
        presetZoomTransitionTimeoutRef.current = null;
        reportPresetZoomTransitionStateChange(false);
      }, durationMs);
    },
    [clearPresetZoomTransitionTimeout, reportPresetZoomTransitionStateChange],
  );
  const focusedMarkerDomain = useMemo(
    () => buildHeartMarkerDomain(points, focusedMarker),
    [focusedMarker, points],
  );
  const selectionDomain = baseDomain;
  const selectionY = selectionPoint && selectionPoint.value !== null && selectionDomain
    ? mapTrendValueToY(selectionPoint.value, selectionDomain)
    : null;
  const sleepStageHighlights = useMemo(
    () =>
      highlightedSleepStage
        ? buildHeartSleepStageHighlights(focusedMarker, highlightedSleepStage, fullSeriesSpan, chartTestID)
        : EMPTY_HEART_SLEEP_STAGE_HIGHLIGHTS,
    [chartTestID, focusedMarker, fullSeriesSpan, highlightedSleepStage],
  );
  const activeSleepStageColor = highlightedSleepStage ? sleepStageColors[highlightedSleepStage] : null;
  const sleepStageHighlightClipId = highlightedSleepStage ? `${chartId}-stage-highlight-clip-${highlightedSleepStage}` : null;
  const sleepStageHighlightFillId = highlightedSleepStage ? `${chartId}-stage-highlight-fill-${highlightedSleepStage}` : null;
  const sleepStageSelectionRanges = useMemo(
    () => buildHeartSleepStageSelectionRanges(points.length, focusedMarker, highlightedSleepStage),
    [focusedMarker, highlightedSleepStage, points.length],
  );
  const draftVisibleWindowStartMinuteOffset = windowStart * pointIntervalMinutes;
  const draftVisibleWindowEndMinuteOffset = Math.max(
    draftVisibleWindowStartMinuteOffset + MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
    (windowStart + safeWindowPointCount - 1) * pointIntervalMinutes,
  );
  const activityDraftVisual = useMemo(() => {
    if (!activityDraft || viewportWidth <= 0 || pointSpacing <= 0 || viewportHeight <= 0) {
      return null;
    }

    const minuteSpacing = pointSpacing / pointIntervalMinutes;
    if (minuteSpacing <= 0) {
      return null;
    }

    const clampedStartMinuteOffset = clamp(
      activityDraft.startMinuteOffset,
      draftVisibleWindowStartMinuteOffset,
      Math.max(
        draftVisibleWindowStartMinuteOffset,
        draftVisibleWindowEndMinuteOffset - MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
      ),
    );
    const clampedEndMinuteOffset = clamp(
      activityDraft.endMinuteOffset,
      clampedStartMinuteOffset + MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
      draftVisibleWindowEndMinuteOffset,
    );
    const startX = Math.max(0, (clampedStartMinuteOffset - draftVisibleWindowStartMinuteOffset) * minuteSpacing);
    const endX = Math.min(
      viewportWidth,
      (clampedEndMinuteOffset - draftVisibleWindowStartMinuteOffset) * minuteSpacing,
    );
    const bandWidth = Math.max(endX - startX, 2);
    const handleMaxLeft = Math.max(viewportWidth - ACTIVITY_DRAFT_HANDLE_WIDTH, 0);
    const startHandleLeft = clamp(startX - ACTIVITY_DRAFT_HANDLE_WIDTH / 2, 0, handleMaxLeft);
    const endHandleLeft = clamp(endX - ACTIVITY_DRAFT_HANDLE_WIDTH / 2, 0, handleMaxLeft);
    const bodyWidth = Math.max(bandWidth + 24, ACTIVITY_DRAFT_BODY_MIN_WIDTH);
    const bodyLeft = clamp(
      startX + bandWidth / 2 - bodyWidth / 2,
      0,
      Math.max(viewportWidth - bodyWidth, 0),
    );
    const bandTop = viewportHeight * (ACTIVITY_DRAFT_BAND_TOP / HEART_CHART_VIEWBOX_HEIGHT);
    const bandHeight = viewportHeight * (ACTIVITY_DRAFT_BAND_HEIGHT / HEART_CHART_VIEWBOX_HEIGHT);
    const inlineBadgeLeft = clamp(
      startX + bandWidth / 2 - MARKER_BADGE_SIZE / 2,
      0,
      Math.max(viewportWidth - MARKER_BADGE_SIZE, 0),
    );
    const inlineBadgeTop = 8;
    const handleHeight = Math.min(Math.max(32, bandHeight * 0.38), bandHeight + 8);
    const handleTop = bandTop + (bandHeight - handleHeight) / 2;

    return {
      bandHeight,
      bandTop,
      bandWidth,
      bodyLeft,
      bodyWidth,
      endHandleLeft,
      endX,
      handleHeight,
      handleTop,
      inlineBadgeLeft,
      inlineBadgeTop,
      startHandleLeft,
      startX,
    };
  }, [
    activityDraft,
    draftVisibleWindowEndMinuteOffset,
    draftVisibleWindowStartMinuteOffset,
    pointSpacing,
    viewportHeight,
    viewportWidth,
  ]);
  const activityDraftBadgeMarker = useMemo(() => {
    if (!activityDraft || !activityDraftVisual) {
      return null;
    }

    const markerKind = activityDraft.kind === 'Sleep'
      ? 'sleep'
      : activityDraft.kind === 'Nap'
        ? 'nap'
        : 'activity';

    const draftMarker = {
      id: 'draft-activity-marker',
      kind: markerKind,
      label: activityDraft.kind,
      timeLabel: 'Draft activity',
      startFraction: 0,
      endFraction: 0,
      details: {
        durationMinutes: null,
        reviewState: 'confirmed',
        source: 'manual',
      },
    } satisfies HeartIntradayMarker;
    const presentation = getHeartIntradayMarkerPresentation(draftMarker);

    return {
      accessibilityLabel: `Draft ${draftMarker.label}`,
      accentColor: presentation.accentColor,
      backgroundColor: presentation.backgroundColor,
      badgeOpacity: 1,
      bandWidth: activityDraftVisual.bandWidth,
      centerX: activityDraftVisual.startX + activityDraftVisual.bandWidth / 2,
      endFraction: 0,
      isZoomable: false,
      iconName: presentation.iconName,
      id: draftMarker.id,
      kind: draftMarker.kind,
      label: draftMarker.label,
      startFraction: 0,
      startX: activityDraftVisual.startX,
      testID: chartTestID ? `${chartTestID}-draft-marker` : undefined,
      timeLabel: draftMarker.timeLabel,
    } satisfies HeartMarkerVisual;
  }, [activityDraft, activityDraftVisual, chartTestID]);
  const activityDraftAccentColor = activityDraft?.kind === 'Sleep'
    ? colors.indigo
    : activityDraft?.kind === 'Nap'
      ? colors.aqua
      : colors.heart;
  const activityDraftFillColor = activityDraft?.kind === 'Sleep'
    ? 'rgba(93, 120, 255, 0.18)'
    : activityDraft?.kind === 'Nap'
      ? 'rgba(86, 255, 209, 0.18)'
      : 'rgba(255, 210, 107, 0.18)';
  const markerBandTop = viewportHeight * (ACTIVITY_DRAFT_BAND_TOP / HEART_CHART_VIEWBOX_HEIGHT);
  const markerBandHeight = viewportHeight * (ACTIVITY_DRAFT_BAND_HEIGHT / HEART_CHART_VIEWBOX_HEIGHT);
  const markerBandRadius = viewportHeight * (3 / HEART_CHART_VIEWBOX_HEIGHT);
  const isFocusedWindow = focusedMarkerId !== null || safeWindowPointCount !== baseWindowPointCount;
  const hasTopMarkers = markerVisuals.length > 0 || activityDraftBadgeMarker !== null;
  const isViewingLatestWindow = windowStart >= maxWindowStart && safeWindowPointCount === baseWindowPointCount;

  const ensureScrollLock = useCallback(() => {
    if (releaseScrollLockRef.current || !acquireScreenScrollLock) {
      return;
    }

    releaseScrollLockRef.current = acquireScreenScrollLock();
  }, [acquireScreenScrollLock]);

  const releaseScrollLock = useCallback(() => {
    releaseScrollLockRef.current?.();
    releaseScrollLockRef.current = null;
  }, []);

  const commitSelection = useCallback((nextSelectionIndex: number | null) => {
    if (selectionRef.current === nextSelectionIndex) {
      return;
    }

    selectionRef.current = nextSelectionIndex;
    setSelectionIndex(nextSelectionIndex);
  }, []);

  const updateSelection = useCallback(
    (touchX: number) => {
      if (activityDraft) {
        commitSelection(null);
        return;
      }

      if (pointSpacing <= 0 || points.length === 0) {
        commitSelection(null);
        return;
      }

      const pointOffset = clamp(Math.round(touchX / pointSpacing), 0, safeWindowPointCount - 1);
      const nextIndex = clamp(windowStartRef.current + pointOffset, 0, points.length - 1);

      if (
        sleepStageSelectionRanges.length > 0 &&
        !sleepStageSelectionRanges.some(
          (range) => nextIndex >= range.startIndex && nextIndex <= range.endIndex,
        )
      ) {
        commitSelection(null);
        return;
      }

      commitSelection(nextIndex);
    },
    [activityDraft, commitSelection, pointSpacing, points.length, safeWindowPointCount, sleepStageSelectionRanges],
  );

  const syncWindowStart = useCallback((nextWindowStart: number) => {
    const clamped = clamp(nextWindowStart, 0, maxWindowStartRef.current);
    windowStartRef.current = clamped;
    setWindowStart((current) => (current === clamped ? current : clamped));
  }, []);

  const startWindowZoomTransition = useCallback(
    ({
      currentAnchorScreenX,
      clampedWindowStart,
      nextAnchorIndex,
      nextAnchorScreenX,
      nextFocusedMarkerId,
      nextZoomScale,
      previousAnimatedWindowStart,
      reportTransitionSettledWhenComplete,
      resolvedWindowPointCount,
    }: {
      currentAnchorScreenX: number;
      clampedWindowStart: number;
      nextAnchorIndex: number;
      nextAnchorScreenX: number;
      nextFocusedMarkerId: string | null;
      nextZoomScale: number;
      previousAnimatedWindowStart: number;
      reportTransitionSettledWhenComplete: boolean;
      resolvedWindowPointCount: number;
    }) => {
      activeWindowPointCountRef.current = resolvedWindowPointCount;
      windowStartRef.current = clampedWindowStart;
      gestureStartWindowStart.value = clampedWindowStart;
      reportedWindowStart.value = clampedWindowStart;
      viewportZoomAnchorIndex.value = nextAnchorIndex;

      startTransition(() => {
        setActiveWindowPointCount(resolvedWindowPointCount);
        setFocusedMarkerId(nextFocusedMarkerId);
        setWindowStart(clampedWindowStart);
      });

      if (viewportWidth <= 0) {
        animatedWindowStart.value = clampedWindowStart;
        viewportZoomScale.value = nextZoomScale;
        viewportZoomAnchorScreenX.value = nextAnchorScreenX;

        if (reportTransitionSettledWhenComplete) {
          clearFocusTransitionTimeout();
          reportFocusTransitionStateChange(false);
        }

        return;
      }

      viewportZoomAnchorScreenX.value = currentAnchorScreenX;
      animatedWindowStart.value = previousAnimatedWindowStart;
      animatedWindowStart.value = withTiming(clampedWindowStart, { duration: FOCUS_ZOOM_DURATION_MS });
      viewportZoomScale.value = withTiming(nextZoomScale, { duration: FOCUS_ZOOM_DURATION_MS });
      viewportZoomAnchorScreenX.value = withTiming(nextAnchorScreenX, { duration: FOCUS_ZOOM_DURATION_MS });
    },
    [
      animatedWindowStart,
      clearFocusTransitionTimeout,
      gestureStartWindowStart,
      reportFocusTransitionStateChange,
      reportedWindowStart,
      viewportWidth,
      viewportZoomAnchorIndex,
      viewportZoomAnchorScreenX,
      viewportZoomScale,
    ],
  );

  const applyWindowZoom = useCallback(
    (
      nextWindowPointCount: number,
      nextWindowStart: number,
      nextFocusedMarkerId: string | null,
      nextViewportZoomAnchorIndex?: number,
    ) => {
      const resolvedWindowPointCount = Math.min(Math.max(nextWindowPointCount, 2), Math.max(points.length, 1));
      const nextMaxWindowStart = Math.max(0, points.length - resolvedWindowPointCount);
      const clampedWindowStart = clamp(nextWindowStart, 0, nextMaxWindowStart);
      const nextZoomScale = getHeartViewportZoomScale(plotBaseWindowPointCount, resolvedWindowPointCount);
      const previousAnimatedWindowStart = clamp(animatedWindowStart.value, 0, maxWindowStartRef.current);
      const currentVisibleDomain =
        windowDomains
          ? interpolateHeartDomain(previousAnimatedWindowStart, windowDomains.mins, windowDomains.maxs)
          : baseDomain;
      const currentFocusedDomain =
        focusedDomainMax.value > focusedDomainMin.value
          ? {
              min: focusedDomainMin.value,
              max: focusedDomainMax.value,
            }
          : focusedMarkerDomain ?? baseDomain;
      const nextFocusedMarker =
        nextFocusedMarkerId !== null ? markers.find((marker) => marker.id === nextFocusedMarkerId) ?? null : null;
      const nextFocusedDomain = nextFocusedMarker ? buildHeartMarkerDomain(points, nextFocusedMarker) : null;
      const nextVisibleDomain = buildVisibleHeartDomain(points, resolvedWindowPointCount, clampedWindowStart);
      const nextAnchorIndex = clamp(
        nextViewportZoomAnchorIndex ?? clampedWindowStart,
        0,
        Math.max(points.length - 1, 0),
      );
      const currentAnchorScreenX =
        viewportZoomAnchorScreenX.value +
        viewportZoomScale.value * (nextAnchorIndex - viewportZoomAnchorIndex.value) * chartPointSpacing;
      const nextAnchorScreenX = nextZoomScale * (nextAnchorIndex - clampedWindowStart) * chartPointSpacing;
      const isFocusStateChanging = focusedMarkerId !== nextFocusedMarkerId;

      pendingLoadMoreRef.current = false;
      loadRequested.value = false;
      commitSelection(null);
      releaseScrollLock();
      cancelAnimation(animatedWindowStart);
      cancelAnimation(viewportZoomScale);
      cancelAnimation(viewportZoomAnchorScreenX);
      isAxisDragging.value = false;

      if (isFocusStateChanging) {
        reportFocusTransitionStateChange(true);
        scheduleFocusTransitionSettled();
      }

      if (nextFocusedMarkerId !== null && currentVisibleDomain && nextFocusedDomain) {
        focusSourceDomainMin.value = currentVisibleDomain.min;
        focusSourceDomainMax.value = currentVisibleDomain.max;
        focusTargetDomainMin.value = nextFocusedDomain.min;
        focusTargetDomainMax.value = nextFocusedDomain.max;
        isFocusDomainSourceFrozen.value = 1;
      } else if (nextFocusedMarkerId === null && nextVisibleDomain && currentFocusedDomain) {
        focusSourceDomainMin.value = nextVisibleDomain.min;
        focusSourceDomainMax.value = nextVisibleDomain.max;
        focusTargetDomainMin.value = currentFocusedDomain.min;
        focusTargetDomainMax.value = currentFocusedDomain.max;
        isFocusDomainSourceFrozen.value = 1;
      } else {
        isFocusDomainSourceFrozen.value = 0;
      }

      startWindowZoomTransition({
        currentAnchorScreenX,
        clampedWindowStart,
        nextAnchorIndex,
        nextAnchorScreenX,
        nextFocusedMarkerId,
        nextZoomScale,
        previousAnimatedWindowStart,
        reportTransitionSettledWhenComplete: isFocusStateChanging,
        resolvedWindowPointCount,
      });
    },
    [
      animatedWindowStart,
      cancelAnimation,
      chartPointSpacing,
      commitSelection,
      isAxisDragging,
      loadRequested,
      points.length,
      plotBaseWindowPointCount,
      releaseScrollLock,
      baseDomain,
      focusedDomainMax,
      focusedDomainMin,
      focusedMarkerDomain,
      focusedMarkerId,
      viewportWidth,
      windowDomains,
      focusSourceDomainMax,
      focusSourceDomainMin,
      focusTargetDomainMax,
      focusTargetDomainMin,
      isFocusDomainSourceFrozen,
      markers,
      reportFocusTransitionStateChange,
      scheduleFocusTransitionSettled,
      startWindowZoomTransition,
      viewportZoomAnchorScreenX,
      viewportZoomScale,
    ],
  );

  const syncFocusedWindowInstant = useCallback(
    (
      nextWindowPointCount: number,
      nextWindowStart: number,
      nextFocusedMarkerId: string | null,
      nextViewportZoomAnchorIndex?: number,
    ) => {
      const resolvedWindowPointCount = Math.min(Math.max(nextWindowPointCount, 2), Math.max(points.length, 1));
      const nextMaxWindowStart = Math.max(0, points.length - resolvedWindowPointCount);
      const clampedWindowStart = clamp(nextWindowStart, 0, nextMaxWindowStart);
      const nextZoomScale = getHeartViewportZoomScale(plotBaseWindowPointCount, resolvedWindowPointCount);
      const nextAnchorIndex = clamp(
        nextViewportZoomAnchorIndex ?? clampedWindowStart,
        0,
        Math.max(points.length - 1, 0),
      );
      const nextAnchorScreenX = nextZoomScale * (nextAnchorIndex - clampedWindowStart) * chartPointSpacing;

      pendingLoadMoreRef.current = false;
      loadRequested.value = false;
      commitSelection(null);
      releaseScrollLock();
      cancelAnimation(animatedWindowStart);
      cancelAnimation(viewportZoomScale);
      cancelAnimation(viewportZoomAnchorScreenX);
      isAxisDragging.value = false;
      isFocusDomainSourceFrozen.value = 0;

      activeWindowPointCountRef.current = resolvedWindowPointCount;
      windowStartRef.current = clampedWindowStart;
      gestureStartWindowStart.value = clampedWindowStart;
      reportedWindowStart.value = clampedWindowStart;
      viewportZoomAnchorIndex.value = nextAnchorIndex;
      animatedWindowStart.value = clampedWindowStart;
      viewportZoomScale.value = nextZoomScale;
      viewportZoomAnchorScreenX.value = nextAnchorScreenX;

      startTransition(() => {
        setActiveWindowPointCount(resolvedWindowPointCount);
        setFocusedMarkerId(nextFocusedMarkerId);
        setWindowStart(clampedWindowStart);
      });
    },
    [
      animatedWindowStart,
      cancelAnimation,
      chartPointSpacing,
      commitSelection,
      focusedMarkerId,
      gestureStartWindowStart,
      isAxisDragging,
      isFocusDomainSourceFrozen,
      loadRequested,
      points.length,
      plotBaseWindowPointCount,
      releaseScrollLock,
      reportedWindowStart,
      viewportZoomAnchorIndex,
      viewportZoomAnchorScreenX,
      viewportZoomScale,
    ],
  );

  const handleMarkerZoomPress = useCallback(
    (marker: HeartMarkerVisual) => {
      if (!marker.isZoomable) {
        return;
      }

      if (previousWindowBeforeFocusRef.current === null) {
        previousWindowBeforeFocusRef.current = {
          windowPointCount: activeWindowPointCountRef.current,
          windowStart: windowStartRef.current,
        };
      }

      const focusedWindow = buildFocusedHeartMarkerWindow(marker, points.length, baseWindowPointCount);

      if (!focusedWindow) {
        return;
      }

      const markerCenterIndex =
        ((marker.startFraction + marker.endFraction) / 2) * Math.max(points.length - 1, 0);

      applyWindowZoom(focusedWindow.windowPointCount, focusedWindow.windowStart, marker.id, markerCenterIndex);
    },
    [applyWindowZoom, baseWindowPointCount, points.length],
  );

  useEffect(() => {
    if (!requestedFocusedMarker || previousRequestedFocusedMarkerRef.current === requestedFocusedMarker) {
      return;
    }

    const previousRequestedMarker = previousRequestedFocusedMarkerRef.current;
    const previousPrecisionContext = previousPrecisionContextRef.current;
    const isInPlaceFocusedMarkerUpdate =
      focusedMarkerId !== null &&
      focusedMarkerId === requestedFocusedMarker.id &&
      (
        previousPrecisionContext.points.length !== points.length ||
        previousPrecisionContext.pointIntervalMinutes !== pointIntervalMinutes ||
        previousRequestedMarker?.startFraction !== requestedFocusedMarker.startFraction ||
        previousRequestedMarker?.endFraction !== requestedFocusedMarker.endFraction
      );

    previousRequestedFocusedMarkerRef.current = requestedFocusedMarker;

    if (previousWindowBeforeFocusRef.current === null) {
      previousWindowBeforeFocusRef.current = {
        windowPointCount: activeWindowPointCountRef.current,
        windowStart: windowStartRef.current,
      };
    }

    const focusedWindow = buildFocusedHeartMarkerWindow(requestedFocusedMarker, points.length, baseWindowPointCount);
    if (!focusedWindow) {
      return;
    }

    const markerCenterIndex =
      ((requestedFocusedMarker.startFraction + requestedFocusedMarker.endFraction) / 2) *
      Math.max(points.length - 1, 0);

    if (isInPlaceFocusedMarkerUpdate) {
      syncFocusedWindowInstant(
        focusedWindow.windowPointCount,
        focusedWindow.windowStart,
        requestedFocusedMarker.id,
        markerCenterIndex,
      );
      return;
    }

    applyWindowZoom(
      focusedWindow.windowPointCount,
      focusedWindow.windowStart,
      requestedFocusedMarker.id,
      markerCenterIndex,
    );
  }, [
    applyWindowZoom,
    baseWindowPointCount,
    focusedMarkerId,
    pointIntervalMinutes,
    points.length,
    requestedFocusedMarker,
    syncFocusedWindowInstant,
  ]);

  useEffect(() => {
    previousPrecisionContextRef.current = {
      markers,
      points,
      pointIntervalMinutes,
    };
  }, [markers, pointIntervalMinutes, points]);

  useEffect(() => {
    if (!requestedFocusedMarkerId || requestedFocusedMarkerId === requestedFocusMarkerIdRef.current) {
      return;
    }

    const requestedMarker = markerVisuals.find((marker) => marker.id === requestedFocusedMarkerId) ?? null;
    if (!requestedMarker || !requestedMarker.isZoomable) {
      return;
    }

    requestedFocusMarkerIdRef.current = requestedFocusedMarkerId;
    handleMarkerZoomPress(requestedMarker);
  }, [handleMarkerZoomPress, markerVisuals, requestedFocusedMarkerId]);

  const handleAxisPanStart = useCallback(() => {
    ensureScrollLock();
    commitSelection(null);
  }, [commitSelection, ensureScrollLock]);

  const handleAxisPanEnd = useCallback(() => {
    releaseScrollLock();
  }, [releaseScrollLock]);

  const handleJumpToLatest = useCallback(() => {
    const nextWindowStart = Math.max(0, points.length - baseWindowPointCount);
    const previousWindowBeforeFocus = previousWindowBeforeFocusRef.current;

    pendingLoadMoreRef.current = false;
    loadRequested.value = false;
    commitSelection(null);
    releaseScrollLock();

    if (activeWindowPointCountRef.current !== baseWindowPointCount || focusedMarkerId !== null) {
      previousWindowBeforeFocusRef.current = null;
      if (previousWindowBeforeFocus) {
        applyWindowZoom(previousWindowBeforeFocus.windowPointCount, previousWindowBeforeFocus.windowStart, null);
        return;
      }

      applyWindowZoom(baseWindowPointCount, nextWindowStart, null);
      return;
    }

    cancelAnimation(animatedWindowStart);
    cancelAnimation(viewportZoomAnchorScreenX);
    gestureStartWindowStart.value = nextWindowStart;
    viewportZoomAnchorIndex.value = animatedWindowStart.value;
    viewportZoomAnchorScreenX.value = 0;
    animatedWindowStart.value = withTiming(nextWindowStart, { duration: SNAP_DURATION_MS }, (finished) => {
      if (!finished) {
        return;
      }

      reportedWindowStart.value = nextWindowStart;
      runOnJS(syncWindowStart)(nextWindowStart);
    });
    viewportZoomAnchorIndex.value = withTiming(nextWindowStart, { duration: SNAP_DURATION_MS });
  }, [
    animatedWindowStart,
    cancelAnimation,
    commitSelection,
    gestureStartWindowStart,
    applyWindowZoom,
    baseWindowPointCount,
    focusedMarkerId,
    loadRequested,
    points.length,
    releaseScrollLock,
    reportedWindowStart,
    syncWindowStart,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
  ]);

  const handleLoadMore = useCallback(() => {
    pendingLoadMoreRef.current = true;
    onLoadMore?.();
  }, [onLoadMore]);

  useLayoutEffect(() => {
    chartPointSpacingValue.value = chartPointSpacing;
    maxWindowStartValue.value = maxWindowStart;
  }, [chartPointSpacing, chartPointSpacingValue, maxWindowStart, maxWindowStartValue]);

  useLayoutEffect(() => {
    const previousPointCount = previousPointCountRef.current;
    const previousTimelineZoomContext = previousTimelineZoomContextRef.current;
    const previousMaxWindowStart = Math.max(0, previousPointCount - safeWindowPointCount);
    const pointCountDelta = points.length - previousPointCount;
    const isExternalTimelineZoomChange =
      previousTimelineZoomContext.resetKey === resetKey &&
      focusedMarkerId === null &&
      requestedFocusedMarker === null &&
      !requestedFocusedMarkerId &&
      (previousTimelineZoomContext.baseWindowPointCount !== baseWindowPointCount ||
        previousTimelineZoomContext.pointIntervalMinutes !== pointIntervalMinutes);

    if (pointCountDelta === 0) {
      return;
    }

    if (isExternalTimelineZoomChange) {
      previousPointCountRef.current = points.length;
      return;
    }

    let nextAnimatedWindowStart = clamp(windowStartRef.current, 0, maxWindowStart);
    let nextGestureStart = clamp(windowStartRef.current, 0, maxWindowStart);

    const animatedPointsFromNewest = clamp(
      previousMaxWindowStart - animatedWindowStart.value,
      0,
      previousMaxWindowStart,
    );
    const gesturePointsFromNewest = clamp(
      previousMaxWindowStart - gestureStartWindowStart.value,
      0,
      previousMaxWindowStart,
    );

    nextAnimatedWindowStart = clamp(maxWindowStart - animatedPointsFromNewest, 0, maxWindowStart);
    nextGestureStart = clamp(maxWindowStart - gesturePointsFromNewest, 0, maxWindowStart);
    pendingLoadMoreRef.current = false;
    loadRequested.value = false;

    previousPointCountRef.current = points.length;
    animatedWindowStart.value = nextAnimatedWindowStart;
    gestureStartWindowStart.value = nextGestureStart;
    viewportZoomAnchorIndex.value = nextAnimatedWindowStart;
    viewportZoomAnchorScreenX.value = 0;

    const nextWindowStart = clamp(Math.floor(nextAnimatedWindowStart), 0, maxWindowStart);
    reportedWindowStart.value = nextWindowStart;
    syncWindowStart(nextWindowStart);
  }, [
    animatedWindowStart,
    baseWindowPointCount,
    focusedMarkerId,
    gestureStartWindowStart,
    loadRequested,
    maxWindowStart,
    pointIntervalMinutes,
    points.length,
    reportedWindowStart,
    requestedFocusedMarker,
    requestedFocusedMarkerId,
    resetKey,
    safeWindowPointCount,
    syncWindowStart,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
  ]);

  useLayoutEffect(() => {
    setPlotBaseWindowPointCount(baseWindowPointCount);
    const nextWindowStart = maxWindowStart;

    activeWindowPointCountRef.current = baseWindowPointCount;
    setActiveWindowPointCount(baseWindowPointCount);
    setFocusedMarkerId(null);
    previousWindowBeforeFocusRef.current = null;
    previousPointCountRef.current = points.length;
    pendingLoadMoreRef.current = false;
    windowStartRef.current = nextWindowStart;
    setWindowStart(nextWindowStart);
    commitSelection(null);
    cancelAnimation(animatedWindowStart);
    animatedWindowStart.value = nextWindowStart;
    loadRequested.value = false;
    gestureStartWindowStart.value = nextWindowStart;
    reportedWindowStart.value = nextWindowStart;
    isAxisDragging.value = false;
    clearFocusTransitionTimeout();
    clearPresetZoomTransitionTimeout();
    isFocusDomainSourceFrozen.value = 0;
    isTimelineDomainSourceFrozen.value = 0;
    timelineDomainTransitionProgress.value = 1;
    viewportZoomScale.value = getHeartViewportZoomScale(baseWindowPointCount, baseWindowPointCount);
    viewportZoomAnchorIndex.value = nextWindowStart;
    viewportZoomAnchorScreenX.value = 0;
    reportPresetZoomTransitionStateChange(false);
  }, [
    animatedWindowStart,
    cancelAnimation,
    chartPointSpacingValue,
    commitSelection,
    gestureStartWindowStart,
    isAxisDragging,
    loadRequested,
    clearFocusTransitionTimeout,
    clearPresetZoomTransitionTimeout,
    reportedWindowStart,
    reportPresetZoomTransitionStateChange,
    resetKey,
    isFocusDomainSourceFrozen,
    isTimelineDomainSourceFrozen,
    timelineDomainTransitionProgress,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
    viewportZoomScale,
  ]);

  useLayoutEffect(() => {
    const previousTimelineZoomContext = previousTimelineZoomContextRef.current;
    previousTimelineZoomContextRef.current = {
      baseWindowPointCount,
      pointIntervalMinutes,
      resetKey,
    };

    if (previousTimelineZoomContext.resetKey !== resetKey) {
      return;
    }

    if (
      previousTimelineZoomContext.baseWindowPointCount === baseWindowPointCount &&
      previousTimelineZoomContext.pointIntervalMinutes === pointIntervalMinutes
    ) {
      return;
    }

    if (points.length === 0 || focusedMarkerId !== null || requestedFocusedMarker !== null || requestedFocusedMarkerId) {
      return;
    }

    const previousPrecisionContext = previousPrecisionContextRef.current;

    if (previousPrecisionContext.points.length === 0) {
      return;
    }

    const previousWindowPointCount = activeWindowPointCountRef.current;
    const previousWindowStart = windowStartRef.current;
    const previousVisibleDurationMinutes = Math.max(
      Math.max(previousWindowPointCount - 1, 0) * previousTimelineZoomContext.pointIntervalMinutes,
      previousTimelineZoomContext.pointIntervalMinutes,
    );
    const nextVisibleDurationMinutes = Math.max(
      Math.max(baseWindowPointCount - 1, 0) * pointIntervalMinutes,
      pointIntervalMinutes,
    );
    const previousWindowCenterIndex = previousWindowStart + Math.max(previousWindowPointCount - 1, 0) / 2;
    const previousCenterPointsFromNewest = Math.max(
      previousPrecisionContext.points.length - 1 - previousWindowCenterIndex,
      0,
    );
    const previousCenterMinutesFromLatest =
      previousCenterPointsFromNewest * previousTimelineZoomContext.pointIntervalMinutes;
    const nextCenterIndex = clamp(
      Math.round(
        Math.max(points.length - 1 - previousCenterMinutesFromLatest / Math.max(pointIntervalMinutes, 1 / 60), 0),
      ),
      0,
      Math.max(points.length - 1, 0),
    );
    const nextMaxWindowStart = Math.max(0, points.length - baseWindowPointCount);
    const clampedWindowStart = clamp(
      Math.round(nextCenterIndex - Math.max(baseWindowPointCount - 1, 0) / 2),
      0,
      nextMaxWindowStart,
    );
    const targetZoomScale = getHeartViewportZoomScale(plotBaseWindowPointCount, baseWindowPointCount);
    const finalAnchorScreenX =
      targetZoomScale * (nextCenterIndex - clampedWindowStart) * chartPointSpacing;
    const centerAnchorScreenX = viewportWidth > 0 ? viewportWidth / 2 : finalAnchorScreenX;
    const shouldPanAfterZoom =
      viewportWidth > 0 && Math.abs(finalAnchorScreenX - centerAnchorScreenX) > chartPointSpacing / 2;
    const hasViewportDurationChange =
      Math.abs(nextVisibleDurationMinutes - previousVisibleDurationMinutes) > Number.EPSILON;
    const previousVisibleDomain =
      buildVisibleHeartDomain(previousPrecisionContext.points, previousWindowPointCount, previousWindowStart) ??
      buildTrendDomain(previousPrecisionContext.points as TrendPoint[], { mode: 'line' });
    const nextVisibleDomain = buildVisibleHeartDomain(points, baseWindowPointCount, clampedWindowStart) ?? baseDomain;
    const presetZoomTransitionDurationMs = shouldPanAfterZoom
      ? FOCUS_ZOOM_DURATION_MS + SNAP_DURATION_MS
      : FOCUS_ZOOM_DURATION_MS;

    pendingLoadMoreRef.current = false;
    loadRequested.value = false;
    commitSelection(null);
    releaseScrollLock();
    cancelAnimation(animatedWindowStart);
    cancelAnimation(viewportZoomScale);
    cancelAnimation(viewportZoomAnchorScreenX);
    isAxisDragging.value = false;
    clearFocusTransitionTimeout();
    clearPresetZoomTransitionTimeout();
    isFocusDomainSourceFrozen.value = 0;
    cancelAnimation(timelineDomainTransitionProgress);
    previousWindowBeforeFocusRef.current = null;

    if (
      previousTimelineZoomContext.pointIntervalMinutes !== pointIntervalMinutes &&
      previousVisibleDomain &&
      nextVisibleDomain
    ) {
      timelineSourceDomainMin.value = previousVisibleDomain.min;
      timelineSourceDomainMax.value = previousVisibleDomain.max;
      timelineTargetDomainMin.value = nextVisibleDomain.min;
      timelineTargetDomainMax.value = nextVisibleDomain.max;
      isTimelineDomainSourceFrozen.value = 1;
      timelineDomainTransitionProgress.value = 0;
      timelineDomainTransitionProgress.value = withTiming(
        1,
        {
          duration: Y_AXIS_LAG_DURATION_MS,
          easing: Easing.out(Easing.cubic),
        },
        (finished) => {
          if (!finished) {
            return;
          }

          isTimelineDomainSourceFrozen.value = 0;
        },
      );
    } else {
      isTimelineDomainSourceFrozen.value = 0;
      timelineDomainTransitionProgress.value = 1;
    }

    if (hasViewportDurationChange) {
      reportPresetZoomTransitionStateChange(true);
      schedulePresetZoomTransitionSettled(presetZoomTransitionDurationMs);
    } else {
      reportPresetZoomTransitionStateChange(false);
    }

    activeWindowPointCountRef.current = baseWindowPointCount;
    windowStartRef.current = clampedWindowStart;
    gestureStartWindowStart.value = clampedWindowStart;
    reportedWindowStart.value = clampedWindowStart;
    viewportZoomAnchorIndex.value = nextCenterIndex;
    animatedWindowStart.value = clampedWindowStart;
    viewportZoomAnchorScreenX.value = centerAnchorScreenX;

    startTransition(() => {
      setActiveWindowPointCount(baseWindowPointCount);
      setFocusedMarkerId(null);
      setWindowStart(clampedWindowStart);
    });

    viewportZoomScale.value = withTiming(targetZoomScale, {
      duration: FOCUS_ZOOM_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    });
    viewportZoomAnchorScreenX.value = shouldPanAfterZoom
      ? withDelay(
          FOCUS_ZOOM_DURATION_MS,
          withTiming(finalAnchorScreenX, {
            duration: SNAP_DURATION_MS,
            easing: Easing.out(Easing.cubic),
          }),
        )
      : withTiming(finalAnchorScreenX, {
          duration: FOCUS_ZOOM_DURATION_MS,
          easing: Easing.out(Easing.cubic),
        });
  }, [
    animatedWindowStart,
    baseWindowPointCount,
    cancelAnimation,
    chartPointSpacing,
    clearFocusTransitionTimeout,
    clearPresetZoomTransitionTimeout,
    commitSelection,
    focusedMarkerId,
    gestureStartWindowStart,
    isAxisDragging,
    isFocusDomainSourceFrozen,
    loadRequested,
    pointIntervalMinutes,
    plotBaseWindowPointCount,
    timelineDomainTransitionProgress,
    timelineSourceDomainMax,
    timelineSourceDomainMin,
    timelineTargetDomainMax,
    timelineTargetDomainMin,
    isTimelineDomainSourceFrozen,
    points.length,
    releaseScrollLock,
    reportPresetZoomTransitionStateChange,
    reportedWindowStart,
    resetKey,
    requestedFocusedMarker,
    requestedFocusedMarkerId,
    schedulePresetZoomTransitionSettled,
    baseDomain,
    viewportWidth,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
    viewportZoomScale,
  ]);

  useEffect(() => {
    if (points.length === 0) {
      commitSelection(null);
      releaseScrollLock();
    }
  }, [commitSelection, points.length, releaseScrollLock]);

  useEffect(() => {
    if (jumpToLatestSignal === undefined) {
      return;
    }

    if (previousJumpToLatestSignalRef.current === jumpToLatestSignal) {
      return;
    }

    previousJumpToLatestSignalRef.current = jumpToLatestSignal;

    handleJumpToLatest();
  }, [handleJumpToLatest, jumpToLatestSignal]);

  useEffect(() => {
    skipLatestWindowChangeRef.current = true;
  }, [points, resetKey]);

  useEffect(() => {
    latestActivityDraftRef.current = activityDraft;
  }, [activityDraft]);

  useEffect(() => {
    if (skipLatestWindowChangeRef.current) {
      skipLatestWindowChangeRef.current = false;
      return;
    }

    onViewingLatestWindowChange?.(isViewingLatestWindow);
  }, [isViewingLatestWindow, onViewingLatestWindowChange]);

  useEffect(() => {
    onViewportWindowChange?.({
      windowPointCount: safeWindowPointCount,
      windowStart,
    });
  }, [onViewportWindowChange, safeWindowPointCount, windowStart]);

  useEffect(() => {
    if (focusedMarker === null && (requestedFocusedMarker !== null || requestedFocusedMarkerId)) {
      return;
    }

    onFocusedMarkerChange?.(focusedMarker);
  }, [focusedMarker, onFocusedMarkerChange, requestedFocusedMarker, requestedFocusedMarkerId]);

  useEffect(() => {
    cancelAnimation(focusTransitionProgress);
    focusTransitionProgress.value = withTiming(
      focusedMarkerId !== null ? 1 : 0,
      {
        duration: FOCUS_ZOOM_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        if (!finished) {
          return;
        }

        isFocusDomainSourceFrozen.value = 0;
      },
    );
  }, [cancelAnimation, focusTransitionProgress, focusedMarkerId, isFocusDomainSourceFrozen]);

  useEffect(() => {
    const nextDomain = focusedMarkerDomain ?? baseDomain;

    if (!nextDomain) {
      return;
    }

    cancelAnimation(focusedDomainMin);
    cancelAnimation(focusedDomainMax);
    focusedDomainMin.value = withTiming(nextDomain.min, {
      duration: Y_AXIS_LAG_DURATION_MS + 40,
      easing: Easing.out(Easing.cubic),
    });
    focusedDomainMax.value = withTiming(nextDomain.max, {
      duration: Y_AXIS_LAG_DURATION_MS + 40,
      easing: Easing.out(Easing.cubic),
    });
  }, [baseDomain, cancelAnimation, focusedDomainMax, focusedDomainMin, focusedMarkerDomain]);

  useEffect(
    () => () => {
      clearFocusTransitionTimeout();
      clearPresetZoomTransitionTimeout();
    },
    [clearFocusTransitionTimeout, clearPresetZoomTransitionTimeout],
  );

  useEffect(() => releaseScrollLock, [releaseScrollLock]);

  const shouldCaptureScrub = useCallback(
    (_: unknown, gestureState: { dx: number; dy: number }) =>
      activityDraft === null && Math.abs(gestureState.dx) > 6 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
    [activityDraft],
  );

  const applyActivityDraftGesture = useCallback(
    (mode: 'move' | 'resize-start' | 'resize-end', dx: number) => {
      const origin = draftGestureOriginRef.current;
      if (!origin || pointSpacing <= 0) {
        return;
      }

      const minuteSpacing = pointSpacing / pointIntervalMinutes;
      if (minuteSpacing <= 0) {
        return;
      }

      const deltaMinutes = Math.round(dx / minuteSpacing);
      const visibleWindowStartMinuteOffset = windowStartRef.current * pointIntervalMinutes;
      const visibleWindowEndMinuteOffset = Math.max(
        visibleWindowStartMinuteOffset + MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
        (windowStartRef.current + safeWindowPointCount - 1) * pointIntervalMinutes,
      );
      const originSpanMinutes = Math.max(
        origin.endMinuteOffset - origin.startMinuteOffset,
        MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
      );

      let nextStartMinuteOffset = origin.startMinuteOffset;
      let nextEndMinuteOffset = origin.endMinuteOffset;

      if (mode === 'move') {
        nextStartMinuteOffset = clamp(
          origin.startMinuteOffset + deltaMinutes,
          visibleWindowStartMinuteOffset,
          Math.max(visibleWindowStartMinuteOffset, visibleWindowEndMinuteOffset - originSpanMinutes),
        );
        nextEndMinuteOffset = nextStartMinuteOffset + originSpanMinutes;
      } else if (mode === 'resize-start') {
        nextStartMinuteOffset = clamp(
          origin.startMinuteOffset + deltaMinutes,
          visibleWindowStartMinuteOffset,
          origin.endMinuteOffset - MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
        );
      } else {
        nextEndMinuteOffset = clamp(
          origin.endMinuteOffset + deltaMinutes,
          origin.startMinuteOffset + MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
          visibleWindowEndMinuteOffset,
        );
      }

      if (
        nextStartMinuteOffset === origin.startMinuteOffset &&
        nextEndMinuteOffset === origin.endMinuteOffset
      ) {
        return;
      }

      onActivityDraftChange?.({
        ...origin,
        endMinuteOffset: nextEndMinuteOffset,
        startMinuteOffset: nextStartMinuteOffset,
      });
    },
    [onActivityDraftChange, pointIntervalMinutes, pointSpacing, safeWindowPointCount],
  );

  const finalizeActivityDraftGesture = useCallback(() => {
    draftGestureOriginRef.current = latestActivityDraftRef.current;
    releaseScrollLock();
  }, [releaseScrollLock]);

  const createActivityDraftResponder = useCallback(
    (mode: 'move' | 'resize-start' | 'resize-end') =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => latestActivityDraftRef.current !== null,
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          latestActivityDraftRef.current !== null && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: () => {
          ensureScrollLock();
          draftGestureOriginRef.current = latestActivityDraftRef.current;
          commitSelection(null);
        },
        onPanResponderMove: (_event, gestureState) => {
          applyActivityDraftGesture(mode, gestureState.dx);
        },
        onPanResponderRelease: finalizeActivityDraftGesture,
        onPanResponderTerminate: finalizeActivityDraftGesture,
        onPanResponderTerminationRequest: () => false,
      }),
    [applyActivityDraftGesture, commitSelection, ensureScrollLock, finalizeActivityDraftGesture],
  );

  const activityDraftBodyResponder = useMemo(
    () => createActivityDraftResponder('move'),
    [createActivityDraftResponder],
  );
  const activityDraftStartHandleResponder = useMemo(
    () => createActivityDraftResponder('resize-start'),
    [createActivityDraftResponder],
  );
  const activityDraftEndHandleResponder = useMemo(
    () => createActivityDraftResponder('resize-end'),
    [createActivityDraftResponder],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: shouldCaptureScrub,
        onMoveShouldSetPanResponderCapture: shouldCaptureScrub,
        onPanResponderGrant: (event) => {
          ensureScrollLock();
          updateSelection(event.nativeEvent.locationX);
        },
        onPanResponderMove: (event) => {
          updateSelection(event.nativeEvent.locationX);
        },
        onPanResponderRelease: () => {
          commitSelection(null);
          releaseScrollLock();
        },
        onPanResponderTerminate: () => {
          commitSelection(null);
          releaseScrollLock();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [commitSelection, ensureScrollLock, releaseScrollLock, shouldCaptureScrub, updateSelection],
  );

  const axisPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isFocusedWindow)
        .activeOffsetX([-2, 2])
        .failOffsetY([-12, 12])
        .onStart(() => {
          cancelAnimation(animatedWindowStart);
          cancelAnimation(viewportZoomScale);
          cancelAnimation(viewportZoomAnchorScreenX);
          isAxisDragging.value = true;
          gestureStartWindowStart.value = animatedWindowStart.value;
          viewportZoomAnchorIndex.value = animatedWindowStart.value;
          viewportZoomAnchorScreenX.value = 0;
          reportedWindowStart.value = clamp(Math.floor(animatedWindowStart.value), 0, maxWindowStartValue.value);
          runOnJS(handleAxisPanStart)();
        })
        .onUpdate((event) => {
          const nextSafePointSpacing = chartPointSpacingValue.value;
          if (nextSafePointSpacing <= 0) {
            return;
          }

          const nextWindowStartFloat = clamp(
            gestureStartWindowStart.value - event.translationX / nextSafePointSpacing,
            0,
            maxWindowStartValue.value,
          );
          const nextWindowStart = clamp(Math.floor(nextWindowStartFloat), 0, maxWindowStartValue.value);

          animatedWindowStart.value = nextWindowStartFloat;
          viewportZoomAnchorIndex.value = nextWindowStartFloat;

          if (nextWindowStart !== reportedWindowStart.value) {
            reportedWindowStart.value = nextWindowStart;
            runOnJS(syncWindowStart)(nextWindowStart);
          }

          if (
            !loadRequested.value &&
            shouldTriggerHeartLoadMore({
              canLoadMore: canLoadMore && !isFocusedWindow,
              isLoadingMore,
              windowStart: nextWindowStartFloat,
              translationX: event.translationX,
            })
          ) {
            loadRequested.value = true;
            runOnJS(handleLoadMore)();
          }
        })
        .onFinalize(() => {
          isAxisDragging.value = false;
          const snappedWindowStart = clamp(Math.round(animatedWindowStart.value), 0, maxWindowStartValue.value);
          reportedWindowStart.value = snappedWindowStart;
          animatedWindowStart.value = withTiming(snappedWindowStart, { duration: SNAP_DURATION_MS });
          runOnJS(syncWindowStart)(snappedWindowStart);
          runOnJS(handleAxisPanEnd)();
        }),
    [
      animatedWindowStart,
      canLoadMore,
      cancelAnimation,
      gestureStartWindowStart,
      handleAxisPanEnd,
      handleAxisPanStart,
      handleLoadMore,
      isFocusedWindow,
      isAxisDragging,
      isLoadingMore,
      loadRequested,
      maxWindowStartValue,
      chartPointSpacingValue,
      reportedWindowStart,
      syncWindowStart,
      viewportZoomScale,
    ],
  );

  const animatedViewportZoomStyle = useAnimatedStyle(
    () => ({
      transform: [{ scaleX: viewportZoomScale.value }],
    }),
    [viewportZoomScale],
  );

  const animatedViewportCameraStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: viewportZoomAnchorScreenX.value }],
    }),
    [viewportZoomAnchorScreenX],
  );

  const animatedChartContentStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: -viewportZoomAnchorIndex.value * chartPointSpacingValue.value }],
    }),
    [chartPointSpacingValue, viewportZoomAnchorIndex],
  );

  const animatedMarkerLayerStyle = useAnimatedStyle(
    () => ({
      opacity: 1 - focusTransitionProgress.value,
    }),
    [focusTransitionProgress],
  );

  if (points.length === 0) {
    return null;
  }

  const [gradientStart, gradientEnd] = colorStops(accentColor);
  const shadowColor = chartShadowColor(accentColor);

  useRenderTrace(`chart.heart.container.${chartTestID ?? 'default'}`, {
    activeWindowPointCount,
    highlightedSleepStage: highlightedSleepStage ?? 'none',
    markers: markers.length,
    pointIntervalMinutes,
    points: points.length,
    plotBaseWindowPointCount,
    requestedFocusedMarkerId: requestedFocusedMarkerId ?? 'none',
    selectionIndex,
    viewportHeight: Math.round(viewportHeight),
    viewportWidth: Math.round(viewportWidth),
    windowPointCount: baseWindowPointCount,
    windowStart,
    zoomedMarker: focusedMarkerId ?? 'none',
  });

  return (
    <View>
      <View
        onLayout={(event) => {
          setViewportWidth(event.nativeEvent.layout.width);
          setViewportHeight(event.nativeEvent.layout.height);
        }}
        style={[styles.chartArea, { height }]}
        testID={chartTestID ? `${chartTestID}-viewport` : undefined}>
        <View style={styles.chartViewport}>
          {markerVisuals.length > 0 ? (
            <View pointerEvents="none" style={styles.markerBandViewport}>
              <Animated.View pointerEvents="none" style={[styles.chartCameraLayer, animatedViewportCameraStyle]}>
                <Animated.View pointerEvents="none" style={[styles.chartZoomLayer, animatedViewportZoomStyle]}>
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.chartContent,
                      animatedChartContentStyle,
                      { width: chartContentWidth },
                    ]}>
                    <Animated.View pointerEvents="none" style={[styles.markerBandLayer, animatedMarkerLayerStyle]}>
                      {markerVisuals.map((marker) => (
                        <View
                          key={`marker-band-${marker.id}`}
                          style={[
                            styles.markerBand,
                            {
                              backgroundColor: marker.backgroundColor,
                              borderRadius: markerBandRadius,
                              height: markerBandHeight,
                              left: marker.startX,
                              top: markerBandTop,
                              width: marker.bandWidth,
                            },
                          ]}
                        />
                      ))}
                    </Animated.View>
                  </Animated.View>
                </Animated.View>
              </Animated.View>
            </View>
          ) : null}
          <HeartChartSvgPlot
            activeSleepStageColor={activeSleepStageColor}
            areas={areas}
            bridgePaths={bridgePaths}
            chartContentWidth={chartContentWidth}
            chartEndX={chartEndX}
            chartId={chartId}
            chartPointSpacingValue={chartPointSpacingValue}
            chartTestID={chartTestID}
            gradientEnd={gradientEnd}
            gradientStart={gradientStart}
            guideLineY={guideLineY}
            paths={paths}
            shadowColor={shadowColor}
            sleepStageHighlightClipId={sleepStageHighlightClipId}
            sleepStageHighlightFillId={sleepStageHighlightFillId}
            sleepStageHighlights={sleepStageHighlights}
            viewportWidth={viewportWidth}
            viewportZoomAnchorIndex={viewportZoomAnchorIndex}
            viewportZoomAnchorScreenX={viewportZoomAnchorScreenX}
            viewportZoomScale={viewportZoomScale}
          />
          <View collapsable={false} style={styles.overlay} testID={chartTestID} {...panResponder.panHandlers}>
            <ChartScrubOverlay
              backgroundColor={colors.background}
              chartHeight={viewportHeight}
              chartWidth={viewportWidth}
              dotTestID={chartTestID ? `${chartTestID}-active-dot` : undefined}
              dotX={selectionX}
              dotY={selectionY}
              guideTestID={chartTestID ? `${chartTestID}-active-guide` : undefined}
              lineBottom={TREND_VIEWBOX_BASELINE}
              lineOpacity={0.35}
              lineTop={2}
              lineX={selectionX}
              strokeColor={accentColor}
              viewBoxHeight={HEART_CHART_VIEWBOX_HEIGHT}
              viewBoxWidth={100}
            />
          </View>
          {activityDraftVisual && activityDraft ? (
            <View pointerEvents="box-none" style={styles.activityDraftLayer}>
              <View
                pointerEvents="none"
                style={[
                  styles.activityDraftBand,
                  {
                    backgroundColor: activityDraftFillColor,
                    borderColor: activityDraftAccentColor,
                    height: activityDraftVisual.bandHeight,
                    left: activityDraftVisual.startX,
                    top: activityDraftVisual.bandTop,
                    width: activityDraftVisual.bandWidth,
                  },
                ]}
                testID={chartTestID ? `${chartTestID}-draft-band` : undefined}
              />
              {activityDraftBadgeMarker ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.activityDraftInlineBadgeWrap,
                    {
                      left: activityDraftVisual.inlineBadgeLeft,
                      top: activityDraftVisual.inlineBadgeTop,
                    },
                  ]}
                  testID={activityDraftBadgeMarker.testID}>
                  <View
                    style={[
                      styles.activityDraftInlineBadge,
                      { borderColor: activityDraftBadgeMarker.accentColor },
                    ]}>
                    <Ionicons color={activityDraftBadgeMarker.accentColor} name={activityDraftBadgeMarker.iconName} size={12} />
                  </View>
                </View>
              ) : null}
              <View
                style={[
                  styles.activityDraftDragBody,
                  {
                    height: activityDraftVisual.bandHeight,
                    left: activityDraftVisual.bodyLeft,
                    top: activityDraftVisual.bandTop,
                    width: activityDraftVisual.bodyWidth,
                  },
                ]}
                testID={chartTestID ? `${chartTestID}-draft-body` : undefined}
                {...activityDraftBodyResponder.panHandlers}
              />
              <View
                style={[
                  styles.activityDraftHandle,
                  {
                    height: activityDraftVisual.handleHeight,
                    left: activityDraftVisual.startHandleLeft,
                    top: activityDraftVisual.handleTop,
                  },
                ]}
                testID={chartTestID ? `${chartTestID}-draft-start-handle` : undefined}
                {...activityDraftStartHandleResponder.panHandlers}>
                <View
                  pointerEvents="none"
                  style={[
                    styles.activityDraftHandleGrip,
                    { backgroundColor: activityDraftAccentColor },
                  ]}
                />
              </View>
              <View
                style={[
                  styles.activityDraftHandle,
                  {
                    height: activityDraftVisual.handleHeight,
                    left: activityDraftVisual.endHandleLeft,
                    top: activityDraftVisual.handleTop,
                  },
                ]}
                testID={chartTestID ? `${chartTestID}-draft-end-handle` : undefined}
                {...activityDraftEndHandleResponder.panHandlers}>
                <View
                  pointerEvents="none"
                  style={[
                    styles.activityDraftHandleGrip,
                    { backgroundColor: activityDraftAccentColor },
                  ]}
                />
              </View>
            </View>
          ) : null}
          <View pointerEvents={isFocusedWindow || activityDraft ? 'none' : 'box-none'} style={styles.markerViewport}>
            <Animated.View pointerEvents="box-none" style={[styles.chartCameraLayer, animatedViewportCameraStyle]}>
              <Animated.View pointerEvents="box-none" style={[styles.chartZoomLayer, animatedViewportZoomStyle]}>
                <Animated.View
                  pointerEvents="box-none"
                  style={[styles.chartContent, animatedChartContentStyle, { width: chartContentWidth }]}
                  testID={chartTestID ? `${chartTestID}-content` : undefined}>
                  {hasTopMarkers ? (
                    <Animated.View pointerEvents="box-none" style={[styles.markerLayer, animatedMarkerLayerStyle]}>
                      {markerVisuals.map((marker) => (
                        <HeartMarkerBadge
                          key={`marker-badge-${marker.id}`}
                          marker={marker}
                          onPress={marker.isZoomable ? () => handleMarkerZoomPress(marker) : undefined}
                          zoomScale={viewportZoomScale}
                        />
                      ))}
                    </Animated.View>
                  ) : null}
                </Animated.View>
              </Animated.View>
            </Animated.View>
          </View>
          {selectionPoint ? (
            <View
              pointerEvents="none"
              style={[
                styles.selectionBubbleWrap,
                selectionX !== null && selectionX > 50 ? styles.selectionBubbleWrapLeft : styles.selectionBubbleWrapRight,
                { top: hasTopMarkers ? 36 : 6 },
              ]}>
              <ChartSelectionBubble
                accentColor={accentColor}
                label={selectionPoint.label}
                size="compact"
                testID={chartTestID ? `${chartTestID}-selection-bubble` : undefined}
                value={formatHeartSelectionValue(selectionPoint.value)}
              />
            </View>
          ) : null}
        </View>
      </View>
      <GestureDetector gesture={axisPanGesture}>
        <View style={styles.axis} testID={axisTestID}>
          {axisLabels.map((label, index) => (
            <Text key={`${label ?? 'axis'}-${index}`} style={styles.axisLabel}>
              {label ?? ''}
            </Text>
          ))}
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  chartArea: {
    position: 'relative',
    width: '100%',
  },
  chartViewport: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  markerBandViewport: {
    ...StyleSheet.absoluteFillObject,
  },
  markerViewport: {
    ...StyleSheet.absoluteFillObject,
  },
  chartCameraLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  chartZoomLayer: {
    ...StyleSheet.absoluteFillObject,
    transformOrigin: 'left center',
  },
  chartContent: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
  },
  chartCanvas: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  activityDraftLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 4,
  },
  activityDraftBand: {
    borderRadius: 6,
    borderStyle: 'dashed',
    borderWidth: 1,
    position: 'absolute',
  },
  activityDraftInlineBadgeWrap: {
    height: MARKER_BADGE_SIZE,
    position: 'absolute',
    width: MARKER_BADGE_SIZE,
  },
  activityDraftInlineBadge: {
    alignItems: 'center',
    backgroundColor: colors.surfaceStrong,
    borderRadius: 999,
    borderWidth: 1,
    height: MARKER_BADGE_SIZE,
    justifyContent: 'center',
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.22,
    shadowRadius: 4,
    width: MARKER_BADGE_SIZE,
  },
  activityDraftDragBody: {
    position: 'absolute',
  },
  activityDraftHandle: {
    alignItems: 'center',
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    position: 'absolute',
    width: ACTIVITY_DRAFT_HANDLE_WIDTH,
  },
  activityDraftHandleGrip: {
    borderRadius: 999,
    height: 16,
    width: 3,
  },
  selectionBubbleWrap: {
    left: 10,
    position: 'absolute',
    right: 10,
    zIndex: 3,
  },
  selectionBubbleWrapLeft: {
    alignItems: 'flex-start',
  },
  selectionBubbleWrapRight: {
    alignItems: 'flex-end',
  },
  markerLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  markerBandLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  markerBand: {
    position: 'absolute',
  },
  markerBadgeWrap: {
    height: MARKER_BADGE_SIZE,
    position: 'absolute',
    width: MARKER_BADGE_SIZE,
  },
  markerBadge: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    height: MARKER_BADGE_SIZE,
    justifyContent: 'center',
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.22,
    shadowRadius: 4,
    width: MARKER_BADGE_SIZE,
  },
  markerBadgePressed: {
    opacity: 0.82,
  },
  axis: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -4,
    minHeight: 30,
    paddingBottom: 6,
    paddingTop: 8,
  },
  axisLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
  },
});
