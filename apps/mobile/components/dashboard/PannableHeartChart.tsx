import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Line,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import {
  TREND_VIEWBOX_BASELINE,
  buildTrendDomain,
  mapTrendValueToY,
} from '@/components/charts/chartSelection';
import { useAcquireScreenScrollLock } from '@/components/layout/ScreenScrollContext';
import { colors, typography } from '@/constants/theme';
import type { HeartIntradayMarker, TrendPoint } from '@/types/health';
import { mapHeartIntradayMarkersToTrendMarkers } from '@/utils/heartChartMarkers';

const LOAD_MORE_EDGE_THRESHOLD_POINTS = 2;
const LOAD_MORE_TRIGGER_DRAG_PX = 18;
const SNAP_DURATION_MS = 110;
const HEART_CHART_VIEWBOX_HEIGHT = 40;
const MARKER_BADGE_SIZE = 24;
const MIN_MARKER_BAND_WIDTH = 0.15;

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

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
    case colors.cyan:
      return [colors.cyan, colors.primary];
    default:
      return [colors.cyan, colors.primary];
  }
}

function buildLine(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function buildLineSegments(coordinates: Array<{ x: number; y: number | null }>) {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];

  for (const coordinate of coordinates) {
    if (coordinate.y === null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }

    current.push({ x: coordinate.x, y: coordinate.y });
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function buildHeartCoordinates(points: TrendPoint[], domain: ReturnType<typeof buildTrendDomain>) {
  return points.map((point, index) => ({
    x: index,
    y: point.value === null || !domain ? null : mapTrendValueToY(point.value, domain),
  }));
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
  centerIndex: number;
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  id: string;
  startX: number;
  testID?: string;
}

function HeartMarkerBadge({
  marker,
  pointSpacingValue,
  windowStartValue,
}: {
  marker: HeartMarkerVisual;
  pointSpacingValue: SharedValue<number>;
  windowStartValue: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(
    () => ({
      opacity: pointSpacingValue.value > 0 ? 1 : 0,
      transform: [
        {
          translateX:
            (marker.centerIndex - windowStartValue.value) * pointSpacingValue.value - MARKER_BADGE_SIZE / 2,
        },
      ],
    }),
    [marker.centerIndex, pointSpacingValue, windowStartValue],
  );

  return (
    <Animated.View
      accessibilityLabel={marker.accessibilityLabel}
      style={[
        styles.markerBadge,
        animatedStyle,
        {
          backgroundColor: colors.surfaceStrong,
          borderColor: marker.accentColor,
          top: 8,
        },
      ]}
      testID={marker.testID}>
      <Ionicons color={marker.accentColor} name={marker.iconName} size={12} />
    </Animated.View>
  );
}

export function PannableHeartChart({
  accentColor = colors.primary,
  axisTestID,
  canLoadMore = false,
  chartTestID,
  height = 150,
  isLoadingMore = false,
  markers = [],
  onLoadMore,
  points,
  resetKey,
  windowPointCount,
}: {
  accentColor?: string;
  axisTestID?: string;
  canLoadMore?: boolean;
  chartTestID?: string;
  height?: number;
  isLoadingMore?: boolean;
  markers?: readonly HeartIntradayMarker[];
  onLoadMore?: () => void;
  points: TrendPoint[];
  resetKey?: string;
  windowPointCount: number;
}) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const safeWindowPointCount = Math.min(Math.max(windowPointCount, 2), Math.max(points.length, 1));
  const maxWindowStart = Math.max(0, points.length - safeWindowPointCount);
  const [windowStart, setWindowStart] = useState(maxWindowStart);
  const windowStartRef = useRef(maxWindowStart);
  const maxWindowStartRef = useRef(maxWindowStart);
  maxWindowStartRef.current = maxWindowStart;
  const [selectionIndex, setSelectionIndex] = useState<number | null>(null);
  const selectionRef = useRef<number | null>(null);
  const releaseScrollLockRef = useRef<(() => void) | null>(null);
  const previousPointCountRef = useRef(points.length);
  const pendingLoadMoreRef = useRef(false);
  const chartId = useId().replace(/[:]/g, '');
  const acquireScreenScrollLock = useAcquireScreenScrollLock();

  const animatedWindowStart = useSharedValue(maxWindowStart);
  const gestureStartWindowStart = useSharedValue(windowStart);
  const reportedWindowStart = useSharedValue(windowStart);
  const pointSpacingValue = useSharedValue(0);
  const maxWindowStartValue = useSharedValue(maxWindowStart);
  const isAxisDragging = useSharedValue(false);
  const loadRequested = useSharedValue(false);

  const pointSpacing = getHeartViewportPointSpacing(viewportWidth, safeWindowPointCount);
  const viewBoxWidth = getHeartViewBoxWidth(safeWindowPointCount);
  const visiblePoints = useMemo(
    () => points.slice(windowStart, windowStart + safeWindowPointCount),
    [points, safeWindowPointCount, windowStart],
  );

  const domain = useMemo(() => buildTrendDomain(points, { mode: 'line' }), [points]);
  const coordinates = useMemo(() => buildHeartCoordinates(points, domain), [domain, points]);
  const lineSegments = useMemo(() => buildLineSegments(coordinates), [coordinates]);
  const paths = useMemo(() => lineSegments.map((segment) => buildLine(segment)), [lineSegments]);
  const areas = useMemo(
    () =>
      lineSegments
        .filter((segment) => segment.length >= 2)
        .map((segment) => {
          const path = buildLine(segment);
          const startX = segment[0]?.x ?? 0;
          const endX = segment.at(-1)?.x ?? startX;
          return `${path} L ${endX} ${TREND_VIEWBOX_BASELINE} L ${startX} ${TREND_VIEWBOX_BASELINE} Z`;
        }),
    [lineSegments],
  );
  const chartEndX = Math.max(points.length - 1, viewBoxWidth);
  const guideLineY =
    domain && domain.min < 0 && domain.max > 0
      ? mapTrendValueToY(0, domain)
      : 24;
  const selectionPoint = selectionIndex === null ? null : points[selectionIndex] ?? null;
  const selectionY = selectionPoint && selectionPoint.value !== null && domain
    ? mapTrendValueToY(selectionPoint.value, domain)
    : null;
  const selectionX =
    selectionIndex !== null &&
    selectionIndex >= windowStart &&
    selectionIndex <= windowStart + viewBoxWidth
      ? safeWindowPointCount <= 1
        ? 50
        : ((selectionIndex - windowStart) / viewBoxWidth) * 100
      : null;

  const fullSeriesSpan = Math.max(points.length - 1, 1);
  const markerVisuals = useMemo(
    () =>
      mapHeartIntradayMarkersToTrendMarkers(markers).map((marker) => {
        const startFraction = clampFraction(marker.startFraction);
        const endFraction = clampFraction(Math.max(marker.startFraction, marker.endFraction));
        const startX = startFraction * fullSeriesSpan;
        const endX = endFraction * fullSeriesSpan;
        const midpoint = clampFraction((startFraction + endFraction) / 2) * fullSeriesSpan;

        return {
          ...marker,
          bandWidth: Math.max(endX - startX, MIN_MARKER_BAND_WIDTH),
          centerIndex: midpoint,
          startX,
          testID: chartTestID ? `${chartTestID}-marker-${sanitizeMarkerId(marker.id)}` : undefined,
        } satisfies HeartMarkerVisual;
      }),
    [chartTestID, fullSeriesSpan, markers],
  );

  const axisLabels = useMemo<[string | undefined, string | undefined, string | undefined]>(() => {
    if (visiblePoints.length === 0) {
      return [undefined, undefined, undefined];
    }

    return [
      visiblePoints[0]?.label,
      visiblePoints[Math.floor(visiblePoints.length / 2)]?.label,
      visiblePoints.at(-1)?.label,
    ];
  }, [visiblePoints]);

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
      commitSelection(nextIndex);
    },
    [commitSelection, pointSpacing, points.length, safeWindowPointCount],
  );

  const syncWindowStart = useCallback((nextWindowStart: number) => {
    const clamped = clamp(nextWindowStart, 0, maxWindowStartRef.current);
    windowStartRef.current = clamped;
    setWindowStart((current) => (current === clamped ? current : clamped));
  }, []);

  const handleAxisPanStart = useCallback(() => {
    ensureScrollLock();
    commitSelection(null);
  }, [commitSelection, ensureScrollLock]);

  const handleAxisPanEnd = useCallback(() => {
    releaseScrollLock();
  }, [releaseScrollLock]);

  const handleLoadMore = useCallback(() => {
    pendingLoadMoreRef.current = true;
    onLoadMore?.();
  }, [onLoadMore]);

  useEffect(() => {
    pointSpacingValue.value = pointSpacing;
    maxWindowStartValue.value = maxWindowStart;
  }, [maxWindowStart, maxWindowStartValue, pointSpacing, pointSpacingValue]);

  useEffect(() => {
    const previousPointCount = previousPointCountRef.current;
    const prependedPointCount = points.length - previousPointCount;
    let nextAnimatedWindowStart = clamp(animatedWindowStart.value, 0, maxWindowStart);
    let nextGestureStart = clamp(gestureStartWindowStart.value, 0, maxWindowStart);

    if (pendingLoadMoreRef.current && prependedPointCount > 0) {
      nextAnimatedWindowStart = getRetainedHeartWindowStartAfterGrowth(
        nextAnimatedWindowStart,
        prependedPointCount,
        maxWindowStart,
      );
      nextGestureStart = getRetainedHeartWindowStartAfterGrowth(nextGestureStart, prependedPointCount, maxWindowStart);
      pendingLoadMoreRef.current = false;
      loadRequested.value = false;
    }

    previousPointCountRef.current = points.length;
    animatedWindowStart.value = nextAnimatedWindowStart;
    gestureStartWindowStart.value = nextGestureStart;

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
    syncWindowStart,
  ]);

  useEffect(() => {
    const nextWindowStart = maxWindowStart;

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
  }, [
    animatedWindowStart,
    cancelAnimation,
    commitSelection,
    gestureStartWindowStart,
    isAxisDragging,
    loadRequested,
    reportedWindowStart,
    resetKey,
  ]);

  useEffect(() => {
    if (points.length === 0) {
      commitSelection(null);
      releaseScrollLock();
    }
  }, [commitSelection, points.length, releaseScrollLock]);

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
        .activeOffsetX([-2, 2])
        .failOffsetY([-12, 12])
        .onStart(() => {
          cancelAnimation(animatedWindowStart);
          isAxisDragging.value = true;
          gestureStartWindowStart.value = animatedWindowStart.value;
          reportedWindowStart.value = clamp(Math.floor(animatedWindowStart.value), 0, maxWindowStartValue.value);
          runOnJS(handleAxisPanStart)();
        })
        .onUpdate((event) => {
          const safePointSpacing = pointSpacingValue.value;
          if (safePointSpacing <= 0) {
            return;
          }

          const nextWindowStartFloat = clamp(
            gestureStartWindowStart.value - event.translationX / safePointSpacing,
            0,
            maxWindowStartValue.value,
          );
          const nextWindowStart = clamp(Math.floor(nextWindowStartFloat), 0, maxWindowStartValue.value);

          animatedWindowStart.value = nextWindowStartFloat;

          if (nextWindowStart !== reportedWindowStart.value) {
            reportedWindowStart.value = nextWindowStart;
            runOnJS(syncWindowStart)(nextWindowStart);
          }

          if (
            !loadRequested.value &&
            shouldTriggerHeartLoadMore({
              canLoadMore,
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
      isAxisDragging,
      isLoadingMore,
      loadRequested,
      maxWindowStartValue,
      pointSpacingValue,
      reportedWindowStart,
      syncWindowStart,
    ],
  );

  const animatedSvgProps = useAnimatedProps(
    () => ({
      viewBox: buildHeartChartViewBox(animatedWindowStart.value, safeWindowPointCount),
    }),
    [animatedWindowStart, safeWindowPointCount],
  );

  if (points.length === 0) {
    return null;
  }

  const [gradientStart, gradientEnd] = colorStops(accentColor);

  return (
    <View>
      <View
        onLayout={(event) => {
          setViewportWidth(event.nativeEvent.layout.width);
        }}
        style={[styles.chartArea, { height }]}
        testID={chartTestID ? `${chartTestID}-viewport` : undefined}>
        <View style={styles.chartViewport}>
          <AnimatedSvg
            animatedProps={animatedSvgProps}
            height="100%"
            pointerEvents="none"
            preserveAspectRatio="none"
            testID={chartTestID ? `${chartTestID}-content` : undefined}
            viewBox={buildHeartChartViewBox(windowStart, safeWindowPointCount)}
            width="100%">
            <Defs>
              <SvgLinearGradient id={`${chartId}-stroke`} x1="0%" x2="100%" y1="100%" y2="0%">
                <Stop offset="0%" stopColor={gradientStart} />
                <Stop offset="100%" stopColor={gradientEnd} />
              </SvgLinearGradient>
              <SvgLinearGradient id={`${chartId}-fill`} x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop offset="0%" stopColor={gradientEnd} stopOpacity="0.32" />
                <Stop offset="100%" stopColor={gradientStart} stopOpacity="0.02" />
              </SvgLinearGradient>
            </Defs>
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
            <Line
              stroke="rgba(149, 162, 188, 0.22)"
              strokeDasharray="0.36 0.36"
              strokeWidth="0.7"
              x1={0}
              x2={chartEndX}
              y1={guideLineY}
              y2={guideLineY}
            />
            {areas.map((area, index) => (
              <Path key={`area-${index}`} d={area} fill={`url(#${chartId}-fill)`} />
            ))}
            {paths.map((path, index) => (
              <Path
                key={`shadow-${index}`}
                d={path}
                fill="none"
                stroke="rgba(86, 246, 255, 0.12)"
                strokeWidth="1.6"
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
              />
            ))}
          </AnimatedSvg>
          {markerVisuals.length > 0 ? (
            <View pointerEvents="none" style={styles.markerLayer}>
              {markerVisuals.map((marker) => (
                <HeartMarkerBadge
                  key={`marker-badge-${marker.id}`}
                  marker={marker}
                  pointSpacingValue={pointSpacingValue}
                  windowStartValue={animatedWindowStart}
                />
              ))}
            </View>
          ) : null}
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
                />
              </Svg>
            ) : null}
          </View>
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
  chartContent: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  markerLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  markerBadge: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    height: 24,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    shadowColor: colors.black,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.22,
    shadowRadius: 4,
    width: 24,
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
