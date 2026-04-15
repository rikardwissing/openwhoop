import { Ionicons } from '@expo/vector-icons';
import {
  Canvas,
  DashPathEffect,
  LinearGradient as SkiaLinearGradient,
  Path as SkiaPath,
  RoundedRect as SkiaRoundedRect,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import {
  TREND_VIEWBOX_BASELINE,
  TREND_VIEWBOX_WIDTH,
  buildTrendDomain,
  buildTrendCoordinates,
  buildTrendLineGeometry,
  mapTrendValueToY,
  selectTrendPointAtX,
} from '@/components/charts/chartSelection';
import { ChartSelectionBubble } from '@/components/charts/ChartSelectionBubble';
import { ChartScrubOverlay } from '@/components/charts/ChartScrubOverlay';
import { useAcquireScreenScrollLock } from '@/components/layout/ScreenScrollContext';
import { colors, typography } from '@/constants/theme';
import type { TrendPoint, TrendSelection } from '@/types/health';
import { formatMetricValue } from '@/utils/formatters';

const TREND_VIEWBOX_HEIGHT = TREND_VIEWBOX_BASELINE + 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

  const alphaHex = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${normalizedHex}${alphaHex}`;
}

function isTrendSvgPathCommand(token: string) {
  return token.length === 1 && /[A-Z]/.test(token);
}

function scaleTrendSvgPath(path: string, scaleX: number, scaleY: number) {
  if (!path || (Math.abs(scaleX - 1) < 0.0001 && Math.abs(scaleY - 1) < 0.0001)) {
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

        if (!xToken || !yToken || isTrendSvgPathCommand(xToken) || isTrendSvgPathCommand(yToken)) {
          break;
        }

        const xValue = Number(xToken);
        const yValue = Number(yToken);
        scaledTokens.push(Number.isFinite(xValue) ? String(xValue * scaleX) : xToken);
        scaledTokens.push(Number.isFinite(yValue) ? String(yValue * scaleY) : yToken);
        index += 2;
      }

      continue;
    }

    if (token === 'H') {
      while (index < tokens.length) {
        const xToken = tokens[index];
        if (!xToken || isTrendSvgPathCommand(xToken)) {
          break;
        }

        const xValue = Number(xToken);
        scaledTokens.push(Number.isFinite(xValue) ? String(xValue * scaleX) : xToken);
        index += 1;
      }

      continue;
    }

    if (token === 'V') {
      while (index < tokens.length) {
        const yToken = tokens[index];
        if (!yToken || isTrendSvgPathCommand(yToken)) {
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

function makeTrendSkPath(path: string) {
  return path ? Skia.Path.MakeFromSVGString(path) ?? Skia.Path.Make() : Skia.Path.Make();
}

interface TrendBarFrame {
  baselineY: number;
  height: number;
  index: number;
  width: number;
  x: number;
  y: number;
}

function buildBarFrames(
  coordinates: Array<{ x: number; y: number | null }>,
  domain: { min: number; max: number } | null,
): Array<TrendBarFrame | null> {
  if (coordinates.length === 0 || !domain) {
    return [];
  }

  const spacing = coordinates.length === 1 ? 22 : coordinates[1]!.x - coordinates[0]!.x;
  const width = clamp(spacing * 0.62, 1.8, 18);
  const baselineValue = domain.min < 0 && domain.max > 0 ? 0 : domain.max <= 0 ? domain.max : domain.min;
  const baselineY = mapTrendValueToY(baselineValue, domain);

  return coordinates.map((coordinate, index) => {
    if (coordinate.y === null) {
      return null;
    }

    return {
      baselineY,
      height: Math.max(Math.abs(baselineY - coordinate.y), 0.9),
      index,
      width,
      x: clamp(coordinate.x - width / 2, 0, TREND_VIEWBOX_WIDTH - width),
      y: Math.min(coordinate.y, baselineY),
    };
  });
}

export interface TrendChartMarker {
  id: string;
  iconName: keyof typeof Ionicons.glyphMap;
  accentColor: string;
  backgroundColor: string;
  startFraction: number;
  endFraction: number;
  accessibilityLabel?: string;
}

function clampFraction(value: number) {
  return Math.min(1, Math.max(0, value));
}

function sanitizeMarkerId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function formatTrendSelectionValue(value: number | null) {
  if (value === null) {
    return 'No data';
  }

  return formatMetricValue(value, Number.isInteger(value) ? 0 : 1);
}

export function TrendChart({
  points,
  accentColor,
  axisLabels,
  onAxisLayout,
  axisTestID,
  barColorForPoint,
  height = 148,
  lineStrokeWidth = 1,
  markers = [],
  mode = 'line',
  onAxisPan,
  onSelectionChange,
  selectionValueFormatter,
  shadowStrokeWidth = 2.1,
  testID,
}: {
  points: TrendPoint[];
  accentColor: string;
  axisLabels?: [string | undefined, string | undefined, string | undefined];
  onAxisLayout?: (width: number) => void;
  axisTestID?: string;
  barColorForPoint?: (point: TrendPoint, index: number) => string | undefined;
  height?: number;
  lineStrokeWidth?: number;
  markers?: TrendChartMarker[];
  mode?: 'line' | 'bar';
  onAxisPan?: (event: { phase: 'start' | 'move' | 'end'; dx: number }) => void;
  onSelectionChange?: (selection: TrendSelection | null) => void;
  selectionValueFormatter?: (selection: TrendSelection) => string;
  shadowStrokeWidth?: number;
  testID?: string;
}) {
  const [chartWidth, setChartWidth] = useState(0);
  const [selection, setSelection] = useState<TrendSelection | null>(null);
  const selectionRef = useRef<TrendSelection | null>(null);
  const releaseScrollLockRef = useRef<(() => void) | null>(null);
  const acquireScreenScrollLock = useAcquireScreenScrollLock();

  const domain = useMemo(() => buildTrendDomain(points, { mode }), [mode, points]);
  const coordinates = useMemo(() => buildTrendCoordinates(points, { mode, domain }), [domain, mode, points]);
  const barFrames = useMemo(() => buildBarFrames(coordinates, domain), [coordinates, domain]);
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
  const selectedCoordinate = selection ? coordinates[selection.index] ?? null : null;
  const selectedBar = selection ? barFrames[selection.index] ?? null : null;
  const activeCoordinate =
    mode === 'line' && selectedCoordinate && selectedCoordinate.y !== null
      ? { x: selectedCoordinate.x, y: selectedCoordinate.y }
      : null;
  const activeX =
    mode === 'bar'
      ? selectedBar
        ? selectedBar.x + selectedBar.width / 2
        : selectedCoordinate?.x ?? null
      : selectedCoordinate?.x ?? null;
  const guideLineY =
    domain && domain.min < 0 && domain.max > 0
      ? mapTrendValueToY(0, domain)
      : 24;
  const markerVisuals = useMemo(
    () =>
      markers.map((marker) => {
        const startFraction = clampFraction(marker.startFraction);
        const endFraction = clampFraction(Math.max(marker.startFraction, marker.endFraction));
        const midpoint = clampFraction((startFraction + endFraction) / 2);

        return {
          ...marker,
          badgeFraction: clampFraction(Math.min(0.94, Math.max(0.06, midpoint))),
          bandWidth: Math.max((endFraction - startFraction) * 100, 0.8),
          startX: startFraction * 100,
          testID: testID ? `${testID}-marker-${sanitizeMarkerId(marker.id)}` : undefined,
        };
      }),
    [markers, testID],
  );
  const scaleX = chartWidth > 0 ? chartWidth / TREND_VIEWBOX_WIDTH : 0;
  const scaleY = height / TREND_VIEWBOX_HEIGHT;
  const scaledPathStrokeWidth = Math.max(lineStrokeWidth * scaleY, 0.8);
  const scaledShadowStrokeWidth = Math.max(shadowStrokeWidth * scaleY, scaledPathStrokeWidth);
  const scaledMarkerBandHeight = 31 * scaleY;
  const scaledMarkerBandY = 3 * scaleY;
  const scaledMarkerBandRadius = Math.max(3 * Math.min(scaleX || 1, scaleY), 0.5);
  const guideLinePath = useMemo(
    () => makeTrendSkPath(`M 0 ${guideLineY * scaleY} L ${chartWidth} ${guideLineY * scaleY}`),
    [chartWidth, guideLineY, scaleY],
  );
  const scaledAreas = useMemo(
    () => areas.map((path) => makeTrendSkPath(scaleTrendSvgPath(path, scaleX, scaleY))),
    [areas, scaleX, scaleY],
  );
  const scaledPaths = useMemo(
    () => paths.map((path) => makeTrendSkPath(scaleTrendSvgPath(path, scaleX, scaleY))),
    [paths, scaleX, scaleY],
  );
  const scaledBridgePaths = useMemo(
    () => bridgePaths.map((path) => makeTrendSkPath(scaleTrendSvgPath(path, scaleX, scaleY))),
    [bridgePaths, scaleX, scaleY],
  );

  const commitSelection = useCallback(
    (nextSelection: TrendSelection | null) => {
      const current = selectionRef.current;
      const isSame =
        current?.index === nextSelection?.index &&
        current?.point.label === nextSelection?.point.label &&
        current?.point.value === nextSelection?.point.value;

      if (isSame) {
        return;
      }

      selectionRef.current = nextSelection;
      setSelection(nextSelection);
      onSelectionChange?.(nextSelection);
    },
    [onSelectionChange],
  );

  const updateSelection = useCallback(
    (touchX: number) => {
      commitSelection(selectTrendPointAtX(points, chartWidth, touchX, { mode }));
    },
    [chartWidth, commitSelection, mode, points],
  );

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

  useEffect(() => {
    commitSelection(null);
    releaseScrollLock();
  }, [commitSelection, points, releaseScrollLock]);

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

  if (points.length === 0) {
    return null;
  }

  const [start, end] = colorStops(accentColor);
  const labels = axisLabels ?? [points[0]?.label, points[Math.floor(points.length / 2)]?.label, points.at(-1)?.label];

  const axisPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => Boolean(onAxisPan),
        onStartShouldSetPanResponderCapture: () => Boolean(onAxisPan),
        onMoveShouldSetPanResponder: (_event, gestureState) =>
          Boolean(onAxisPan) && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          Boolean(onAxisPan) && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: () => {
          ensureScrollLock();
          onAxisPan?.({ phase: 'start', dx: 0 });
        },
        onPanResponderMove: (_, gestureState) => {
          onAxisPan?.({ phase: 'move', dx: gestureState.dx });
        },
        onPanResponderRelease: (_, gestureState) => {
          onAxisPan?.({ phase: 'end', dx: gestureState.dx });
          releaseScrollLock();
        },
        onPanResponderTerminate: (_, gestureState) => {
          onAxisPan?.({ phase: 'end', dx: gestureState.dx });
          releaseScrollLock();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [ensureScrollLock, onAxisPan, releaseScrollLock],
  );

  return (
    <View>
      <View
        onLayout={(event) => {
          setChartWidth(event.nativeEvent.layout.width);
        }}
        testID={testID ? `${testID}-viewport` : undefined}
        style={[styles.chartArea, { height }]}>
        <Canvas style={styles.canvas}>
          {markerVisuals.map((marker) => (
            <SkiaRoundedRect
              color={marker.backgroundColor}
              height={scaledMarkerBandHeight}
              key={`marker-band-${marker.id}`}
              r={scaledMarkerBandRadius}
              width={marker.bandWidth * scaleX}
              x={marker.startX * scaleX}
              y={scaledMarkerBandY}
            />
          ))}
          <SkiaPath color="rgba(149, 162, 188, 0.22)" path={guideLinePath} strokeWidth={Math.max(0.7 * scaleY, 0.7)} style="stroke">
            <DashPathEffect intervals={[Math.max(3 * scaleX, 1), Math.max(3 * scaleX, 1)]} />
          </SkiaPath>
          {mode === 'line'
            ? scaledAreas.map((area, index) => (
                <SkiaPath key={`area-${index}`} path={area} style="fill">
                  <SkiaLinearGradient
                    colors={[hexColorWithOpacity(end, 0.32), hexColorWithOpacity(start, 0.02)]}
                    end={vec(0, height)}
                    start={vec(0, 0)}
                  />
                </SkiaPath>
              ))
            : barFrames.map((bar) => {
                if (!bar) {
                  return null;
                }

                const point = points[bar.index] ?? { label: '', value: null };
                const customColor = barColorForPoint?.(point, bar.index);
                const isSelected = selection?.index === bar.index;
                const barWidth = bar.width * scaleX;
                const barHeight = bar.height * scaleY;
                const barX = bar.x * scaleX;
                const barY = bar.y * scaleY;
                const radius = Math.min(barWidth / 2, 1.6 * Math.min(scaleX || 1, scaleY));

                return (
                  <Fragment key={`bar-wrap-${bar.index}`}>
                    <SkiaRoundedRect
                      color={customColor}
                      height={barHeight}
                      opacity={isSelected ? 1 : 0.82}
                      r={radius}
                      width={barWidth}
                      x={barX}
                      y={barY}>
                      {customColor ? null : (
                        <SkiaLinearGradient
                          colors={[hexColorWithOpacity(end, 0.94), hexColorWithOpacity(start, 0.34)]}
                          end={vec(0, barY + barHeight)}
                          start={vec(0, barY)}
                        />
                      )}
                    </SkiaRoundedRect>
                    {isSelected ? (
                      <SkiaRoundedRect
                        color={customColor ?? accentColor}
                        height={barHeight}
                        opacity={0.44}
                        r={radius}
                        strokeWidth={Math.max(0.5 * Math.min(scaleX || 1, scaleY), 0.5)}
                        style="stroke"
                        width={barWidth}
                        x={barX}
                        y={barY}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
          {mode === 'line'
            ? scaledBridgePaths.map((path, index) => (
                <SkiaPath
                  color={colors.subtle}
                  key={`bridge-${index}`}
                  opacity={0.72}
                  path={path}
                  strokeCap="round"
                  strokeWidth={Math.max(lineStrokeWidth * 0.85 * scaleY, 0.7)}
                  style="stroke">
                  <DashPathEffect intervals={[Math.max(2.2 * scaleX, 1), Math.max(2.2 * scaleX, 1)]} />
                </SkiaPath>
              ))
            : null}
          {mode === 'line'
            ? scaledPaths.map((path, index) => (
                <SkiaPath
                  color="rgba(86, 246, 255, 0.12)"
                  key={`shadow-${index}`}
                  path={path}
                  strokeWidth={scaledShadowStrokeWidth}
                  style="stroke"
                />
              ))
            : null}
          {mode === 'line'
            ? scaledPaths.map((path, index) => (
                <SkiaPath
                  key={`line-${index}`}
                  path={path}
                  strokeCap="round"
                  strokeWidth={scaledPathStrokeWidth}
                  style="stroke">
                  <SkiaLinearGradient
                    colors={[start, end]}
                    end={vec(chartWidth, 0)}
                    start={vec(0, height)}
                  />
                </SkiaPath>
              ))
            : null}
        </Canvas>
        {markerVisuals.length > 0 ? (
          <View pointerEvents="none" style={styles.markerLayer}>
            {markerVisuals.map((marker) => (
              <View
                accessibilityLabel={marker.accessibilityLabel}
                key={`marker-badge-${marker.id}`}
                style={[
                  styles.markerBadge,
                  {
                    backgroundColor: colors.surfaceStrong,
                    borderColor: marker.accentColor,
                    left: `${marker.badgeFraction * 100}%`,
                    top: 8,
                  },
                ]}
                testID={marker.testID}>
                <Ionicons color={marker.accentColor} name={marker.iconName} size={12} />
              </View>
            ))}
          </View>
        ) : null}
        <View
          collapsable={false}
          style={styles.overlay}
          testID={testID}
          {...panResponder.panHandlers}>
          <ChartScrubOverlay
            backgroundColor={colors.background}
            chartHeight={height}
            chartWidth={chartWidth}
            dotTestID={testID ? `${testID}-active-dot` : undefined}
            dotX={activeCoordinate?.x ?? null}
            dotY={activeCoordinate?.y ?? null}
            guideTestID={testID ? `${testID}-active-guide` : undefined}
            lineBottom={TREND_VIEWBOX_BASELINE}
            lineOpacity={mode === 'bar' ? 0.26 : 0.35}
            lineTop={2}
            lineX={activeX}
            strokeColor={accentColor}
            viewBoxHeight={TREND_VIEWBOX_HEIGHT}
            viewBoxWidth={TREND_VIEWBOX_WIDTH}
          />
        </View>
        {selection ? (
          <View
            pointerEvents="none"
            style={[
              styles.selectionBubbleWrap,
              activeX !== null && activeX > 50 ? styles.selectionBubbleWrapLeft : styles.selectionBubbleWrapRight,
              { top: markerVisuals.length > 0 ? 36 : 6 },
            ]}>
            <ChartSelectionBubble
              accentColor={accentColor}
              label={selection.point.label}
              size="compact"
              testID={testID ? `${testID}-selection-bubble` : undefined}
              value={selectionValueFormatter?.(selection) ?? formatTrendSelectionValue(selection.point.value)}
            />
          </View>
        ) : null}
      </View>
      <View
        onLayout={(event) => {
          onAxisLayout?.(event.nativeEvent.layout.width);
        }}
        style={styles.axis}
        testID={axisTestID}
        {...(onAxisPan ? axisPanResponder.panHandlers : {})}>
        {labels.map((label, index) => (
          <Text key={`${label ?? 'axis'}-${index}`} style={styles.axisLabel}>
            {label ?? ''}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chartArea: {
    position: 'relative',
    width: '100%',
  },
  canvas: {
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
    marginLeft: -12,
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
