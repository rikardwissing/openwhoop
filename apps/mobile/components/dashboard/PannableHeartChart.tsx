import { Ionicons } from '@expo/vector-icons';
import {
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
  useDerivedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, {
  Circle,
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
import { useAcquireScreenScrollLock } from '@/components/layout/ScreenScrollContext';
import { colors, sleepStageColors, typography } from '@/constants/theme';
import type { HeartIntradayMarker, SleepStage, TrendPoint } from '@/types/health';
import { addMinutes, formatShortDate } from '@/utils/dateTime';
import { formatMetricNumber } from '@/utils/formatters';
import { mapHeartIntradayMarkersToTrendMarkers } from '@/utils/heartChartMarkers';

const HEART_POINT_INTERVAL_MINUTES = 5;
const LOAD_MORE_EDGE_THRESHOLD_POINTS = 2;
const LOAD_MORE_TRIGGER_DRAG_PX = 18;
const SNAP_DURATION_MS = 110;
const FOCUS_ZOOM_DURATION_MS = 220;
const Y_AXIS_LAG_DURATION_MS = 180;
const HEART_CHART_VIEWBOX_HEIGHT = 40;
const MARKER_BADGE_SIZE = 24;
const MIN_MARKER_BAND_WIDTH = 0.15;
const AnimatedSvgGroup = Animated.createAnimatedComponent(G) as ComponentType<
  ComponentProps<typeof G> & { animatedProps?: object }
>;

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
      return [colors.heart, colors.primary];
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
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(trimmed);

  if (!match) {
    return null;
  }

  const rawHours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  const meridiem = match[3]?.toUpperCase();

  if (!Number.isFinite(rawHours) || !Number.isFinite(minutes)) {
    return null;
  }

  const normalizedHours = rawHours % 12 + (meridiem === 'PM' ? 12 : 0);
  return normalizedHours * 60 + minutes;
}

export function buildHeartViewportDayLabel(
  points: readonly TrendPoint[],
  windowPointCount: number,
  anchorDayKey?: string,
  windowStart?: number,
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
  const viewportMidpointDate = addMinutes(latestPointDate, -pointsFromNewest * HEART_POINT_INTERVAL_MINUTES);

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
): [string | undefined, string | undefined, string | undefined] {
  if (points.length === 0) {
    return [undefined, undefined, undefined];
  }

  const safeWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const safeWindowStart = clamp(windowStart ?? maxWindowStart, 0, maxWindowStart);
  const visiblePoints = points.slice(safeWindowStart, safeWindowStart + safeWindowPointCount);
  const firstLabel = visiblePoints[0]?.label;
  const viewportDayLabel = buildHeartViewportDayLabel(points, safeWindowPointCount, anchorDayKey, safeWindowStart);
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
    },
  ];

  if (onPress) {
    return (
      <Animated.View pointerEvents="box-none" style={badgeWrapStyle}>
        <Pressable
          accessibilityLabel={`Focus ${marker.label} ${marker.timeLabel}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onPress}
          style={({ pressed }) => [badgeStyle, pressed ? styles.markerBadgePressed : null]}
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

export function PannableHeartChart({
  accentColor = colors.primary,
  anchorDayKey,
  axisTestID,
  canLoadMore = false,
  chartTestID,
  height = 150,
  highlightedSleepStage,
  isLoadingMore = false,
  jumpToLatestSignal,
  markers = [],
  onFocusedMarkerChange,
  onFocusTransitionStateChange,
  onLoadMore,
  onViewingLatestWindowChange,
  points,
  resetKey,
  windowPointCount,
}: {
  accentColor?: string;
  anchorDayKey?: string;
  axisTestID?: string;
  canLoadMore?: boolean;
  chartTestID?: string;
  height?: number;
  highlightedSleepStage?: SleepStage | null;
  isLoadingMore?: boolean;
  jumpToLatestSignal?: number;
  markers?: readonly HeartIntradayMarker[];
  onFocusedMarkerChange?: (marker: HeartIntradayMarker | null) => void;
  onFocusTransitionStateChange?: (isTransitioning: boolean) => void;
  onLoadMore?: () => void;
  onViewingLatestWindowChange?: (isViewingLatestWindow: boolean) => void;
  points: TrendPoint[];
  resetKey?: string;
  windowPointCount: number;
}) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const baseWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
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
  const pendingLoadMoreRef = useRef(false);
  const previousJumpToLatestSignalRef = useRef<number | undefined>(jumpToLatestSignal);
  const skipLatestWindowChangeRef = useRef(true);
  const focusTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const basePointSpacing = getHeartViewportPointSpacing(viewportWidth, baseWindowPointCount);
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
    getHeartViewportContentWidth(viewportWidth, points.length, baseWindowPointCount),
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
          startFraction,
          startX,
          testID: chartTestID ? `${chartTestID}-marker-${sanitizeMarkerId(marker.id)}` : undefined,
          timeLabel: sourceMarker?.timeLabel ?? '',
        } satisfies HeartMarkerVisual;
      }),
    [chartTestID, fullSeriesSpan, markers],
  );

  const axisLabels = useMemo(
    () => buildHeartAxisLabels(points, safeWindowPointCount, anchorDayKey, windowStart),
    [anchorDayKey, points, safeWindowPointCount, windowStart],
  );
  const focusedMarker = useMemo(
    () => markers.find((marker) => marker.id === focusedMarkerId) ?? null,
    [focusedMarkerId, markers],
  );
  const reportFocusTransitionStateChange = useCallback(
    (isTransitioning: boolean) => {
      onFocusTransitionStateChange?.(isTransitioning);
    },
    [onFocusTransitionStateChange],
  );
  const clearFocusTransitionTimeout = useCallback(() => {
    if (focusTransitionTimeoutRef.current === null) {
      return;
    }

    clearTimeout(focusTransitionTimeoutRef.current);
    focusTransitionTimeoutRef.current = null;
  }, []);
  const scheduleFocusTransitionSettled = useCallback(() => {
    clearFocusTransitionTimeout();
    focusTransitionTimeoutRef.current = setTimeout(() => {
      focusTransitionTimeoutRef.current = null;
      reportFocusTransitionStateChange(false);
    }, FOCUS_ZOOM_DURATION_MS);
  }, [clearFocusTransitionTimeout, reportFocusTransitionStateChange]);
  const focusedMarkerDomain = useMemo(
    () => buildHeartMarkerDomain(points, focusedMarker),
    [focusedMarker, points],
  );
  const selectionDomain = focusedMarkerDomain ?? visibleDomain;
  const selectionY = selectionPoint && selectionPoint.value !== null && selectionDomain
    ? mapTrendValueToY(selectionPoint.value, selectionDomain)
    : null;
  const sleepStageHighlights = useMemo(
    () => buildHeartSleepStageHighlights(focusedMarker, highlightedSleepStage, fullSeriesSpan, chartTestID),
    [chartTestID, focusedMarker, fullSeriesSpan, highlightedSleepStage],
  );
  const activeSleepStageColor = highlightedSleepStage ? sleepStageColors[highlightedSleepStage] : null;
  const sleepStageHighlightClipId = highlightedSleepStage ? `${chartId}-stage-highlight-clip-${highlightedSleepStage}` : null;
  const sleepStageHighlightFillId = highlightedSleepStage ? `${chartId}-stage-highlight-fill-${highlightedSleepStage}` : null;
  const sleepStageSelectionRanges = useMemo(
    () => buildHeartSleepStageSelectionRanges(points.length, focusedMarker, highlightedSleepStage),
    [focusedMarker, highlightedSleepStage, points.length],
  );
  const isFocusedWindow = focusedMarkerId !== null || safeWindowPointCount !== baseWindowPointCount;
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
    [commitSelection, pointSpacing, points.length, safeWindowPointCount, sleepStageSelectionRanges],
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
      const nextZoomScale = getHeartViewportZoomScale(baseWindowPointCount, resolvedWindowPointCount);
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
      baseWindowPointCount,
      cancelAnimation,
      chartPointSpacing,
      commitSelection,
      isAxisDragging,
      loadRequested,
      points.length,
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
    const previousMaxWindowStart = Math.max(0, previousPointCount - safeWindowPointCount);
    const pointCountDelta = points.length - previousPointCount;

    if (pointCountDelta === 0) {
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
    gestureStartWindowStart,
    loadRequested,
    maxWindowStart,
    points.length,
    reportedWindowStart,
    safeWindowPointCount,
    syncWindowStart,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
  ]);

  useLayoutEffect(() => {
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
    isFocusDomainSourceFrozen.value = 0;
    viewportZoomScale.value = 1;
    viewportZoomAnchorIndex.value = nextWindowStart;
    viewportZoomAnchorScreenX.value = 0;
  }, [
    animatedWindowStart,
    baseWindowPointCount,
    cancelAnimation,
    chartPointSpacingValue,
    commitSelection,
    gestureStartWindowStart,
    isAxisDragging,
    loadRequested,
    clearFocusTransitionTimeout,
    reportedWindowStart,
    resetKey,
    isFocusDomainSourceFrozen,
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
    if (skipLatestWindowChangeRef.current) {
      skipLatestWindowChangeRef.current = false;
      return;
    }

    onViewingLatestWindowChange?.(isViewingLatestWindow);
  }, [isViewingLatestWindow, onViewingLatestWindowChange]);

  useEffect(() => {
    onFocusedMarkerChange?.(focusedMarker);
  }, [focusedMarker, onFocusedMarkerChange]);

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
    },
    [clearFocusTransitionTimeout],
  );

  useEffect(() => releaseScrollLock, [releaseScrollLock]);

  const shouldCaptureScrub = useCallback(
    (_: unknown, gestureState: { dx: number; dy: number }) =>
      Math.abs(gestureState.dx) > 6 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
    [],
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

  const animatedMarkerFadeProps = useAnimatedProps(
    () => ({
      opacity: 1 - focusTransitionProgress.value,
    }),
    [focusTransitionProgress],
  );

  const animatedMarkerLayerStyle = useAnimatedStyle(
    () => ({
      opacity: 1 - focusTransitionProgress.value,
    }),
    [focusTransitionProgress],
  );

  const animatedDomainWindowStart = useDerivedValue(
    () =>
      withTiming(animatedWindowStart.value, {
        duration: Y_AXIS_LAG_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      }),
    [animatedWindowStart],
  );

  const animatedChartPlotProps = useAnimatedProps(
    () => {
      const animatedVisibleDomain = windowDomains
        ? interpolateHeartDomain(animatedDomainWindowStart.value, windowDomains.mins, windowDomains.maxs)
        : null;
      const transitionSourceDomain =
        isFocusDomainSourceFrozen.value > 0
          ? {
              min: focusSourceDomainMin.value,
              max: focusSourceDomainMax.value,
            }
          : animatedVisibleDomain;
      const focusedDomain =
        isFocusDomainSourceFrozen.value > 0
          ? {
              min: focusTargetDomainMin.value,
              max: focusTargetDomainMax.value,
            }
          : focusedDomainMax.value > focusedDomainMin.value
            ? {
                min: focusedDomainMin.value,
                max: focusedDomainMax.value,
              }
            : null;
      const blendedDomain =
        transitionSourceDomain && focusedDomain
          ? {
              min:
                transitionSourceDomain.min +
                (focusedDomain.min - transitionSourceDomain.min) * focusTransitionProgress.value,
              max:
                transitionSourceDomain.max +
                (focusedDomain.max - transitionSourceDomain.max) * focusTransitionProgress.value,
            }
          : focusedDomain ?? transitionSourceDomain;
      const { scaleY, translateY } = buildHeartDomainAnimation(baseDomain, blendedDomain);

      return {
        matrix: [1, 0, 0, scaleY, 0, translateY],
      };
    },
    [
      animatedDomainWindowStart,
      baseDomain,
      focusTransitionProgress,
      focusSourceDomainMax,
      focusSourceDomainMin,
      focusTargetDomainMax,
      focusTargetDomainMin,
      focusedDomainMax,
      focusedDomainMin,
      isFocusDomainSourceFrozen,
      windowDomains,
    ],
  );

  if (points.length === 0) {
    return null;
  }

  const [gradientStart, gradientEnd] = colorStops(accentColor);
  const shadowColor = chartShadowColor(accentColor);
  const chartPlotClipId = `${chartId}-plot-clip`;

  return (
    <View>
      <View
        onLayout={(event) => {
          setViewportWidth(event.nativeEvent.layout.width);
        }}
        style={[styles.chartArea, { height }]}
        testID={chartTestID ? `${chartTestID}-viewport` : undefined}>
        <View style={styles.chartViewport}>
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
                  <Rect
                    height={HEART_CHART_VIEWBOX_HEIGHT}
                    width={chartContentWidth}
                    x="0"
                    y="0"
                  />
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
                <AnimatedSvgGroup animatedProps={animatedMarkerFadeProps}>
                  {markerVisuals.map((marker) => (
                    <Rect
                      fill={marker.backgroundColor}
                      height="31"
                      key={`marker-band-${marker.id}`}
                      rx="3"
                      ry="3"
                      width={marker.bandWidth}
                      x={marker.startX}
                      y="3"
                    />
                  ))}
                </AnimatedSvgGroup>
                <G clipPath={`url(#${chartPlotClipId})`}>
                  <AnimatedSvgGroup animatedProps={animatedChartPlotProps}>
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
                    <G mask={`url(#${chartId}-fill-mask)`}>
                      {areas.map((area, index) => (
                        <Path key={`area-${index}`} d={area} fill={`url(#${chartId}-fill)`} />
                      ))}
                    </G>
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
                  </AnimatedSvgGroup>
                </G>
              </AnimatedSvgGroup>
            </Svg>
          </Animated.View>
          <View collapsable={false} style={styles.overlay} testID={chartTestID} {...panResponder.panHandlers}>
            {selectionX !== null && selectionY !== null ? (
              <Svg height="100%" pointerEvents="none" preserveAspectRatio="none" viewBox="0 0 100 40" width="100%">
                <Line
                  stroke={accentColor}
                  strokeDasharray="2 2"
                  strokeOpacity="0.35"
                  strokeWidth="0.7"
                  x1={selectionX}
                  x2={selectionX}
                  y1="2"
                  y2={TREND_VIEWBOX_BASELINE}
                />
                <Circle cx={selectionX} cy={selectionY} fill={accentColor} opacity="0.18" r="4.6" />
                <Circle
                  cx={selectionX}
                  cy={selectionY}
                  fill={accentColor}
                  r="1.9"
                  stroke={colors.background}
                  strokeWidth="0.9"
                  testID={chartTestID ? `${chartTestID}-active-dot` : undefined}
                />
              </Svg>
            ) : null}
          </View>
          <View pointerEvents={isFocusedWindow ? 'none' : 'box-none'} style={styles.markerViewport}>
            <Animated.View pointerEvents="box-none" style={[styles.chartCameraLayer, animatedViewportCameraStyle]}>
              <Animated.View pointerEvents="box-none" style={[styles.chartZoomLayer, animatedViewportZoomStyle]}>
                <Animated.View
                  pointerEvents="box-none"
                  style={[styles.chartContent, animatedChartContentStyle, { width: chartContentWidth }]}
                  testID={chartTestID ? `${chartTestID}-content` : undefined}>
                  {markerVisuals.length > 0 ? (
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
                { top: markerVisuals.length > 0 ? 36 : 6 },
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
