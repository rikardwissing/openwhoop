import { Ionicons } from '@expo/vector-icons';
import {
  Canvas,
  DashPathEffect,
  Group as SkiaGroup,
  LinearGradient as SkiaLinearGradient,
  Mask as SkiaMask,
  Path as SkiaPath,
  Skia,
  interpolateColors,
  processTransform2d,
  vec,
} from '@shopify/react-native-skia';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import {
  buildTrendDomain,
  buildTrendLineGeometry,
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

const DEFAULT_HEART_POINT_INTERVAL_MINUTES = 5;
const LOAD_MORE_EDGE_THRESHOLD_POINTS = 2;
const LOAD_MORE_TRIGGER_DRAG_PX = 18;
const SNAP_DURATION_MS = 110;
const SNAP_MAX_DURATION_MS = 720;
const FOCUS_ZOOM_DURATION_MS = 220;
const FOCUS_ZOOM_MAX_DURATION_MS = 420;
const FOCUS_ZOOM_DURATION_PER_OCTAVE_MS = 42;
const Y_AXIS_LAG_DURATION_MS = 180;
const ACTIVITY_DRAFT_FADE_DURATION_MS = 180;
const PINCH_ACTIVATION_PAN_THRESHOLD_PX = 4;
const PINCH_ACTIVATION_SCALE_THRESHOLD = 0.015;
const HEART_CHART_VIEWBOX_HEIGHT = 40;
const HEART_PLOT_MARGIN_TOP = 8;
const HEART_PLOT_MARGIN_BOTTOM = 10;
const HEART_VIEWBOX_TOP = 1;
const HEART_VIEWBOX_BASELINE = HEART_CHART_VIEWBOX_HEIGHT - 1;
const HEART_VIEWBOX_PLOT_BOTTOM = HEART_VIEWBOX_BASELINE - 1;
const HEART_VIEWBOX_GUIDE_LINE_Y = HEART_VIEWBOX_TOP + (HEART_VIEWBOX_PLOT_BOTTOM - HEART_VIEWBOX_TOP) / 2;
const MARKER_BADGE_SIZE = 24;
const CHART_OVERLAY_OVERHANG_PX = 4;
const MIN_MARKER_BAND_WIDTH = 0.15;
const ACTIVITY_DRAFT_BAND_HEIGHT = 31;
const ACTIVITY_DRAFT_BAND_TOP = 3;
const ACTIVITY_DRAFT_HANDLE_WIDTH = 18;
const ACTIVITY_DRAFT_BODY_MIN_WIDTH = 72;
const MIN_ACTIVITY_DRAFT_MINUTE_SPAN = 1;
const HEART_FILL_BASELINE = ACTIVITY_DRAFT_BAND_TOP + ACTIVITY_DRAFT_BAND_HEIGHT;
const DEFAULT_HEART_GRAPH_ACCENT_COLOR = colors.primary;

export type HeartMarkerDraftKind = ManualActivityKind | 'Sleep';

export interface HeartActivityDraft {
  kind: HeartMarkerDraftKind;
  startMinuteOffset: number;
  endMinuteOffset: number;
}

export interface HeartPinchZoomStep {
  value: string;
  windowPointCount: number;
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

function projectHeartOverlayX(
  rawX: number,
  anchorScreenX: number,
  anchorIndex: number,
  pointSpacing: number,
  zoomScale: number,
) {
  'worklet';

  return anchorScreenX + (rawX - anchorIndex * pointSpacing) * zoomScale;
}

function getPinchTouchMetrics(
  touches: readonly { absoluteX: number; absoluteY: number }[],
) {
  'worklet';

  const firstTouch = touches[0];
  const secondTouch = touches[1];
  if (!firstTouch || !secondTouch) {
    return null;
  }

  const deltaX = secondTouch.absoluteX - firstTouch.absoluteX;
  const deltaY = secondTouch.absoluteY - firstTouch.absoluteY;

  return {
    centerX: (firstTouch.absoluteX + secondTouch.absoluteX) / 2,
    centerY: (firstTouch.absoluteY + secondTouch.absoluteY) / 2,
    distance: Math.sqrt(deltaX * deltaX + deltaY * deltaY),
  };
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

function hexColorWithOpacity(color: string, opacity: number) {
  if (!color.startsWith('#')) {
    return color;
  }

  const hex = color.slice(1);
  const normalizedHex =
    hex.length === 3
      ? hex
          .split('')
          .map((character) => `${character}${character}`)
          .join('')
      : hex.length === 6
        ? hex
        : null;

  if (!normalizedHex) {
    return color;
  }

  const alphaHex = Math.round(clampFraction(opacity) * 255).toString(16).padStart(2, '0');
  return `#${normalizedHex}${alphaHex}`;
}

function buildLine(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function combineSvgPaths(paths: readonly string[]) {
  return paths.join(' ');
}

const HEART_STROKE_GRADIENT_POSITIONS = [0, 0.22, 0.78, 1];

function buildHeartFillGradientColors(startColor: string, endColor: string) {
  return {
    body: hexColorWithOpacity(startColor, 0.34),
    tail: hexColorWithOpacity(startColor, 0),
    top: hexColorWithOpacity(endColor, 0.92),
  };
}

function isHeartSvgPathCommand(token: string) {
  return token.length === 1 && /[A-Z]/.test(token);
}

function scaleHeartSvgPathY(path: string, scaleY: number) {
  if (!path || Math.abs(scaleY - 1) < 0.0001) {
    return path;
  }

  const tokens = path.trim().split(/\s+/);
  const scaledTokens: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (!token) {
      index += 1;
      continue;
    }

    scaledTokens.push(token);
    index += 1;

    if (token === 'M' || token === 'L') {
      while (index + 1 < tokens.length) {
        const xToken = tokens[index];
        const yToken = tokens[index + 1];

        if (!xToken || !yToken || isHeartSvgPathCommand(xToken) || isHeartSvgPathCommand(yToken)) {
          break;
        }

        const yValue = Number(yToken);
        scaledTokens.push(xToken);
        scaledTokens.push(Number.isFinite(yValue) ? String(yValue * scaleY) : yToken);
        index += 2;
      }

      continue;
    }

    if (token === 'H') {
      while (index < tokens.length) {
        const xToken = tokens[index];

        if (!xToken || isHeartSvgPathCommand(xToken)) {
          break;
        }

        scaledTokens.push(xToken);
        index += 1;
      }

      continue;
    }

    if (token === 'V') {
      while (index < tokens.length) {
        const yToken = tokens[index];

        if (!yToken || isHeartSvgPathCommand(yToken)) {
          break;
        }

        const yValue = Number(yToken);
        scaledTokens.push(Number.isFinite(yValue) ? String(yValue * scaleY) : yToken);
        index += 1;
      }
    }
  }

  return scaledTokens.join(' ');
}

function makeHeartSkPath(path: string) {
  return path ? Skia.Path.MakeFromSVGString(path) ?? Skia.Path.Make() : Skia.Path.Make();
}

function useHeartChartTransformedPath(
  initPath: ReturnType<typeof Skia.Path.Make>,
  chartCameraState: SharedValue<{ scaleX: number; translateX: number }>,
  chartYAxisState?: SharedValue<{ scaleY: number; translateY: number }>,
) {
  return useDerivedValue(() => {
    'worklet';

    const nextYAxisState = chartYAxisState?.value;
    const nextCameraState = chartCameraState.value;
    const hasYAxisTransform =
      nextYAxisState !== undefined &&
      (nextYAxisState.scaleY !== 1 || nextYAxisState.translateY !== 0);
    const hasCameraTransform =
      nextCameraState.scaleX !== 1 || nextCameraState.translateX !== 0;

    if (!hasYAxisTransform && !hasCameraTransform) {
      return initPath;
    }

    const path = initPath.copy();

    if (hasYAxisTransform && nextYAxisState) {
      path.transform(processTransform2d([{ translateY: nextYAxisState.translateY }, { scaleY: nextYAxisState.scaleY }]));
    }

    if (hasCameraTransform) {
      path.transform(processTransform2d([{ translateX: nextCameraState.translateX }, { scaleX: nextCameraState.scaleX }]));
    }

    return path;
  }, [chartCameraState, chartYAxisState, initPath]);
}

const HeartChartPlotStrokeLayer = memo(function HeartChartPlotStrokeLayer({
  activeSleepStageColor,
  chartCameraState,
  chartEndX,
  chartYAxisState,
  combinedBridgePath,
  guideLinePath,
  hasSleepStageHighlightOverlay,
  plotHeightScale,
  plotShadowColor,
  scaledBridgePaths,
  scaledCombinedPlotPath,
  scaledSleepStageHighlightClipPath,
  strokeGradientColors,
}: {
  activeSleepStageColor: string | null;
  chartCameraState: SharedValue<{ scaleX: number; translateX: number }>;
  chartEndX: number;
  chartYAxisState: SharedValue<{ scaleY: number; translateY: number }>;
  combinedBridgePath: string;
  guideLinePath: string;
  hasSleepStageHighlightOverlay: boolean;
  plotHeightScale: number;
  plotShadowColor: any;
  scaledBridgePaths: string[];
  scaledCombinedPlotPath: string;
  scaledSleepStageHighlightClipPath: string;
  strokeGradientColors: any;
}) {
  const guideLineBasePath = useMemo(() => makeHeartSkPath(guideLinePath), [guideLinePath]);
  const plotStrokeBasePath = useMemo(() => makeHeartSkPath(scaledCombinedPlotPath), [scaledCombinedPlotPath]);
  const bridgeBasePath = useMemo(() => makeHeartSkPath(combinedBridgePath), [combinedBridgePath]);
  const sleepStageHighlightStrokeClipBasePath = useMemo(
    () => makeHeartSkPath(scaledSleepStageHighlightClipPath),
    [scaledSleepStageHighlightClipPath],
  );
  const transformedGuideLinePath = useHeartChartTransformedPath(
    guideLineBasePath,
    chartCameraState,
    chartYAxisState,
  );
  const transformedPlotStrokePath = useHeartChartTransformedPath(
    plotStrokeBasePath,
    chartCameraState,
    chartYAxisState,
  );
  const transformedBridgePath = useHeartChartTransformedPath(
    bridgeBasePath,
    chartCameraState,
    chartYAxisState,
  );
  const transformedSleepStageHighlightStrokeClipPath = useHeartChartTransformedPath(
    sleepStageHighlightStrokeClipBasePath,
    chartCameraState,
  );

  return (
    <>
      <SkiaPath
        color="rgba(149, 162, 188, 0.22)"
        end={1}
        path={transformedGuideLinePath}
        start={0}
        strokeWidth={0.7}
        style="stroke">
        <DashPathEffect intervals={[0.36, 0.36]} />
      </SkiaPath>
      {combinedBridgePath ? (
        <SkiaPath
          color={colors.subtle}
          end={1}
          opacity={0.72}
          path={transformedBridgePath}
          start={0}
          strokeCap="round"
          strokeWidth={0.68}
          style="stroke">
          <DashPathEffect intervals={[1.8, 1.8]} />
        </SkiaPath>
      ) : null}
      {scaledCombinedPlotPath ? (
        <>
          <SkiaPath
            color={plotShadowColor}
            end={1}
            path={transformedPlotStrokePath}
            start={0}
            strokeWidth={1.6}
            style="stroke"
          />
          <SkiaPath
            end={1}
            path={transformedPlotStrokePath}
            start={0}
            strokeCap="round"
            strokeWidth={0.8}
            style="stroke">
            <SkiaLinearGradient
              colors={strokeGradientColors}
              end={vec(chartEndX, HEART_VIEWBOX_TOP * plotHeightScale)}
              positions={HEART_STROKE_GRADIENT_POSITIONS}
              start={vec(0, HEART_VIEWBOX_BASELINE * plotHeightScale)}
            />
          </SkiaPath>
        </>
      ) : null}
      {hasSleepStageHighlightOverlay && scaledCombinedPlotPath ? (
        <SkiaGroup clip={transformedSleepStageHighlightStrokeClipPath}>
          <SkiaPath
            color={activeSleepStageColor!}
            end={1}
            opacity={0.22}
            path={transformedPlotStrokePath}
            start={0}
            strokeWidth={2.4}
            style="stroke"
          />
          <SkiaPath
            color={activeSleepStageColor!}
            end={1}
            opacity={0.96}
            path={transformedPlotStrokePath}
            start={0}
            strokeCap="round"
            strokeWidth={1.3}
            style="stroke"
          />
        </SkiaGroup>
      ) : null}
    </>
  );
});

function interpolateHeartAccentSkiaColor(
  focusTransitionProgress: number,
  baseColor: string,
  focusedColor: string,
) {
  'worklet';

  return interpolateColors(
    focusTransitionProgress,
    [0, 1],
    [baseColor, focusedColor],
  );
}

function resolveHeartGraphAccentColor(marker: HeartMarkerVisual | HeartIntradayMarker | null) {
  if (!marker) {
    return DEFAULT_HEART_GRAPH_ACCENT_COLOR;
  }

  return 'accentColor' in marker ? marker.accentColor : getHeartIntradayMarkerPresentation(marker).accentColor;
}

function buildHeartHighlightClipPath(highlights: readonly HeartSleepStageHighlight[]) {
  return highlights
    .map((highlight) => {
      const endX = highlight.startX + highlight.width;
      return `M ${highlight.startX} 0 H ${endX} V ${HEART_CHART_VIEWBOX_HEIGHT} H ${highlight.startX} Z`;
    })
    .join(' ');
}

function buildHeartCoordinates(
  points: TrendPoint[],
  domain: ReturnType<typeof buildTrendDomain>,
  pointSpacing: number,
) {
  return points.map((point, index) => ({
    x: index * pointSpacing,
    y: point.value === null || !domain ? null : mapHeartValueToYInDomain(point.value, domain),
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
  'worklet';

  const baseViewBoxWidth = getHeartViewBoxWidth(baseWindowPointCount);
  const visibleViewBoxWidth = getHeartViewBoxWidth(windowPointCount);

  if (baseViewBoxWidth <= 0 || visibleViewBoxWidth <= 0) {
    return 1;
  }

  return baseViewBoxWidth / visibleViewBoxWidth;
}

export function getHeartFocusZoomTransitionDurationMs(currentZoomScale: number, nextZoomScale: number) {
  const safeCurrentZoomScale = Math.max(currentZoomScale, 0.0001);
  const safeNextZoomScale = Math.max(nextZoomScale, 0.0001);
  const zoomOctaves = Math.abs(Math.log2(safeNextZoomScale / safeCurrentZoomScale));

  if (!Number.isFinite(zoomOctaves) || zoomOctaves <= 0.01) {
    return FOCUS_ZOOM_DURATION_MS;
  }

  return clamp(
    Math.round(FOCUS_ZOOM_DURATION_MS + zoomOctaves * FOCUS_ZOOM_DURATION_PER_OCTAVE_MS),
    FOCUS_ZOOM_DURATION_MS,
    FOCUS_ZOOM_MAX_DURATION_MS,
  );
}

export function getHeartJumpToLatestTransitionDurationMs(distancePx: number, viewportWidth: number) {
  const safeDistancePx = Math.max(distancePx, 0);
  const referenceDistancePx = Math.max(viewportWidth, 1);

  if (!Number.isFinite(safeDistancePx) || safeDistancePx <= 0) {
    return SNAP_DURATION_MS;
  }

  return clamp(
    Math.round((safeDistancePx / referenceDistancePx) * SNAP_DURATION_MS),
    SNAP_DURATION_MS,
    SNAP_MAX_DURATION_MS,
  );
}

export function getHeartWindowPointCountForZoomScale(baseWindowPointCount: number, zoomScale: number) {
  'worklet';

  const safeScale = Math.max(zoomScale, 0.0001);
  return Math.max(Math.round(getHeartViewBoxWidth(baseWindowPointCount) / safeScale) + 1, 2);
}

export function applyElasticHeartZoomScaleLimit(scale: number, minScale: number, maxScale: number) {
  'worklet';

  const resistance = 0.18;

  if (scale < minScale) {
    return minScale - (minScale - scale) * resistance;
  }

  if (scale > maxScale) {
    return maxScale + (scale - maxScale) * resistance;
  }

  return scale;
}

export function resolveNearestHeartPinchZoomStep(
  windowPointCount: number,
  steps: readonly HeartPinchZoomStep[],
) {
  'worklet';

  if (steps.length === 0) {
    return null;
  }

  let nearestStep = steps[0];
  let nearestDistance = Math.abs(windowPointCount - steps[0].windowPointCount);

  for (let index = 1; index < steps.length; index += 1) {
    const step = steps[index];
    const nextDistance = Math.abs(windowPointCount - step.windowPointCount);

    if (nextDistance < nearestDistance) {
      nearestStep = step;
      nearestDistance = nextDistance;
    }
  }

  return nearestStep;
}

function parseHeartAxisLabelMinutes(label: string) {
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

  const latestPointMinutes = points.at(-1)?.minuteOffset ?? parseHeartAxisLabelMinutes(latestLabel);
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

function resolveHeartMinuteOffset(
  points: readonly { label: string }[],
  anchorDayKey: string | undefined,
  timestampMs: number,
  pointIntervalMinutes = DEFAULT_HEART_POINT_INTERVAL_MINUTES,
) {
  if (!anchorDayKey || points.length === 0 || !Number.isFinite(timestampMs)) {
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

  const anchorDate = new Date(`${anchorDayKey}T00:00:00`);
  const latestPointDate = addMinutes(anchorDate, latestPointMinutes);
  const totalSeriesMinutes = Math.max((points.length - 1) * pointIntervalMinutes, 1);
  const minuteOffset = totalSeriesMinutes + (timestampMs - latestPointDate.getTime()) / 60000;

  return clamp(minuteOffset, 0, totalSeriesMinutes);
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

function buildFocusedMarkerReportSignature(marker: HeartIntradayMarker | null) {
  if (!marker) {
    return null;
  }

  return [
    marker.id,
    marker.kind,
    marker.startFraction,
    marker.endFraction,
    marker.startTimeMs ?? 'none',
    marker.endTimeMs ?? 'none',
  ].join(':');
}

function mapHeartValueToYInDomain(value: number, domain: NonNullable<ReturnType<typeof buildTrendDomain>>) {
  'worklet';
  const span = Math.max(domain.max - domain.min, 0.0001);

  return HEART_VIEWBOX_TOP + ((domain.max - value) / span) * (HEART_VIEWBOX_PLOT_BOTTOM - HEART_VIEWBOX_TOP);
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
    HEART_VIEWBOX_TOP * (1 - scaleY) +
    ((nextDomain.max - previousDomain.max) / nextSpan) * (HEART_VIEWBOX_PLOT_BOTTOM - HEART_VIEWBOX_TOP);

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
  chartPointSpacingValue,
  marker,
  onPress,
  viewportZoomAnchorIndex,
  viewportZoomAnchorScreenX,
  viewportZoomScale,
}: {
  chartPointSpacingValue: SharedValue<number>;
  marker: HeartMarkerVisual;
  onPress?: () => void;
  viewportZoomAnchorIndex: SharedValue<number>;
  viewportZoomAnchorScreenX: SharedValue<number>;
  viewportZoomScale: SharedValue<number>;
}) {
  const animatedBadgeWrapStyle = useAnimatedStyle(
    () => {
      const projectedCenterX = projectHeartOverlayX(
        marker.centerX,
        viewportZoomAnchorScreenX.value,
        viewportZoomAnchorIndex.value,
        chartPointSpacingValue.value,
        Math.max(viewportZoomScale.value, 0.0001),
      );

      return {
        left: projectedCenterX - MARKER_BADGE_SIZE / 2,
        top: -MARKER_BADGE_SIZE / 2,
      };
    },
    [chartPointSpacingValue, marker.centerX, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );

  const badgeWrapStyle = [styles.markerBadgeWrap, animatedBadgeWrapStyle];

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

function HeartMarkerBand({
  chartPointSpacingValue,
  marker,
  markerBandHeight,
  markerBandRadius,
  markerBandTop,
  viewportZoomAnchorIndex,
  viewportZoomAnchorScreenX,
  viewportZoomScale,
}: {
  chartPointSpacingValue: SharedValue<number>;
  marker: HeartMarkerVisual;
  markerBandHeight: number;
  markerBandRadius: number;
  markerBandTop: number;
  viewportZoomAnchorIndex: SharedValue<number>;
  viewportZoomAnchorScreenX: SharedValue<number>;
  viewportZoomScale: SharedValue<number>;
}) {
  const animatedBandStyle = useAnimatedStyle(
    () => {
      const zoomScale = Math.max(viewportZoomScale.value, 0.0001);

      return {
        left: projectHeartOverlayX(
          marker.startX,
          viewportZoomAnchorScreenX.value,
          viewportZoomAnchorIndex.value,
          chartPointSpacingValue.value,
          zoomScale,
        ),
        width: Math.max(marker.bandWidth * zoomScale, 1),
      };
    },
    [chartPointSpacingValue, marker.bandWidth, marker.startX, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.markerBand,
        animatedBandStyle,
        {
          backgroundColor: marker.backgroundColor,
          borderRadius: markerBandRadius,
          height: markerBandHeight,
          top: markerBandTop,
        },
      ]}
    />
  );
}

const HeartChartPlotCanvas = memo(function HeartChartPlotCanvas({
  activeSleepStageColor,
  areas,
  baseDomain,
  baseAccentColor,
  bridgePaths,
  chartContentWidth,
  chartEndX,
  chartPointSpacingValue,
  chartTestID,
  focusTransitionProgress,
  focusedAccentColor,
  guideLineY,
  paths,
  plotHeight,
  sleepStageHighlights,
  viewportZoomAnchorIndex,
  viewportZoomAnchorScreenX,
  viewportZoomScale,
  yAxisDomainMax,
  yAxisDomainMin,
}: {
  activeSleepStageColor: string | null;
  areas: string[];
  baseDomain: ReturnType<typeof buildTrendDomain>;
  baseAccentColor: string;
  bridgePaths: string[];
  chartContentWidth: number;
  chartEndX: number;
  chartPointSpacingValue: SharedValue<number>;
  chartTestID?: string;
  focusTransitionProgress: SharedValue<number>;
  focusedAccentColor: string;
  guideLineY: number;
  paths: string[];
  plotHeight: number;
  sleepStageHighlights: HeartSleepStageHighlight[];
  viewportZoomAnchorIndex: SharedValue<number>;
  viewportZoomAnchorScreenX: SharedValue<number>;
  viewportZoomScale: SharedValue<number>;
  yAxisDomainMax: SharedValue<number>;
  yAxisDomainMin: SharedValue<number>;
}) {
  const [baseGradientStart, baseGradientEnd] = colorStops(baseAccentColor);
  const [focusGradientStart, focusGradientEnd] = colorStops(focusedAccentColor);
  const baseFillGradient = useMemo(
    () => buildHeartFillGradientColors(baseGradientStart, baseGradientEnd),
    [baseGradientEnd, baseGradientStart],
  );
  const focusFillGradient = useMemo(
    () => buildHeartFillGradientColors(focusGradientStart, focusGradientEnd),
    [focusGradientEnd, focusGradientStart],
  );
  const baseShadowColor = chartShadowColor(baseAccentColor);
  const focusShadowColor = chartShadowColor(focusedAccentColor);
  const combinedAreaPath = useMemo(() => combineSvgPaths(areas), [areas]);
  const combinedPlotPath = useMemo(() => combineSvgPaths(paths), [paths]);
  const hasSleepStageHighlightOverlay =
    sleepStageHighlights.length > 0 &&
    activeSleepStageColor !== null;
  const sleepStageHighlightClipPath = useMemo(
    () => buildHeartHighlightClipPath(sleepStageHighlights),
    [sleepStageHighlights],
  );
  const safePlotHeight = Math.max(plotHeight, 1);
  const plotHeightScale = safePlotHeight / HEART_CHART_VIEWBOX_HEIGHT;
  const plotClipPath = useMemo(
    () => `M 0 0 H ${chartContentWidth} V ${safePlotHeight} H 0 Z`,
    [chartContentWidth, safePlotHeight],
  );
  const fillMaskPath = useMemo(
    () =>
      `M 0 ${HEART_VIEWBOX_TOP * plotHeightScale} H ${chartContentWidth} V ${HEART_VIEWBOX_BASELINE * plotHeightScale} H 0 Z`,
    [chartContentWidth, plotHeightScale],
  );
  const scaledCombinedAreaPath = useMemo(
    () => scaleHeartSvgPathY(combinedAreaPath, plotHeightScale),
    [combinedAreaPath, plotHeightScale],
  );
  const scaledCombinedPlotPath = useMemo(
    () => scaleHeartSvgPathY(combinedPlotPath, plotHeightScale),
    [combinedPlotPath, plotHeightScale],
  );
  const scaledBridgePaths = useMemo(
    () => bridgePaths.map((path) => scaleHeartSvgPathY(path, plotHeightScale)),
    [bridgePaths, plotHeightScale],
  );
  const combinedBridgePath = useMemo(() => combineSvgPaths(scaledBridgePaths), [scaledBridgePaths]);
  const scaledSleepStageHighlightClipPath = useMemo(
    () => scaleHeartSvgPathY(sleepStageHighlightClipPath, plotHeightScale),
    [plotHeightScale, sleepStageHighlightClipPath],
  );
  const scaledGuideLineY = guideLineY * plotHeightScale;
  const guideLinePath = useMemo(
    () => `M 0 ${scaledGuideLineY} L ${chartEndX} ${scaledGuideLineY}`,
    [chartEndX, scaledGuideLineY],
  );
  const fillMaskGradientColors = useMemo(() => ['#ffffffff', '#ffffffff', '#ffffff00'], []);
  const sleepStageFillGradientColors = useMemo(
    () =>
      activeSleepStageColor
        ? [
            hexColorWithOpacity(activeSleepStageColor, 0.84),
            hexColorWithOpacity(activeSleepStageColor, 0.38),
            hexColorWithOpacity(activeSleepStageColor, 0),
          ]
        : null,
    [activeSleepStageColor],
  );
  const hasTestProbes =
    (chartTestID !== undefined && bridgePaths.length > 0) ||
    sleepStageHighlights.some((highlight) => highlight.testID);

  const chartCameraState = useDerivedValue(
    () => {
      const translateX =
        viewportZoomAnchorScreenX.value -
        viewportZoomScale.value * viewportZoomAnchorIndex.value * chartPointSpacingValue.value;

      return {
        scaleX: viewportZoomScale.value,
        translateX,
      };
    },
    [chartPointSpacingValue, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );
  const chartCameraTransform = useDerivedValue(
    () => {
      const { scaleX, translateX } = chartCameraState.value;

      // Skia composes transform arrays left-to-right, so translation must come first
      // to preserve the original SVG matrix's scale-then-translate camera behavior.
      return [{ translateX }, { scaleX }];
    },
    [chartCameraState],
  );
  const chartYAxisState = useDerivedValue(
    () => {
      if (!baseDomain || yAxisDomainMax.value <= yAxisDomainMin.value) {
        return {
          scaleY: 1,
          translateY: 0,
        };
      }

      const { scaleY, translateY } = buildHeartDomainAnimation(baseDomain, {
        max: yAxisDomainMax.value,
        min: yAxisDomainMin.value,
      });

      return {
        scaleY,
        translateY: translateY * plotHeightScale,
      };
    },
    [baseDomain, plotHeightScale, yAxisDomainMax, yAxisDomainMin],
  );
  const chartYAxisTransform = useDerivedValue(
    () => {
      const { scaleY, translateY } = chartYAxisState.value;
      return [{ translateY }, { scaleY }];
    },
    [chartYAxisState],
  );
  const strokeGradientColors = useDerivedValue(
    () => [
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseGradientStart,
        focusGradientStart,
      ),
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseGradientStart,
        focusGradientStart,
      ),
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseGradientEnd,
        focusGradientEnd,
      ),
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseGradientEnd,
        focusGradientEnd,
      ),
    ],
    [
      baseGradientEnd,
      baseGradientStart,
      focusGradientEnd,
      focusTransitionProgress,
      focusGradientStart,
    ],
  );
  const fillGradientColors = useDerivedValue(
    () => [
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseFillGradient.top,
        focusFillGradient.top,
      ),
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseFillGradient.body,
        focusFillGradient.body,
      ),
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseFillGradient.body,
        focusFillGradient.body,
      ),
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseFillGradient.tail,
        focusFillGradient.tail,
      ),
    ],
    [
      baseFillGradient.body,
      baseFillGradient.tail,
      baseFillGradient.top,
      focusFillGradient.body,
      focusFillGradient.tail,
      focusTransitionProgress,
      focusFillGradient.top,
    ],
  );
  const plotShadowColor = useDerivedValue(
    () =>
      interpolateHeartAccentSkiaColor(
        focusTransitionProgress.value,
        baseShadowColor,
        focusShadowColor,
      ),
    [
      baseShadowColor,
      focusShadowColor,
      focusTransitionProgress,
    ],
  );

  return (
    <Animated.View pointerEvents="none" style={styles.chartCanvas}>
      <Canvas style={styles.chartCanvas}>
        <SkiaGroup clip={plotClipPath}>
          <SkiaGroup transform={chartCameraTransform}>
            <SkiaMask
              mask={
                <SkiaPath end={1} path={fillMaskPath} start={0}>
                  <SkiaLinearGradient
                    colors={fillMaskGradientColors}
                    end={vec(0, HEART_VIEWBOX_BASELINE * plotHeightScale)}
                    positions={[0, 0.72, 1]}
                    start={vec(0, HEART_VIEWBOX_TOP * plotHeightScale)}
                  />
                </SkiaPath>
              }>
              {scaledCombinedAreaPath ? (
                <SkiaGroup transform={chartYAxisTransform}>
                  <SkiaPath end={1} path={scaledCombinedAreaPath} start={0}>
                    <SkiaLinearGradient
                      colors={fillGradientColors}
                      end={vec(0, HEART_VIEWBOX_BASELINE * plotHeightScale)}
                      positions={[0, 0.44, 0.72, 1]}
                      start={vec(0, HEART_VIEWBOX_TOP * plotHeightScale)}
                    />
                  </SkiaPath>
                </SkiaGroup>
              ) : null}
              {hasSleepStageHighlightOverlay && scaledCombinedAreaPath && sleepStageFillGradientColors ? (
                <SkiaGroup clip={scaledSleepStageHighlightClipPath}>
                  <SkiaGroup transform={chartYAxisTransform}>
                    <SkiaPath end={1} path={scaledCombinedAreaPath} start={0}>
                      <SkiaLinearGradient
                        colors={sleepStageFillGradientColors}
                        end={vec(0, HEART_VIEWBOX_BASELINE * plotHeightScale)}
                        positions={[0, 0.42, 0.7]}
                        start={vec(0, HEART_VIEWBOX_TOP * plotHeightScale)}
                      />
                    </SkiaPath>
                  </SkiaGroup>
                </SkiaGroup>
              ) : null}
            </SkiaMask>
          </SkiaGroup>
          <HeartChartPlotStrokeLayer
            activeSleepStageColor={activeSleepStageColor}
            chartCameraState={chartCameraState}
            chartEndX={chartEndX}
            chartYAxisState={chartYAxisState}
            combinedBridgePath={combinedBridgePath}
            guideLinePath={guideLinePath}
            hasSleepStageHighlightOverlay={hasSleepStageHighlightOverlay}
            plotHeightScale={plotHeightScale}
            plotShadowColor={plotShadowColor}
            scaledBridgePaths={scaledBridgePaths}
            scaledCombinedPlotPath={scaledCombinedPlotPath}
            scaledSleepStageHighlightClipPath={scaledSleepStageHighlightClipPath}
            strokeGradientColors={strokeGradientColors}
          />
        </SkiaGroup>
      </Canvas>
      {hasTestProbes ? (
        <View pointerEvents="none" style={styles.chartCanvas}>
          {chartTestID
            ? bridgePaths.map((_, index) => (
                <View
                  collapsable={false}
                  key={`bridge-probe-${index}`}
                  style={styles.chartTestProbe}
                  testID={`${chartTestID}-bridge-${index}`}
                />
              ))
            : null}
          {sleepStageHighlights.map((highlight, index) =>
            highlight.testID ? (
              <View
                collapsable={false}
                key={`stage-highlight-probe-${highlight.stage}-${index}`}
                style={styles.chartTestProbe}
                testID={highlight.testID}
              />
            ) : null,
          )}
        </View>
      ) : null}
    </Animated.View>
  );
});

export function PannableHeartChart({
  overlayAccentColor = colors.primary,
  activityDraft = null,
  draftPreview = null,
  hiddenMarkerId = null,
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
  onLoadMore,
  onPinchZoomStepChange,
  onViewportWindowChange,
  onViewingLatestWindowChange,
  pinchZoomSteps,
  pointIntervalMinutes = DEFAULT_HEART_POINT_INTERVAL_MINUTES,
  points,
  requestedFocusedMarker = null,
  requestedFocusedMarkerId,
  resetKey,
  windowPointCount,
}: {
  overlayAccentColor?: string;
  activityDraft?: HeartActivityDraft | null;
  draftPreview?: HeartActivityDraft | null;
  hiddenMarkerId?: string | null;
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
  onFocusTransitionStateChange?: (isTransitioning: boolean, transitionDurationMs?: number) => void;
  onLoadMore?: () => void;
  onPinchZoomStepChange?: (value: string) => void;
  onViewportWindowChange?: (window: HeartViewportWindowState) => void;
  onViewingLatestWindowChange?: (isViewingLatestWindow: boolean) => void;
  pinchZoomSteps?: readonly HeartPinchZoomStep[];
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
  const [pinchPreviewWindow, setPinchPreviewWindow] = useState<HeartViewportWindowState | null>(null);
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);
  const windowStartRef = useRef(maxWindowStart);
  const maxWindowStartRef = useRef(maxWindowStart);
  maxWindowStartRef.current = maxWindowStart;
  const [selectionIndex, setSelectionIndex] = useState<number | null>(null);
  const selectionRef = useRef<number | null>(null);
  const releaseScrollLockRef = useRef<(() => void) | null>(null);
  const previousPointCountRef = useRef(points.length);
  const previousWindowBeforeFocusRef = useRef<{ windowPointCount: number; windowStart: number } | null>(null);
  const incomingActivityDraft = activityDraft ?? draftPreview;
  const draftGestureOriginRef = useRef<HeartActivityDraft | null>(activityDraft ?? null);
  const latestActivityDraftRef = useRef<HeartActivityDraft | null>(activityDraft);
  const previousActivityDraftRef = useRef<HeartActivityDraft | null>(incomingActivityDraft);
  const renderedActivityDraftRef = useRef<HeartActivityDraft | null>(incomingActivityDraft);
  const activityDraftDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renderedActivityDraft, setRenderedActivityDraft] = useState<HeartActivityDraft | null>(incomingActivityDraft);
  const previousRequestedFocusedMarkerRef = useRef<HeartIntradayMarker | null>(null);
  const lastReportedFocusedMarkerSignatureRef = useRef<string | null | undefined>(undefined);
  const previousPrecisionContextRef = useRef({
    pointCount: points.length,
    pointIntervalMinutes,
  });
  const previousTimelineZoomContextRef = useRef({
    baseWindowPointCount,
    resetKey,
  });
  const requestedFocusMarkerIdRef = useRef<string | null>(null);
  const pendingLoadMoreRef = useRef(false);
  const previousJumpToLatestSignalRef = useRef<number | undefined>(jumpToLatestSignal);
  const skipLatestWindowChangeRef = useRef(true);
  const baseAccentColorRef = useRef(DEFAULT_HEART_GRAPH_ACCENT_COLOR);
  const focusedAccentColorRef = useRef(DEFAULT_HEART_GRAPH_ACCENT_COLOR);
  const focusTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTransitionDurationRef = useRef(FOCUS_ZOOM_DURATION_MS);
  const yAxisTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPinchZoomSyncRef = useRef<{ windowPointCount: number } | null>(null);
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
  const pinchStartZoomScale = useSharedValue(1);
  const pinchAnchorIndex = useSharedValue(0);
  const pinchAnchorScreenX = useSharedValue(0);
  const pinchCommitted = useSharedValue(false);
  const pinchGestureActive = useSharedValue(false);
  const pinchActivationStartDistance = useSharedValue(0);
  const pinchActivationStartCenterX = useSharedValue(0);
  const pinchActivationStartCenterY = useSharedValue(0);
  const activityDraftOpacity = useSharedValue(incomingActivityDraft ? 1 : 0);

  const pointSpacing = getHeartViewportPointSpacing(viewportWidth, safeWindowPointCount);
  const basePointSpacing = getHeartViewportPointSpacing(viewportWidth, plotBaseWindowPointCount);
  const chartPointSpacing = basePointSpacing > 0 ? basePointSpacing : 1;
  const viewBoxWidth = getHeartViewBoxWidth(safeWindowPointCount);
  const effectiveWindowPointCount = pinchPreviewWindow?.windowPointCount ?? safeWindowPointCount;
  const effectiveWindowStart = pinchPreviewWindow?.windowStart ?? windowStart;
  const visibleActivityDraft = incomingActivityDraft ?? renderedActivityDraft;
  const baseDomain = useMemo(() => buildTrendDomain(points, { mode: 'line' }), [points]);
  const [isYAxisDomainLocked, setIsYAxisDomainLocked] = useState(false);
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
          return `${path} L ${endX} ${HEART_VIEWBOX_BASELINE} L ${startX} ${HEART_VIEWBOX_BASELINE} Z`;
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
      ? mapHeartValueToYInDomain(0, baseDomain)
      : HEART_VIEWBOX_GUIDE_LINE_Y;
  const plotViewportHeight = Math.max(viewportHeight - HEART_PLOT_MARGIN_TOP - HEART_PLOT_MARGIN_BOTTOM, 0);
  const selectionPoint = selectionIndex === null ? null : points[selectionIndex] ?? null;
  const selectionX =
    selectionIndex !== null &&
    selectionIndex >= windowStart &&
    selectionIndex <= windowStart + viewBoxWidth
      ? safeWindowPointCount <= 1
        ? 50
        : ((selectionIndex - windowStart) / viewBoxWidth) * 100
      : null;

  const fullSeriesSpan = chartEndX;
  const markerVisuals = useMemo(
    () =>
      mapHeartIntradayMarkersToTrendMarkers(markers).map((marker, index) => {
        const sourceMarker = markers[index];
        const presentation = sourceMarker ? getHeartIntradayMarkerPresentation(sourceMarker) : null;
        const startFraction = clampFraction(marker.startFraction);
        const endFraction = clampFraction(Math.max(marker.startFraction, marker.endFraction));
        const totalSeriesMinutes = Math.max((points.length - 1) * pointIntervalMinutes, 1);
        const fractionStartMinuteOffset = clamp(startFraction * totalSeriesMinutes, 0, totalSeriesMinutes);
        const fractionEndMinuteOffset = clamp(endFraction * totalSeriesMinutes, fractionStartMinuteOffset, totalSeriesMinutes);
        const exactStartMinuteOffset =
          sourceMarker?.startTimeMs !== undefined
            ? resolveHeartMinuteOffset(points, anchorDayKey, sourceMarker.startTimeMs, pointIntervalMinutes)
            : null;
        const exactEndMinuteOffset =
          sourceMarker?.endTimeMs !== undefined
            ? resolveHeartMinuteOffset(points, anchorDayKey, sourceMarker.endTimeMs, pointIntervalMinutes)
            : null;
        const startMinuteOffset = exactStartMinuteOffset ?? fractionStartMinuteOffset;
        const endMinuteOffset = clamp(
          exactEndMinuteOffset ?? fractionEndMinuteOffset,
          startMinuteOffset,
          totalSeriesMinutes,
        );
        const startX = (startMinuteOffset / totalSeriesMinutes) * fullSeriesSpan;
        const endX = (endMinuteOffset / totalSeriesMinutes) * fullSeriesSpan;
        const bandWidth = Math.max(endX - startX, MIN_MARKER_BAND_WIDTH);

        return {
          ...marker,
          bandWidth,
          centerX: startX + bandWidth / 2,
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
    [anchorDayKey, chartTestID, fullSeriesSpan, markers, pointIntervalMinutes, points],
  );
  const visibleMarkerVisuals = useMemo(
    () => (hiddenMarkerId ? markerVisuals.filter((marker) => marker.id !== hiddenMarkerId) : markerVisuals),
    [hiddenMarkerId, markerVisuals],
  );

  const axisLabels = useMemo(
    () => buildHeartAxisLabels(points, effectiveWindowPointCount, anchorDayKey, effectiveWindowStart, pointIntervalMinutes),
    [anchorDayKey, effectiveWindowPointCount, effectiveWindowStart, pointIntervalMinutes, points],
  );
  const visibleWindowDomain = useMemo(
    () => buildVisibleHeartDomain(points, safeWindowPointCount, windowStart),
    [points, safeWindowPointCount, windowStart],
  );
  const pinchZoomScaleBounds = useMemo(() => {
    if (!pinchZoomSteps || pinchZoomSteps.length < 2) {
      return null;
    }

    const windowPointCounts = pinchZoomSteps
      .map((step) => Math.min(Math.max(step.windowPointCount, 2), Math.max(points.length, 1)))
      .sort((left, right) => left - right);
    const minWindowPointCount = windowPointCounts[0] ?? baseWindowPointCount;
    const maxWindowPointCount = windowPointCounts.at(-1) ?? baseWindowPointCount;

    return {
      maxWindowPointCount,
      maxZoomScale: getHeartViewportZoomScale(plotBaseWindowPointCount, minWindowPointCount),
      minWindowPointCount,
      minZoomScale: getHeartViewportZoomScale(plotBaseWindowPointCount, maxWindowPointCount),
    };
  }, [baseWindowPointCount, pinchZoomSteps, plotBaseWindowPointCount, points.length]);
  const focusedMarker = useMemo(
    () => markers.find((marker) => marker.id === focusedMarkerId) ?? (focusedMarkerId !== null ? requestedFocusedMarker : null),
    [focusedMarkerId, markers, requestedFocusedMarker],
  );
  const baseChartAccentColor = baseAccentColorRef.current;
  const focusedChartAccentColor = focusedAccentColorRef.current;
  const reportFocusTransitionStateChange = useCallback(
    (isTransitioning: boolean, transitionDurationMs?: number) => {
      onFocusTransitionStateChange?.(isTransitioning, transitionDurationMs);
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
  const scheduleFocusTransitionSettled = useCallback((durationMs: number) => {
    clearFocusTransitionTimeout();
    focusTransitionTimeoutRef.current = setTimeout(() => {
      focusTransitionTimeoutRef.current = null;
      reportFocusTransitionStateChange(false);
    }, durationMs);
  }, [clearFocusTransitionTimeout, reportFocusTransitionStateChange]);
  const clearYAxisTransitionTimeout = useCallback(() => {
    if (yAxisTransitionTimeoutRef.current === null) {
      return;
    }

    clearTimeout(yAxisTransitionTimeoutRef.current);
    yAxisTransitionTimeoutRef.current = null;
  }, []);
  const lockYAxisDomain = useCallback(() => {
    clearYAxisTransitionTimeout();
    cancelAnimation(focusedDomainMin);
    cancelAnimation(focusedDomainMax);
    setIsYAxisDomainLocked(true);
  }, [clearYAxisTransitionTimeout, focusedDomainMax, focusedDomainMin]);
  const unlockYAxisDomain = useCallback(() => {
    clearYAxisTransitionTimeout();
    setIsYAxisDomainLocked(false);
  }, [clearYAxisTransitionTimeout]);
  const scheduleYAxisDomainUnlock = useCallback(
    (durationMs: number) => {
      lockYAxisDomain();

      if (durationMs <= 0) {
        setIsYAxisDomainLocked(false);
        return;
      }

      yAxisTransitionTimeoutRef.current = setTimeout(() => {
        yAxisTransitionTimeoutRef.current = null;
        setIsYAxisDomainLocked(false);
      }, durationMs);
    },
    [lockYAxisDomain],
  );
  const animateYAxisDomainWhileLocked = useCallback(
    (nextDomain: { min: number; max: number } | null, durationMs: number) => {
      if (!nextDomain) {
        scheduleYAxisDomainUnlock(durationMs);
        return;
      }

      lockYAxisDomain();

      if (durationMs <= 0) {
        focusedDomainMin.value = nextDomain.min;
        focusedDomainMax.value = nextDomain.max;
        setIsYAxisDomainLocked(false);
        return;
      }

      focusedDomainMin.value = withTiming(nextDomain.min, {
        duration: durationMs,
        easing: Easing.out(Easing.cubic),
      });
      focusedDomainMax.value = withTiming(nextDomain.max, {
        duration: durationMs,
        easing: Easing.out(Easing.cubic),
      });
      yAxisTransitionTimeoutRef.current = setTimeout(() => {
        yAxisTransitionTimeoutRef.current = null;
        setIsYAxisDomainLocked(false);
      }, durationMs);
    },
    [focusedDomainMax, focusedDomainMin, lockYAxisDomain, scheduleYAxisDomainUnlock],
  );
  const focusedMarkerDomain = useMemo(
    () => buildHeartMarkerDomain(points, focusedMarker),
    [focusedMarker, points],
  );
  const selectionDomain = focusedMarkerDomain ?? visibleWindowDomain ?? baseDomain;
  const selectionY = selectionPoint && selectionPoint.value !== null && selectionDomain
    ? mapHeartValueToYInDomain(selectionPoint.value, selectionDomain)
    : null;
  const sleepStageHighlights = useMemo(
    () =>
      highlightedSleepStage
        ? buildHeartSleepStageHighlights(focusedMarker, highlightedSleepStage, fullSeriesSpan, chartTestID)
        : EMPTY_HEART_SLEEP_STAGE_HIGHLIGHTS,
    [chartTestID, focusedMarker, fullSeriesSpan, highlightedSleepStage],
  );
  const activeSleepStageColor = highlightedSleepStage ? sleepStageColors[highlightedSleepStage] : null;
  const sleepStageSelectionRanges = useMemo(
    () => buildHeartSleepStageSelectionRanges(points.length, focusedMarker, highlightedSleepStage),
    [focusedMarker, highlightedSleepStage, points.length],
  );
  const activityDraftVisual = useMemo(() => {
    if (!visibleActivityDraft || fullSeriesSpan <= 0 || plotViewportHeight <= 0) {
      return null;
    }

    const totalSeriesMinutes = Math.max((points.length - 1) * pointIntervalMinutes, 1);
    const startFraction = clampFraction(visibleActivityDraft.startMinuteOffset / totalSeriesMinutes);
    const endFraction = clampFraction(
      Math.max(visibleActivityDraft.startMinuteOffset, visibleActivityDraft.endMinuteOffset) / totalSeriesMinutes,
    );
    if (endFraction <= startFraction) {
      return null;
    }

    const startX = startFraction * fullSeriesSpan;
    const endX = endFraction * fullSeriesSpan;
    const bandWidth = Math.max(endX - startX, 2);
    const startHandleLeft = startX - ACTIVITY_DRAFT_HANDLE_WIDTH / 2;
    const endHandleLeft = endX - ACTIVITY_DRAFT_HANDLE_WIDTH / 2;
    const bodyWidth = Math.max(bandWidth + 24, ACTIVITY_DRAFT_BODY_MIN_WIDTH);
    const bodyLeft = startX + bandWidth / 2 - bodyWidth / 2;
    const bandTop = 0;
    const bandHeight = plotViewportHeight;
    const inlineBadgeLeft = startX + bandWidth / 2 - MARKER_BADGE_SIZE / 2;
    const inlineBadgeTop = -MARKER_BADGE_SIZE / 2;
    const handleHeight = Math.min(Math.max(32, bandHeight * 0.38), bandHeight);
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
    fullSeriesSpan,
    pointIntervalMinutes,
    points.length,
    plotViewportHeight,
    visibleActivityDraft,
  ]);
  const activityDraftBadgeMarker = useMemo(() => {
    if (!visibleActivityDraft || !activityDraftVisual) {
      return null;
    }

    const markerKind = visibleActivityDraft.kind === 'Sleep'
      ? 'sleep'
      : visibleActivityDraft.kind === 'Nap'
        ? 'nap'
        : 'activity';

    const draftMarker = {
      id: 'draft-activity-marker',
      kind: markerKind,
      label: visibleActivityDraft.kind,
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
  }, [activityDraftVisual, chartTestID, visibleActivityDraft]);
  const activityDraftAccentColor = visibleActivityDraft?.kind === 'Sleep'
    ? colors.indigo
    : visibleActivityDraft?.kind === 'Nap'
      ? colors.aqua
      : colors.heart;
  const activityDraftFillColor = visibleActivityDraft?.kind === 'Sleep'
    ? 'rgba(93, 120, 255, 0.18)'
    : visibleActivityDraft?.kind === 'Nap'
      ? 'rgba(86, 255, 209, 0.18)'
      : 'rgba(255, 210, 107, 0.18)';
  const markerBandTop = 0;
  const markerBandHeight = plotViewportHeight;
  const markerBandRadius = plotViewportHeight * (3 / HEART_CHART_VIEWBOX_HEIGHT);
  const isFocusedWindow = focusedMarkerId !== null || safeWindowPointCount !== baseWindowPointCount;
  const hasTopMarkers = visibleMarkerVisuals.length > 0 || activityDraftBadgeMarker !== null;
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
    const normalizedSelectionIndex = nextSelectionIndex === null ? null : Math.round(nextSelectionIndex);

    if (selectionRef.current === normalizedSelectionIndex) {
      return;
    }

    selectionRef.current = normalizedSelectionIndex;
    setSelectionIndex(normalizedSelectionIndex);
  }, []);

  const handlePinchZoomStart = useCallback(() => {
    setPinchPreviewWindow(null);
    ensureScrollLock();
    commitSelection(null);
    lockYAxisDomain();
  }, [commitSelection, ensureScrollLock, lockYAxisDomain]);

  const handlePinchZoomCancel = useCallback(() => {
    setPinchPreviewWindow(null);
    releaseScrollLock();
    unlockYAxisDomain();
  }, [releaseScrollLock, unlockYAxisDomain]);

  const syncPinchPreviewWindow = useCallback(
    (nextWindowPointCount: number, nextWindowStart: number) => {
      const resolvedWindowPointCount = Math.min(Math.max(nextWindowPointCount, 2), Math.max(points.length, 1));
      const nextMaxWindowStart = Math.max(0, points.length - resolvedWindowPointCount);
      const clampedWindowStart = clamp(nextWindowStart, 0, nextMaxWindowStart);

      setPinchPreviewWindow((current) => {
        if (
          current?.windowPointCount === resolvedWindowPointCount &&
          current.windowStart === clampedWindowStart
        ) {
          return current;
        }

        return {
          windowPointCount: resolvedWindowPointCount,
          windowStart: clampedWindowStart,
        };
      });
    },
    [points.length],
  );

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

      const minVisibleIndex = clamp(Math.ceil(windowStartRef.current), 0, points.length - 1);
      const maxVisibleIndex = clamp(
        Math.floor(windowStartRef.current + Math.max(safeWindowPointCount - 1, 0)),
        minVisibleIndex,
        points.length - 1,
      );
      const nextIndex = clamp(
        Math.round(windowStartRef.current + touchX / pointSpacing),
        minVisibleIndex,
        maxVisibleIndex,
      );

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
      nextFocusedAccentColor,
      nextAnchorScreenX,
      nextFocusedMarkerId,
      nextZoomScale,
      previousAnimatedWindowStart,
      reportTransitionSettledWhenComplete,
      resolvedWindowPointCount,
      transitionDurationMs,
    }: {
      currentAnchorScreenX: number;
      clampedWindowStart: number;
      nextAnchorIndex: number;
      nextFocusedAccentColor?: string;
      nextAnchorScreenX: number;
      nextFocusedMarkerId: string | null;
      nextZoomScale: number;
      previousAnimatedWindowStart: number;
      reportTransitionSettledWhenComplete: boolean;
      resolvedWindowPointCount: number;
      transitionDurationMs: number;
    }) => {
      activeWindowPointCountRef.current = resolvedWindowPointCount;
      windowStartRef.current = clampedWindowStart;
      gestureStartWindowStart.value = clampedWindowStart;
      reportedWindowStart.value = clampedWindowStart;
      viewportZoomAnchorIndex.value = nextAnchorIndex;
      focusTransitionDurationRef.current = transitionDurationMs;

      if (nextFocusedMarkerId !== null) {
        baseAccentColorRef.current = DEFAULT_HEART_GRAPH_ACCENT_COLOR;
        focusedAccentColorRef.current = nextFocusedAccentColor ?? focusedAccentColorRef.current;
      } else {
        baseAccentColorRef.current = DEFAULT_HEART_GRAPH_ACCENT_COLOR;
      }

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
          reportFocusTransitionStateChange(false, transitionDurationMs);
        }

        return;
      }

      viewportZoomAnchorScreenX.value = currentAnchorScreenX;
      animatedWindowStart.value = previousAnimatedWindowStart;
      animatedWindowStart.value = withTiming(clampedWindowStart, { duration: transitionDurationMs });
      viewportZoomScale.value = withTiming(nextZoomScale, { duration: transitionDurationMs });
      viewportZoomAnchorScreenX.value = withTiming(nextAnchorScreenX, { duration: transitionDurationMs });
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
      nextFocusedAccentColor?: string,
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
      const isReturningFromFocusedMarker = focusedMarkerId !== null && nextFocusedMarkerId === null;
      const transitionDurationMs = isFocusStateChanging
        ? getHeartFocusZoomTransitionDurationMs(viewportZoomScale.value, nextZoomScale)
        : FOCUS_ZOOM_DURATION_MS;

      pendingLoadMoreRef.current = false;
      loadRequested.value = false;
      commitSelection(null);
      releaseScrollLock();
      cancelAnimation(animatedWindowStart);
      cancelAnimation(viewportZoomScale);
      cancelAnimation(viewportZoomAnchorScreenX);
      isAxisDragging.value = false;

      if (viewportWidth > 0) {
        if (isReturningFromFocusedMarker) {
          animateYAxisDomainWhileLocked(nextVisibleDomain, transitionDurationMs);
        } else {
          scheduleYAxisDomainUnlock(transitionDurationMs);
        }
      } else {
        unlockYAxisDomain();
      }

      if (isFocusStateChanging) {
        reportFocusTransitionStateChange(true, transitionDurationMs);
        scheduleFocusTransitionSettled(transitionDurationMs);
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
        nextFocusedAccentColor,
        nextAnchorScreenX,
        nextFocusedMarkerId,
        nextZoomScale,
        previousAnimatedWindowStart,
        reportTransitionSettledWhenComplete: isFocusStateChanging,
        resolvedWindowPointCount,
        transitionDurationMs,
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
      animateYAxisDomainWhileLocked,
      reportFocusTransitionStateChange,
      scheduleYAxisDomainUnlock,
      scheduleFocusTransitionSettled,
      startWindowZoomTransition,
      unlockYAxisDomain,
      viewportWidth,
      viewportZoomAnchorScreenX,
      viewportZoomScale,
    ],
  );

  const commitPinchZoomStep = useCallback(
    (
      nextZoomValue: string,
      nextWindowPointCount: number,
      nextWindowStart: number,
      nextAnchorIndex: number,
    ) => {
      syncPinchPreviewWindow(nextWindowPointCount, nextWindowStart);
      pendingPinchZoomSyncRef.current = {
        windowPointCount: nextWindowPointCount,
      };
      applyWindowZoom(nextWindowPointCount, nextWindowStart, null, nextAnchorIndex);
      onPinchZoomStepChange?.(nextZoomValue);
    },
    [applyWindowZoom, onPinchZoomStepChange, syncPinchPreviewWindow],
  );

  const syncFocusedWindowInstant = useCallback(
    (
      nextWindowPointCount: number,
      nextWindowStart: number,
      nextFocusedMarkerId: string | null,
      nextViewportZoomAnchorIndex?: number,
      nextFocusedAccentColor?: string,
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
      unlockYAxisDomain();

      if (nextFocusedMarkerId !== null) {
        baseAccentColorRef.current = DEFAULT_HEART_GRAPH_ACCENT_COLOR;
        focusedAccentColorRef.current = nextFocusedAccentColor ?? focusedAccentColorRef.current;
      } else {
        baseAccentColorRef.current = DEFAULT_HEART_GRAPH_ACCENT_COLOR;
      }

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
      unlockYAxisDomain,
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

      applyWindowZoom(
        focusedWindow.windowPointCount,
        focusedWindow.windowStart,
        marker.id,
        markerCenterIndex,
        marker.accentColor,
      );
    },
    [applyWindowZoom, baseWindowPointCount, points.length],
  );

  useEffect(() => {
    if (requestedFocusedMarker !== null) {
      return;
    }

    previousRequestedFocusedMarkerRef.current = null;
  }, [requestedFocusedMarker]);

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
        previousPrecisionContext.pointCount !== points.length ||
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
        resolveHeartGraphAccentColor(requestedFocusedMarker),
      );
      return;
    }

    applyWindowZoom(
      focusedWindow.windowPointCount,
      focusedWindow.windowStart,
      requestedFocusedMarker.id,
      markerCenterIndex,
      resolveHeartGraphAccentColor(requestedFocusedMarker),
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
    if (requestedFocusedMarkerId !== null) {
      return;
    }

    requestedFocusMarkerIdRef.current = null;
  }, [requestedFocusedMarkerId]);

  useEffect(() => {
    previousPrecisionContextRef.current = {
      pointCount: points.length,
      pointIntervalMinutes,
    };
  }, [pointIntervalMinutes, points.length]);

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
    lockYAxisDomain();
  }, [commitSelection, ensureScrollLock, lockYAxisDomain]);

  const handleAxisPanEnd = useCallback(() => {
    releaseScrollLock();
    unlockYAxisDomain();
  }, [releaseScrollLock, unlockYAxisDomain]);

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
    const currentWindowStart = clamp(animatedWindowStart.value, 0, maxWindowStartRef.current);
    const jumpDistancePx = Math.abs(nextWindowStart - currentWindowStart) * chartPointSpacing;
    const jumpDurationMs = getHeartJumpToLatestTransitionDurationMs(jumpDistancePx, viewportWidth);
    gestureStartWindowStart.value = nextWindowStart;
    viewportZoomAnchorIndex.value = currentWindowStart;
    viewportZoomAnchorScreenX.value = 0;
    scheduleYAxisDomainUnlock(jumpDurationMs);
    animatedWindowStart.value = withTiming(nextWindowStart, { duration: jumpDurationMs }, (finished) => {
      if (!finished) {
        return;
      }

      reportedWindowStart.value = nextWindowStart;
      runOnJS(syncWindowStart)(nextWindowStart);
    });
    viewportZoomAnchorIndex.value = withTiming(nextWindowStart, { duration: jumpDurationMs });
  }, [
    animatedWindowStart,
    cancelAnimation,
    chartPointSpacing,
    commitSelection,
    gestureStartWindowStart,
    applyWindowZoom,
    baseWindowPointCount,
    focusedMarkerId,
    loadRequested,
    points.length,
    releaseScrollLock,
    reportedWindowStart,
    scheduleYAxisDomainUnlock,
    syncWindowStart,
    viewportWidth,
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
    setPlotBaseWindowPointCount(baseWindowPointCount);
    const nextWindowStart = maxWindowStart;

    pendingPinchZoomSyncRef.current = null;
    baseAccentColorRef.current = DEFAULT_HEART_GRAPH_ACCENT_COLOR;
    focusedAccentColorRef.current = DEFAULT_HEART_GRAPH_ACCENT_COLOR;
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
    unlockYAxisDomain();
    viewportZoomScale.value = getHeartViewportZoomScale(baseWindowPointCount, baseWindowPointCount);
    viewportZoomAnchorIndex.value = nextWindowStart;
    viewportZoomAnchorScreenX.value = 0;
  }, [
    animatedWindowStart,
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
    unlockYAxisDomain,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
    viewportZoomScale,
  ]);

  useLayoutEffect(() => {
    const previousTimelineZoomContext = previousTimelineZoomContextRef.current;
    const pendingPinchZoomSync = pendingPinchZoomSyncRef.current;
    previousTimelineZoomContextRef.current = {
      baseWindowPointCount,
      resetKey,
    };

    if (pendingPinchZoomSync) {
      pendingPinchZoomSyncRef.current = null;

      if (pendingPinchZoomSync.windowPointCount === baseWindowPointCount) {
        return;
      }
    }

    if (previousTimelineZoomContext.resetKey !== resetKey) {
      return;
    }

    if (previousTimelineZoomContext.baseWindowPointCount === baseWindowPointCount) {
      return;
    }

    if (points.length === 0 || focusedMarkerId !== null || requestedFocusedMarker !== null || requestedFocusedMarkerId) {
      return;
    }

    const previousWindowPointCount = activeWindowPointCountRef.current;
    const previousWindowStart = windowStartRef.current;
    const previousWindowCenterIndex = previousWindowStart + Math.max(previousWindowPointCount - 1, 0) / 2;
    const nextCenterIndex = clamp(
      Math.round(previousWindowCenterIndex),
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
    const yAxisTransitionDurationMs = shouldPanAfterZoom
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
    isFocusDomainSourceFrozen.value = 0;
    previousWindowBeforeFocusRef.current = null;

    activeWindowPointCountRef.current = baseWindowPointCount;
    windowStartRef.current = clampedWindowStart;
    gestureStartWindowStart.value = clampedWindowStart;
    reportedWindowStart.value = clampedWindowStart;
    viewportZoomAnchorIndex.value = nextCenterIndex;
    animatedWindowStart.value = clampedWindowStart;
    viewportZoomAnchorScreenX.value = centerAnchorScreenX;
    scheduleYAxisDomainUnlock(yAxisTransitionDurationMs);

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
    commitSelection,
    focusedMarkerId,
    gestureStartWindowStart,
    isAxisDragging,
    isFocusDomainSourceFrozen,
    loadRequested,
    plotBaseWindowPointCount,
    points.length,
    releaseScrollLock,
    reportedWindowStart,
    resetKey,
    requestedFocusedMarker,
    requestedFocusedMarkerId,
    scheduleYAxisDomainUnlock,
    viewportWidth,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
    viewportZoomScale,
  ]);

  useEffect(() => {
    if (
      pinchPreviewWindow &&
      pinchPreviewWindow.windowPointCount === safeWindowPointCount &&
      pinchPreviewWindow.windowStart === windowStart
    ) {
      setPinchPreviewWindow(null);
    }
  }, [pinchPreviewWindow, safeWindowPointCount, windowStart]);

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

  const clearActivityDraftDismissTimeout = useCallback(() => {
    if (activityDraftDismissTimeoutRef.current === null) {
      return;
    }

    clearTimeout(activityDraftDismissTimeoutRef.current);
    activityDraftDismissTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    clearActivityDraftDismissTimeout();
    cancelAnimation(activityDraftOpacity);

    const previousActivityDraft = previousActivityDraftRef.current;
    previousActivityDraftRef.current = incomingActivityDraft;

    if (incomingActivityDraft) {
      const isAppearing = previousActivityDraft === null;

      renderedActivityDraftRef.current = incomingActivityDraft;
      setRenderedActivityDraft(incomingActivityDraft);

      if (isAppearing) {
        activityDraftOpacity.value = 0;
      }

      activityDraftOpacity.value = withTiming(1, {
        duration: ACTIVITY_DRAFT_FADE_DURATION_MS,
        easing: Easing.out(Easing.cubic),
      });
      return;
    }

    if (!renderedActivityDraftRef.current) {
      activityDraftOpacity.value = 0;
      return;
    }

    activityDraftOpacity.value = withTiming(0, {
      duration: ACTIVITY_DRAFT_FADE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    });
    activityDraftDismissTimeoutRef.current = setTimeout(() => {
      renderedActivityDraftRef.current = null;
      activityDraftDismissTimeoutRef.current = null;
      setRenderedActivityDraft(null);
    }, ACTIVITY_DRAFT_FADE_DURATION_MS);
  }, [incomingActivityDraft, activityDraftOpacity, clearActivityDraftDismissTimeout]);

  useEffect(() => {
    if (skipLatestWindowChangeRef.current) {
      skipLatestWindowChangeRef.current = false;
      return;
    }

    onViewingLatestWindowChange?.(isViewingLatestWindow);
  }, [isViewingLatestWindow, onViewingLatestWindowChange]);

  useEffect(() => {
    onViewportWindowChange?.({
      windowPointCount: effectiveWindowPointCount,
      windowStart: effectiveWindowStart,
    });
  }, [effectiveWindowPointCount, effectiveWindowStart, onViewportWindowChange]);

  useEffect(() => {
    const hasPendingFocusRequest = requestedFocusedMarker !== null || requestedFocusedMarkerId !== null;

    if (focusedMarker === null && hasPendingFocusRequest) {
      return;
    }

    const nextFocusedMarkerSignature = buildFocusedMarkerReportSignature(focusedMarker);

    if (lastReportedFocusedMarkerSignatureRef.current === nextFocusedMarkerSignature) {
      return;
    }

    lastReportedFocusedMarkerSignatureRef.current = nextFocusedMarkerSignature;

    onFocusedMarkerChange?.(focusedMarker);
  }, [focusedMarker, onFocusedMarkerChange, requestedFocusedMarker, requestedFocusedMarkerId]);

  useEffect(() => {
    cancelAnimation(focusTransitionProgress);
    focusTransitionProgress.value = withTiming(
      focusedMarkerId !== null ? 1 : 0,
      {
        duration: focusTransitionDurationRef.current,
        easing: Easing.out(Easing.cubic),
      },
    );
  }, [cancelAnimation, focusTransitionProgress, focusedMarkerId]);

  useEffect(() => {
    const nextDomain = focusedMarkerDomain ?? visibleWindowDomain ?? baseDomain;

    if (!nextDomain || isYAxisDomainLocked) {
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
  }, [
    baseDomain,
    cancelAnimation,
    focusedDomainMax,
    focusedDomainMin,
    focusedMarkerDomain,
    isYAxisDomainLocked,
    visibleWindowDomain,
  ]);

  useEffect(
    () => () => {
      clearActivityDraftDismissTimeout();
      clearFocusTransitionTimeout();
      clearYAxisTransitionTimeout();
    },
    [clearActivityDraftDismissTimeout, clearFocusTransitionTimeout, clearYAxisTransitionTimeout],
  );

  useEffect(() => releaseScrollLock, [releaseScrollLock]);

  const shouldCaptureScrub = useCallback(
    (_: unknown, gestureState: { dx: number; dy: number; numberActiveTouches?: number }) =>
      activityDraft === null &&
      (gestureState.numberActiveTouches ?? 1) === 1 &&
      Math.abs(gestureState.dx) > 6 &&
      Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
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
      const totalSeriesMinutes = Math.max(
        (points.length - 1) * pointIntervalMinutes,
        MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
      );
      const visibleWindowSpanPointCount = Math.max(safeWindowPointCount - 1, 0);
      const visibleWindowStartMinuteOffset = windowStartRef.current * pointIntervalMinutes;
      const visibleWindowEndMinuteOffset = Math.max(
        visibleWindowStartMinuteOffset + MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
        (windowStartRef.current + visibleWindowSpanPointCount) * pointIntervalMinutes,
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
          0,
          Math.max(totalSeriesMinutes - originSpanMinutes, 0),
        );
        nextEndMinuteOffset = nextStartMinuteOffset + originSpanMinutes;
      } else if (mode === 'resize-start') {
        nextStartMinuteOffset = clamp(
          origin.startMinuteOffset + deltaMinutes,
          0,
          origin.endMinuteOffset - MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
        );
      } else {
        nextEndMinuteOffset = clamp(
          origin.endMinuteOffset + deltaMinutes,
          origin.startMinuteOffset + MIN_ACTIVITY_DRAFT_MINUTE_SPAN,
          totalSeriesMinutes,
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
    [onActivityDraftChange, pointIntervalMinutes, pointSpacing, points.length, safeWindowPointCount],
  );

  const finalizeActivityDraftGesture = useCallback(() => {
    draftGestureOriginRef.current = latestActivityDraftRef.current;
    releaseScrollLock();
    unlockYAxisDomain();
  }, [releaseScrollLock, unlockYAxisDomain]);

  const createActivityDraftResponder = useCallback(
    (mode: 'move' | 'resize-start' | 'resize-end') =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => latestActivityDraftRef.current !== null,
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          latestActivityDraftRef.current !== null &&
          (gestureState.numberActiveTouches ?? 1) === 1 &&
          Math.abs(gestureState.dx) > 4 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          latestActivityDraftRef.current !== null &&
          (gestureState.numberActiveTouches ?? 1) === 1 &&
          Math.abs(gestureState.dx) > 4 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: () => {
          ensureScrollLock();
          lockYAxisDomain();
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
    [applyActivityDraftGesture, commitSelection, ensureScrollLock, finalizeActivityDraftGesture, lockYAxisDomain],
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

  const beginViewportPan = useCallback(() => {
    'worklet';

    cancelAnimation(animatedWindowStart);
    cancelAnimation(viewportZoomScale);
    cancelAnimation(viewportZoomAnchorScreenX);
    isAxisDragging.value = true;
    gestureStartWindowStart.value = animatedWindowStart.value;
    viewportZoomAnchorIndex.value = animatedWindowStart.value;
    viewportZoomAnchorScreenX.value = 0;
    reportedWindowStart.value = clamp(Math.floor(animatedWindowStart.value), 0, maxWindowStartValue.value);
    runOnJS(handleAxisPanStart)();
  }, [
    animatedWindowStart,
    cancelAnimation,
    gestureStartWindowStart,
    handleAxisPanStart,
    isAxisDragging,
    maxWindowStartValue,
    reportedWindowStart,
    viewportZoomAnchorIndex,
    viewportZoomAnchorScreenX,
    viewportZoomScale,
  ]);

  const updateViewportPan = useCallback(
    (translationX: number) => {
      'worklet';

      const nextSafePointSpacing = chartPointSpacingValue.value;
      const visiblePointSpacing = nextSafePointSpacing * Math.max(viewportZoomScale.value, 0.0001);
      if (visiblePointSpacing <= 0) {
        return;
      }

      const nextWindowStartFloat = clamp(
        gestureStartWindowStart.value - translationX / visiblePointSpacing,
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
          translationX,
        })
      ) {
        loadRequested.value = true;
        runOnJS(handleLoadMore)();
      }
    },
    [
      animatedWindowStart,
      canLoadMore,
      chartPointSpacingValue,
      gestureStartWindowStart,
      handleLoadMore,
      isFocusedWindow,
      isLoadingMore,
      loadRequested,
      maxWindowStartValue,
      reportedWindowStart,
      syncWindowStart,
      viewportZoomAnchorIndex,
      viewportZoomScale,
    ],
  );

  const finalizeViewportPan = useCallback(() => {
    'worklet';

    isAxisDragging.value = false;
    const snappedWindowStart = clamp(Math.round(animatedWindowStart.value), 0, maxWindowStartValue.value);
    reportedWindowStart.value = snappedWindowStart;
    animatedWindowStart.value = withTiming(snappedWindowStart, { duration: SNAP_DURATION_MS });
    runOnJS(syncWindowStart)(snappedWindowStart);
    runOnJS(handleAxisPanEnd)();
  }, [
    animatedWindowStart,
    handleAxisPanEnd,
    isAxisDragging,
    maxWindowStartValue,
    reportedWindowStart,
    syncWindowStart,
  ]);

  const axisPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isFocusedWindow)
        .activeOffsetX([-2, 2])
        .failOffsetY([-12, 12])
        .onStart(beginViewportPan)
        .onUpdate((event) => {
          updateViewportPan(event.translationX);
        })
        .onFinalize(finalizeViewportPan),
    [
      beginViewportPan,
      finalizeViewportPan,
      isFocusedWindow,
      updateViewportPan,
    ],
  );
  const canPinchZoom = Boolean(onPinchZoomStepChange && pinchZoomSteps && pinchZoomSteps.length > 1);
  const pinchZoomGesture = useMemo(
    () =>
      Gesture.Pinch()
        .manualActivation(true)
        .enabled(canPinchZoom && !isFocusedWindow)
        .onTouchesDown((event) => {
          const touchMetrics = getPinchTouchMetrics(event.allTouches);
          if (!touchMetrics) {
            return;
          }

          pinchActivationStartDistance.value = touchMetrics.distance;
          pinchActivationStartCenterX.value = touchMetrics.centerX;
          pinchActivationStartCenterY.value = touchMetrics.centerY;
        })
        .onTouchesMove((event, manager) => {
          if (pinchGestureActive.value) {
            return;
          }

          const touchMetrics = getPinchTouchMetrics(event.allTouches);
          if (!touchMetrics) {
            return;
          }

          const startDistance = pinchActivationStartDistance.value > 0
            ? pinchActivationStartDistance.value
            : touchMetrics.distance;
          const deltaCenterX = touchMetrics.centerX - pinchActivationStartCenterX.value;
          const deltaCenterY = touchMetrics.centerY - pinchActivationStartCenterY.value;
          const centerShift = Math.sqrt(deltaCenterX * deltaCenterX + deltaCenterY * deltaCenterY);
          const scaleShift = Math.abs(touchMetrics.distance - startDistance) / Math.max(startDistance, 0.0001);

          if (
            centerShift >= PINCH_ACTIVATION_PAN_THRESHOLD_PX ||
            scaleShift >= PINCH_ACTIVATION_SCALE_THRESHOLD
          ) {
            manager.activate();
          }
        })
        .onTouchesUp((event, manager) => {
          const touchMetrics = getPinchTouchMetrics(event.allTouches);
          if (touchMetrics) {
            pinchActivationStartDistance.value = touchMetrics.distance;
            pinchActivationStartCenterX.value = touchMetrics.centerX;
            pinchActivationStartCenterY.value = touchMetrics.centerY;
            return;
          }

          pinchActivationStartDistance.value = 0;
          pinchActivationStartCenterX.value = 0;
          pinchActivationStartCenterY.value = 0;

          if (!pinchGestureActive.value) {
            manager.fail();
          }
        })
        .onTouchesCancelled((_event, manager) => {
          pinchActivationStartDistance.value = 0;
          pinchActivationStartCenterX.value = 0;
          pinchActivationStartCenterY.value = 0;

          if (!pinchGestureActive.value) {
            manager.fail();
          }
        })
        .onStart((event) => {
          if (!pinchZoomScaleBounds || viewportWidth <= 0) {
            return;
          }

          const nextSafePointSpacing = chartPointSpacingValue.value;
          const currentScale = Math.max(viewportZoomScale.value, 0.0001);
          if (nextSafePointSpacing <= 0) {
            return;
          }

          cancelAnimation(animatedWindowStart);
          cancelAnimation(viewportZoomScale);
          cancelAnimation(viewportZoomAnchorScreenX);

          pinchGestureActive.value = true;
          pinchCommitted.value = false;
          pinchStartZoomScale.value = currentScale;
          pinchAnchorScreenX.value = clamp(event.focalX, 0, viewportWidth);
          pinchAnchorIndex.value = clamp(
            viewportZoomAnchorIndex.value +
              (pinchAnchorScreenX.value - viewportZoomAnchorScreenX.value) /
                (currentScale * nextSafePointSpacing),
            0,
            Math.max(points.length - 1, 0),
          );

          viewportZoomAnchorIndex.value = pinchAnchorIndex.value;
          viewportZoomAnchorScreenX.value = pinchAnchorScreenX.value;
          runOnJS(handlePinchZoomStart)();
        })
        .onUpdate((event) => {
          if (!pinchZoomScaleBounds || viewportWidth <= 0) {
            return;
          }

          const nextSafePointSpacing = chartPointSpacingValue.value;
          if (nextSafePointSpacing <= 0) {
            return;
          }

          const numberOfPointers = (event as { numberOfPointers?: number }).numberOfPointers ?? 2;
          if (numberOfPointers < 2) {
            return;
          }

          const nextScale = applyElasticHeartZoomScaleLimit(
            pinchStartZoomScale.value * event.scale,
            pinchZoomScaleBounds.minZoomScale,
            pinchZoomScaleBounds.maxZoomScale,
          );
          viewportZoomScale.value = nextScale;
          pinchAnchorScreenX.value = clamp(event.focalX, 0, viewportWidth);
          viewportZoomAnchorIndex.value = pinchAnchorIndex.value;
          viewportZoomAnchorScreenX.value = pinchAnchorScreenX.value;

          const nextWindowPointCount = clamp(
            getHeartWindowPointCountForZoomScale(
              plotBaseWindowPointCount,
              clamp(nextScale, pinchZoomScaleBounds.minZoomScale, pinchZoomScaleBounds.maxZoomScale),
            ),
            pinchZoomScaleBounds.minWindowPointCount,
            pinchZoomScaleBounds.maxWindowPointCount,
          );
          const nextWindowStart = clamp(
            pinchAnchorIndex.value - pinchAnchorScreenX.value / Math.max(nextScale * nextSafePointSpacing, 0.0001),
            0,
            Math.max(points.length - nextWindowPointCount, 0),
          );

          runOnJS(syncPinchPreviewWindow)(nextWindowPointCount, nextWindowStart);
        })
        .onEnd(() => {
          if (!pinchZoomSteps || !pinchZoomScaleBounds || viewportWidth <= 0) {
            return;
          }

          const nextSafePointSpacing = chartPointSpacingValue.value;
          if (nextSafePointSpacing <= 0) {
            return;
          }

          const nextWindowPointCount = clamp(
            getHeartWindowPointCountForZoomScale(
              plotBaseWindowPointCount,
              clamp(
                viewportZoomScale.value,
                pinchZoomScaleBounds.minZoomScale,
                pinchZoomScaleBounds.maxZoomScale,
              ),
            ),
            pinchZoomScaleBounds.minWindowPointCount,
            pinchZoomScaleBounds.maxWindowPointCount,
          );
          const nearestStep = resolveNearestHeartPinchZoomStep(nextWindowPointCount, pinchZoomSteps);
          if (!nearestStep) {
            return;
          }

          const targetScale = getHeartViewportZoomScale(plotBaseWindowPointCount, nearestStep.windowPointCount);
          const anchorIndex = clamp(pinchAnchorIndex.value, 0, Math.max(points.length - 1, 0));
          const anchorScreenX = clamp(pinchAnchorScreenX.value, 0, viewportWidth);
          const targetWindowStart = clamp(
            anchorIndex - anchorScreenX / Math.max(targetScale * nextSafePointSpacing, 0.0001),
            0,
            Math.max(points.length - nearestStep.windowPointCount, 0),
          );

          pinchCommitted.value = true;
          runOnJS(commitPinchZoomStep)(
            nearestStep.value,
            nearestStep.windowPointCount,
            targetWindowStart,
            anchorIndex,
          );
        })
        .onFinalize(() => {
          pinchGestureActive.value = false;
          pinchActivationStartDistance.value = 0;
          pinchActivationStartCenterX.value = 0;
          pinchActivationStartCenterY.value = 0;

          if (!pinchCommitted.value) {
            runOnJS(handlePinchZoomCancel)();
          }

          pinchCommitted.value = false;
        }),
    [
      activityDraft,
      animatedWindowStart,
      canPinchZoom,
      cancelAnimation,
      chartPointSpacingValue,
      commitPinchZoomStep,
      handlePinchZoomCancel,
      handlePinchZoomStart,
      isFocusedWindow,
      pinchAnchorIndex,
      pinchAnchorScreenX,
      pinchActivationStartCenterX,
      pinchActivationStartCenterY,
      pinchActivationStartDistance,
      pinchCommitted,
      pinchGestureActive,
      pinchStartZoomScale,
      pinchZoomScaleBounds,
      pinchZoomSteps,
      plotBaseWindowPointCount,
      points.length,
      syncPinchPreviewWindow,
      viewportWidth,
      viewportZoomAnchorIndex,
      viewportZoomAnchorScreenX,
      viewportZoomScale,
    ],
  );

  const animatedMarkerLayerStyle = useAnimatedStyle(
    () => ({
      opacity: 1 - focusTransitionProgress.value,
    }),
    [focusTransitionProgress],
  );
  const animatedActivityDraftViewportStyle = useAnimatedStyle(
    () => ({
      opacity: activityDraftOpacity.value,
    }),
    [activityDraftOpacity],
  );
  const activityDraftBandStartX = activityDraftVisual?.startX ?? 0;
  const activityDraftBandWidth = activityDraftVisual?.bandWidth ?? 0;
  const activityDraftBodyLeft = activityDraftVisual?.bodyLeft ?? 0;
  const activityDraftBodyWidth = activityDraftVisual?.bodyWidth ?? 0;
  const activityDraftInlineBadgeLeft = activityDraftVisual?.inlineBadgeLeft ?? 0;
  const activityDraftStartHandleLeft = activityDraftVisual?.startHandleLeft ?? 0;
  const activityDraftEndHandleLeft = activityDraftVisual?.endHandleLeft ?? 0;
  const activityDraftInlineBadgeCenterX = activityDraftInlineBadgeLeft + MARKER_BADGE_SIZE / 2;
  const activityDraftStartHandleCenterX = activityDraftStartHandleLeft + ACTIVITY_DRAFT_HANDLE_WIDTH / 2;
  const activityDraftEndHandleCenterX = activityDraftEndHandleLeft + ACTIVITY_DRAFT_HANDLE_WIDTH / 2;
  const animatedActivityDraftBandStyle = useAnimatedStyle(
    () => {
      const zoomScale = Math.max(viewportZoomScale.value, 0.0001);

      return {
        left: projectHeartOverlayX(
          activityDraftBandStartX,
          viewportZoomAnchorScreenX.value,
          viewportZoomAnchorIndex.value,
          chartPointSpacingValue.value,
          zoomScale,
        ),
        width: Math.max(activityDraftBandWidth * zoomScale, 2),
      };
    },
    [activityDraftBandStartX, activityDraftBandWidth, chartPointSpacingValue, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );
  const animatedActivityDraftBodyStyle = useAnimatedStyle(
    () => {
      const zoomScale = Math.max(viewportZoomScale.value, 0.0001);

      return {
        left: projectHeartOverlayX(
          activityDraftBodyLeft,
          viewportZoomAnchorScreenX.value,
          viewportZoomAnchorIndex.value,
          chartPointSpacingValue.value,
          zoomScale,
        ),
        width: Math.max(activityDraftBodyWidth * zoomScale, ACTIVITY_DRAFT_BODY_MIN_WIDTH),
      };
    },
    [activityDraftBodyLeft, activityDraftBodyWidth, chartPointSpacingValue, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );
  const animatedActivityDraftBadgeStyle = useAnimatedStyle(
    () => {
      const projectedCenterX = projectHeartOverlayX(
        activityDraftInlineBadgeCenterX,
        viewportZoomAnchorScreenX.value,
        viewportZoomAnchorIndex.value,
        chartPointSpacingValue.value,
        Math.max(viewportZoomScale.value, 0.0001),
      );

      return {
        left: projectedCenterX - MARKER_BADGE_SIZE / 2,
      };
    },
    [activityDraftInlineBadgeCenterX, chartPointSpacingValue, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );
  const animatedActivityDraftStartHandleStyle = useAnimatedStyle(
    () => {
      const projectedCenterX = projectHeartOverlayX(
        activityDraftStartHandleCenterX,
        viewportZoomAnchorScreenX.value,
        viewportZoomAnchorIndex.value,
        chartPointSpacingValue.value,
        Math.max(viewportZoomScale.value, 0.0001),
      );

      return {
        left: projectedCenterX - ACTIVITY_DRAFT_HANDLE_WIDTH / 2,
      };
    },
    [activityDraftStartHandleCenterX, chartPointSpacingValue, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );
  const animatedActivityDraftEndHandleStyle = useAnimatedStyle(
    () => {
      const projectedCenterX = projectHeartOverlayX(
        activityDraftEndHandleCenterX,
        viewportZoomAnchorScreenX.value,
        viewportZoomAnchorIndex.value,
        chartPointSpacingValue.value,
        Math.max(viewportZoomScale.value, 0.0001),
      );

      return {
        left: projectedCenterX - ACTIVITY_DRAFT_HANDLE_WIDTH / 2,
      };
    },
    [activityDraftEndHandleCenterX, chartPointSpacingValue, viewportZoomAnchorIndex, viewportZoomAnchorScreenX, viewportZoomScale],
  );

  if (points.length === 0) {
    return null;
  }

  return (
    <View>
      <View
        onLayout={(event) => {
          setViewportWidth(event.nativeEvent.layout.width);
          setViewportHeight(event.nativeEvent.layout.height);
        }}
        style={[styles.chartArea, { height }]}
        testID={chartTestID ? `${chartTestID}-viewport` : undefined}>
        <GestureDetector gesture={pinchZoomGesture}>
          <View style={styles.chartViewport}>
            <View
              pointerEvents="box-none"
              style={[
                styles.plotViewport,
                {
                  bottom: HEART_PLOT_MARGIN_BOTTOM,
                  top: HEART_PLOT_MARGIN_TOP,
                },
              ]}>
              {visibleMarkerVisuals.length > 0 ? (
                <View pointerEvents="none" style={styles.markerBandClipViewport}>
                  <View pointerEvents="none" style={styles.markerBandViewport}>
                    <Animated.View pointerEvents="none" style={[styles.markerBandLayer, animatedMarkerLayerStyle]}>
                      {visibleMarkerVisuals.map((marker) => (
                        <HeartMarkerBand
                          key={`marker-band-${marker.id}`}
                          chartPointSpacingValue={chartPointSpacingValue}
                          marker={marker}
                          markerBandHeight={markerBandHeight}
                          markerBandRadius={markerBandRadius}
                          markerBandTop={markerBandTop}
                          viewportZoomAnchorIndex={viewportZoomAnchorIndex}
                          viewportZoomAnchorScreenX={viewportZoomAnchorScreenX}
                          viewportZoomScale={viewportZoomScale}
                        />
                      ))}
                    </Animated.View>
                  </View>
                </View>
              ) : null}
              <HeartChartPlotCanvas
                activeSleepStageColor={activeSleepStageColor}
                areas={areas}
                baseDomain={baseDomain}
                baseAccentColor={baseChartAccentColor}
                bridgePaths={bridgePaths}
                chartContentWidth={chartContentWidth}
                chartEndX={chartEndX}
                chartPointSpacingValue={chartPointSpacingValue}
                chartTestID={chartTestID}
                focusTransitionProgress={focusTransitionProgress}
                focusedAccentColor={focusedChartAccentColor}
                guideLineY={guideLineY}
                paths={paths}
                plotHeight={plotViewportHeight}
                sleepStageHighlights={sleepStageHighlights}
                viewportZoomAnchorIndex={viewportZoomAnchorIndex}
                viewportZoomAnchorScreenX={viewportZoomAnchorScreenX}
                viewportZoomScale={viewportZoomScale}
                yAxisDomainMax={focusedDomainMax}
                yAxisDomainMin={focusedDomainMin}
              />
              <View pointerEvents="box-none" style={styles.overlayClipViewport}>
                <View pointerEvents="box-none" style={styles.overlayClipContent}>
                  <View collapsable={false} style={styles.overlay} testID={chartTestID} {...panResponder.panHandlers}>
                    <ChartScrubOverlay
                      backgroundColor={colors.background}
                      chartHeight={plotViewportHeight}
                      chartWidth={viewportWidth}
                      dotTestID={chartTestID ? `${chartTestID}-active-dot` : undefined}
                      dotX={selectionX}
                      dotY={selectionY}
                      guideTestID={chartTestID ? `${chartTestID}-active-guide` : undefined}
                      lineBottom={HEART_CHART_VIEWBOX_HEIGHT}
                      lineOverflowBottom={CHART_OVERLAY_OVERHANG_PX}
                      lineOpacity={0.35}
                      lineOverflowTop={CHART_OVERLAY_OVERHANG_PX}
                      lineTop={0}
                      lineX={selectionX}
                      strokeColor={overlayAccentColor}
                      viewBoxHeight={HEART_CHART_VIEWBOX_HEIGHT}
                      viewBoxWidth={100}
                    />
                  </View>
                  {activityDraftVisual && visibleActivityDraft ? (
                    <Animated.View
                      pointerEvents={activityDraft ? 'box-none' : 'none'}
                      style={[styles.activityDraftViewport, animatedActivityDraftViewportStyle]}>
                      <Animated.View
                        pointerEvents="none"
                        style={[
                          styles.activityDraftBand,
                          animatedActivityDraftBandStyle,
                          {
                            backgroundColor: activityDraftFillColor,
                            borderColor: activityDraftAccentColor,
                            height: activityDraftVisual.bandHeight,
                            top: activityDraftVisual.bandTop,
                          },
                        ]}
                        testID={chartTestID ? `${chartTestID}-draft-band` : undefined}
                      />
                      <Animated.View
                        style={[
                          styles.activityDraftDragBody,
                          animatedActivityDraftBodyStyle,
                          {
                            height: activityDraftVisual.bandHeight,
                            top: activityDraftVisual.bandTop,
                          },
                        ]}
                        testID={chartTestID ? `${chartTestID}-draft-body` : undefined}
                        {...activityDraftBodyResponder.panHandlers}
                      />
                      <Animated.View
                        style={[
                          styles.activityDraftHandle,
                          animatedActivityDraftStartHandleStyle,
                          {
                            height: activityDraftVisual.handleHeight,
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
                      </Animated.View>
                      <Animated.View
                        style={[
                          styles.activityDraftHandle,
                          animatedActivityDraftEndHandleStyle,
                          {
                            height: activityDraftVisual.handleHeight,
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
                      </Animated.View>
                    </Animated.View>
                  ) : null}
                </View>
              </View>
              <View pointerEvents="box-none" style={styles.markerClipViewport}>
                <View pointerEvents="box-none" style={styles.markerClipContent}>
                  {activityDraftBadgeMarker ? (
                    <Animated.View
                      pointerEvents="none"
                      style={[
                        styles.activityDraftInlineBadgeWrap,
                        animatedActivityDraftViewportStyle,
                        animatedActivityDraftBadgeStyle,
                        {
                          top: activityDraftVisual?.inlineBadgeTop ?? 0,
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
                    </Animated.View>
                  ) : null}
                  <View pointerEvents={isFocusedWindow || visibleActivityDraft ? 'none' : 'box-none'} style={styles.markerViewport}>
                    {visibleMarkerVisuals.length > 0 ? (
                      <Animated.View pointerEvents="box-none" style={[styles.markerLayer, animatedMarkerLayerStyle]}>
                        {visibleMarkerVisuals.map((marker) => (
                          <HeartMarkerBadge
                            key={`marker-badge-${marker.id}`}
                            chartPointSpacingValue={chartPointSpacingValue}
                            marker={marker}
                            onPress={marker.isZoomable ? () => handleMarkerZoomPress(marker) : undefined}
                            viewportZoomAnchorIndex={viewportZoomAnchorIndex}
                            viewportZoomAnchorScreenX={viewportZoomAnchorScreenX}
                            viewportZoomScale={viewportZoomScale}
                          />
                        ))}
                      </Animated.View>
                    ) : null}
                  </View>
                </View>
              </View>
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
                accentColor={overlayAccentColor}
                label={selectionPoint.label}
                size="compact"
                testID={chartTestID ? `${chartTestID}-selection-bubble` : undefined}
                value={formatHeartSelectionValue(selectionPoint.value)}
              />
            </View>
          ) : null}
          </View>
        </GestureDetector>
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
    overflow: 'visible',
    position: 'relative',
  },
  plotViewport: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'visible',
  },
  markerBandClipViewport: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  markerBandViewport: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayClipViewport: {
    bottom: -CHART_OVERLAY_OVERHANG_PX,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: -CHART_OVERLAY_OVERHANG_PX,
  },
  overlayClipContent: {
    bottom: CHART_OVERLAY_OVERHANG_PX,
    left: 0,
    position: 'absolute',
    right: 0,
    top: CHART_OVERLAY_OVERHANG_PX,
  },
  markerClipViewport: {
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: -MARKER_BADGE_SIZE / 2,
  },
  markerClipContent: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: MARKER_BADGE_SIZE / 2,
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
  chartTestProbe: {
    height: 0,
    left: 0,
    opacity: 0,
    position: 'absolute',
    top: 0,
    width: 0,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  activityDraftViewport: {
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
