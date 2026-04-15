import {
  Canvas,
  Group as SkiaGroup,
  Rect as SkiaRect,
  RoundedRect as SkiaRoundedRect,
  Skia,
} from '@shopify/react-native-skia';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

import {
  buildSleepStageFrames,
  selectSleepStageAtX,
} from '@/components/charts/chartSelection';
import { ChartSelectionBubble } from '@/components/charts/ChartSelectionBubble';
import { useAcquireScreenScrollLock } from '@/components/layout/ScreenScrollContext';
import { colors, sleepStageColors, typography } from '@/constants/theme';
import type { SleepStage, SleepStageSegment, SleepStageSelection } from '@/types/health';
import {
  formatClockRangeFromStartLabel,
  formatShortDuration,
  formatSleepStageLabel,
} from '@/utils/formatters';

const chartMetrics = {
  axisPaddingHorizontal: 12,
  axisMarginTop: 10,
  barHeight: 46,
  barRadius: 4,
  barY: 3,
  chartHeight: 52,
  shellPaddingBottom: 10,
  shellPaddingHorizontal: 12,
  shellPaddingTop: 6,
  viewboxHeight: 52,
};

const sleepStageViewBoxWidth = 100;

export function SleepStageChart({
  segments,
  startLabel,
  middleLabel,
  endLabel,
  accentColor = colors.cyan,
  highlightedStage = null,
  onSelectionChange,
  testID,
}: {
  segments: SleepStageSegment[];
  startLabel: string;
  middleLabel: string;
  endLabel: string;
  accentColor?: string;
  highlightedStage?: SleepStage | null;
  onSelectionChange?: (selection: SleepStageSelection | null) => void;
  testID?: string;
}) {
  const [chartWidth, setChartWidth] = useState(0);
  const [selection, setSelection] = useState<SleepStageSelection | null>(null);
  const selectionRef = useRef<SleepStageSelection | null>(null);
  const releaseScrollLockRef = useRef<(() => void) | null>(null);
  const frames = useMemo(() => buildSleepStageFrames(segments), [segments]);
  const selectedFrame = selection ? frames.find((frame) => frame.index === selection.index) ?? null : null;
  const acquireScreenScrollLock = useAcquireScreenScrollLock();
  const scaleX = chartWidth > 0 ? chartWidth / sleepStageViewBoxWidth : 0;
  const trackClip = useMemo(
    () =>
      Skia.RRectXY(
        Skia.XYWHRect(0, chartMetrics.barY, chartWidth, chartMetrics.barHeight),
        chartMetrics.barRadius,
        chartMetrics.barRadius,
      ),
    [chartWidth],
  );
  const activeHighlightedStage = selection?.segment.stage ?? highlightedStage;

  const commitSelection = useCallback(
    (nextSelection: SleepStageSelection | null) => {
      const current = selectionRef.current;
      const isSame =
        current?.index === nextSelection?.index &&
        current?.startMinute === nextSelection?.startMinute &&
        current?.endMinute === nextSelection?.endMinute;

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
      commitSelection(selectSleepStageAtX(segments, chartWidth, touchX));
    },
    [chartWidth, commitSelection, segments],
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
  }, [commitSelection, releaseScrollLock, segments]);

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

  return (
    <View style={styles.root}>
      <View
        style={[
          styles.chartShell,
          {
            paddingBottom: chartMetrics.shellPaddingBottom,
            paddingHorizontal: chartMetrics.shellPaddingHorizontal,
            paddingTop: chartMetrics.shellPaddingTop,
          },
        ]}>
        <View
          onLayout={(event) => {
            setChartWidth(event.nativeEvent.layout.width);
          }}
          testID={testID ? `${testID}-viewport` : undefined}
          style={[styles.chartArea, { height: chartMetrics.chartHeight }]}>
          <Canvas style={styles.canvas}>
            <SkiaRoundedRect
              color={colors.surfaceMuted}
              height={chartMetrics.barHeight}
              r={chartMetrics.barRadius}
              width={chartWidth}
              x={0}
              y={chartMetrics.barY}
            />
            <SkiaGroup clip={trackClip}>
              {frames.map((frame) => {
                const isSelected = selection?.index === frame.index;
                const width = Math.max(frame.width * scaleX, 0.8 * Math.max(scaleX, 1));
                const x = frame.startX * scaleX;
                const opacity = selection
                  ? isSelected
                    ? 1
                    : 0.38
                  : activeHighlightedStage
                    ? frame.segment.stage === activeHighlightedStage
                      ? frame.segment.stage === 'awake' ? 0.94 : 1
                      : 0.38
                    : frame.segment.stage === 'awake'
                      ? 0.94
                      : 1;

                return (
                  <Fragment key={`${frame.segment.stage}-${frame.index}`}>
                    <SkiaRect
                      color={sleepStageColors[frame.segment.stage]}
                      height={chartMetrics.barHeight}
                      opacity={opacity}
                      width={width}
                      x={x}
                      y={chartMetrics.barY}
                    />
                    {!selection || !isSelected ? (
                      <SkiaRect
                        color="rgba(255,255,255,0.10)"
                        height={chartMetrics.barHeight}
                        strokeWidth={0.35}
                        style="stroke"
                        width={width}
                        x={x}
                        y={chartMetrics.barY}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </SkiaGroup>
          </Canvas>
          <View
            collapsable={false}
            style={styles.overlay}
            testID={testID}
            {...panResponder.panHandlers}
          />
          {selection ? (
            <View
              pointerEvents="none"
              style={[
                styles.selectionBubbleWrap,
                selectedFrame && selectedFrame.startX + selectedFrame.width / 2 > 50
                  ? styles.selectionBubbleWrapLeft
                  : styles.selectionBubbleWrapRight,
              ]}>
              <ChartSelectionBubble
                accentColor={accentColor}
                detail={formatClockRangeFromStartLabel(startLabel, selection.startMinute, selection.endMinute)}
                label={formatSleepStageLabel(selection.segment.stage)}
                size="compact"
                testID={testID ? `${testID}-selection-bubble` : undefined}
                value={formatShortDuration(selection.segment.minutes)}
              />
            </View>
          ) : null}
        </View>
        <View
          style={[
            styles.axis,
            {
              marginTop: chartMetrics.axisMarginTop,
              paddingHorizontal: chartMetrics.axisPaddingHorizontal,
            },
          ]}>
          <Text style={styles.axisLabel}>{startLabel}</Text>
          <Text style={styles.axisLabel}>{middleLabel}</Text>
          <Text style={styles.axisLabel}>{endLabel}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  chartShell: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(3, 10, 16, 0.72)',
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    width: '100%',
  },
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
  selectionBubbleWrap: {
    left: 10,
    position: 'absolute',
    right: 10,
    top: 4,
    zIndex: 3,
  },
  selectionBubbleWrapLeft: {
    alignItems: 'flex-start',
  },
  selectionBubbleWrapRight: {
    alignItems: 'flex-end',
  },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  axisLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
  },
});
