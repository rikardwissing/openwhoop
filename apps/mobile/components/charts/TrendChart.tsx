import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Line,
  Path,
  Stop,
} from 'react-native-svg';

import {
  TREND_VIEWBOX_BASELINE,
  buildTrendCoordinates,
  selectTrendPointAtX,
} from '@/components/charts/chartSelection';
import { colors, typography } from '@/constants/theme';
import type { TrendPoint, TrendSelection } from '@/types/health';

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

export function TrendChart({
  points,
  accentColor,
  height = 148,
  onSelectionChange,
  testID,
}: {
  points: TrendPoint[];
  accentColor: string;
  height?: number;
  onSelectionChange?: (selection: TrendSelection | null) => void;
  testID?: string;
}) {
  const [chartWidth, setChartWidth] = useState(0);
  const [selection, setSelection] = useState<TrendSelection | null>(null);
  const selectionRef = useRef<TrendSelection | null>(null);
  const chartId = useId().replace(/[:]/g, '');

  const coordinates = useMemo(() => buildTrendCoordinates(points), [points]);
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
  const selectedCoordinate = selection ? coordinates[selection.index] ?? null : null;
  const activeCoordinate =
    selectedCoordinate && selectedCoordinate.y !== null
      ? { x: selectedCoordinate.x, y: selectedCoordinate.y }
      : null;
  const activeX = selectedCoordinate?.x ?? null;

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
      commitSelection(selectTrendPointAtX(points, chartWidth, touchX));
    },
    [chartWidth, commitSelection, points],
  );

  useEffect(() => {
    commitSelection(null);
  }, [commitSelection, points]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          Math.abs(gestureState.dx) > 6 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderGrant: (event) => {
          updateSelection(event.nativeEvent.locationX);
        },
        onPanResponderMove: (event) => {
          updateSelection(event.nativeEvent.locationX);
        },
        onPanResponderRelease: () => {
          commitSelection(null);
        },
        onPanResponderTerminate: () => {
          commitSelection(null);
        },
        // Keep the scrub gesture attached to the chart until the user lifts
        // their finger so the parent ScrollView cannot steal the interaction
        // when the touch path drifts vertically.
        onPanResponderTerminationRequest: () => false,
      }),
    [commitSelection, updateSelection],
  );

  if (points.length === 0) {
    return null;
  }

  const [start, end] = colorStops(accentColor);
  const labels = [points[0]?.label, points[Math.floor(points.length / 2)]?.label, points.at(-1)?.label];

  return (
    <View>
      <View
        onLayout={(event) => {
          setChartWidth(event.nativeEvent.layout.width);
        }}
        style={[styles.chartArea, { height }]}>
        <Svg height="100%" viewBox="0 0 100 40" width="100%">
          <Defs>
            <SvgLinearGradient id={`${chartId}-stroke`} x1="0%" x2="100%" y1="100%" y2="0%">
              <Stop offset="0%" stopColor={start} />
              <Stop offset="100%" stopColor={end} />
            </SvgLinearGradient>
            <SvgLinearGradient id={`${chartId}-fill`} x1="0%" x2="0%" y1="0%" y2="100%">
              <Stop offset="0%" stopColor={end} stopOpacity="0.32" />
              <Stop offset="100%" stopColor={start} stopOpacity="0.02" />
            </SvgLinearGradient>
          </Defs>
          <Line
            stroke="rgba(149, 162, 188, 0.22)"
            strokeDasharray="3 3"
            strokeWidth="0.7"
            x1="0"
            x2="100"
            y1="24"
            y2="24"
          />
          {activeX !== null ? (
            <Line
              stroke={accentColor}
              strokeDasharray="2 2"
              strokeOpacity="0.35"
              strokeWidth="0.7"
              x1={activeX}
              x2={activeX}
              y1="2"
              y2={TREND_VIEWBOX_BASELINE}
            />
          ) : null}
          {areas.map((area, index) => (
            <Path key={`area-${index}`} d={area} fill={`url(#${chartId}-fill)`} />
          ))}
          {paths.map((path, index) => (
            <Path
              key={`shadow-${index}`}
              d={path}
              fill="none"
              stroke="rgba(86, 246, 255, 0.12)"
              strokeWidth="2.1"
            />
          ))}
          {paths.map((path, index) => (
            <Path
              key={`line-${index}`}
              d={path}
              fill="none"
              stroke={`url(#${chartId}-stroke)`}
              strokeLinecap="round"
              strokeWidth="1"
            />
          ))}
          {activeCoordinate ? (
            <>
              <Circle
                cx={activeCoordinate.x}
                cy={activeCoordinate.y}
                fill={accentColor}
                opacity="0.18"
                r="4.6"
              />
              <Circle
                cx={activeCoordinate.x}
                cy={activeCoordinate.y}
                fill={accentColor}
                r="1.9"
                stroke={colors.background}
                strokeWidth="0.9"
              />
            </>
          ) : null}
        </Svg>
        <View
          collapsable={false}
          style={styles.overlay}
          testID={testID}
          {...panResponder.panHandlers}
        />
      </View>
      <View style={styles.axis}>
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
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -6,
  },
  axisLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
  },
});
