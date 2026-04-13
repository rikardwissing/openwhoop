import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Line,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

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
  const chartId = useId().replace(/[:]/g, '');
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
      markers.map((marker, index) => {
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
        // Keep the scrub gesture attached to the chart until the user lifts
        // their finger so the parent ScrollView cannot steal the interaction
        // when the touch path drifts vertically.
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
        <Svg height="100%" preserveAspectRatio="none" viewBox="0 0 100 40" width="100%">
          <Defs>
            <SvgLinearGradient id={`${chartId}-stroke`} x1="0%" x2="100%" y1="100%" y2="0%">
              <Stop offset="0%" stopColor={start} />
              <Stop offset="100%" stopColor={end} />
            </SvgLinearGradient>
            <SvgLinearGradient id={`${chartId}-fill`} x1="0%" x2="0%" y1="0%" y2="100%">
              <Stop offset="0%" stopColor={end} stopOpacity="0.32" />
              <Stop offset="100%" stopColor={start} stopOpacity="0.02" />
            </SvgLinearGradient>
            <SvgLinearGradient id={`${chartId}-bar`} x1="0%" x2="0%" y1="0%" y2="100%">
              <Stop offset="0%" stopColor={end} stopOpacity="0.94" />
              <Stop offset="100%" stopColor={start} stopOpacity="0.34" />
            </SvgLinearGradient>
          </Defs>
          {markerVisuals.map((marker) => (
            <Rect
              key={`marker-band-${marker.id}`}
              fill={marker.backgroundColor}
              height="31"
              rx="3"
              ry="3"
              width={marker.bandWidth}
              x={marker.startX}
              y="3"
            />
          ))}
          <Line
            stroke="rgba(149, 162, 188, 0.22)"
            strokeDasharray="3 3"
            strokeWidth="0.7"
            x1="0"
            x2="100"
            y1={guideLineY}
            y2={guideLineY}
          />
          {mode === 'line'
            ? areas.map((area, index) => <Path key={`area-${index}`} d={area} fill={`url(#${chartId}-fill)`} />)
            : barFrames.map((bar) =>
                bar ? (
                  <Rect
                    key={`bar-${bar.index}`}
                    fill={barColorForPoint?.(points[bar.index] ?? { label: '', value: null }, bar.index) ?? `url(#${chartId}-bar)`}
                    fillOpacity={selection?.index === bar.index ? 1 : 0.88}
                    height={bar.height}
                    opacity={selection?.index === bar.index ? 1 : 0.92}
                    rx={Math.min(bar.width / 2, 1.6)}
                    ry={Math.min(bar.width / 2, 1.6)}
                    stroke={
                      selection?.index === bar.index
                        ? barColorForPoint?.(points[bar.index] ?? { label: '', value: null }, bar.index) ?? accentColor
                        : 'transparent'
                    }
                    strokeOpacity={selection?.index === bar.index ? 0.44 : 0}
                    strokeWidth={selection?.index === bar.index ? 0.5 : 0}
                    testID={testID ? `${testID}-bar-${bar.index}` : undefined}
                    width={bar.width}
                    x={bar.x}
                    y={bar.y}
                  />
                ) : null,
              )}
          {mode === 'line'
            ? bridgePaths.map((path, index) => (
                <Path
                  key={`bridge-${index}`}
                  d={path}
                  fill="none"
                  stroke={colors.subtle}
                  strokeDasharray="2.2 2.2"
                  strokeLinecap="round"
                  strokeOpacity="0.72"
                  strokeWidth={Math.max(lineStrokeWidth * 0.85, 0.7)}
                  testID={testID ? `${testID}-bridge-${index}` : undefined}
                />
              ))
            : null}
          {mode === 'line'
            ? paths.map((path, index) => (
                <Path
                  key={`shadow-${index}`}
                  d={path}
                  fill="none"
                  stroke="rgba(86, 246, 255, 0.12)"
                  strokeWidth={shadowStrokeWidth}
                />
              ))
            : null}
          {mode === 'line'
            ? paths.map((path, index) => (
                <Path
                  key={`line-${index}`}
                  d={path}
                  fill="none"
                  stroke={`url(#${chartId}-stroke)`}
                  strokeLinecap="round"
                  strokeWidth={lineStrokeWidth}
                />
              ))
            : null}
        </Svg>
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
