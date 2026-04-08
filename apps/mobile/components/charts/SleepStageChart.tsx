import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { ClipPath, Defs, G, Rect } from 'react-native-svg';

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

const stageOrder: SleepStage[] = ['deep', 'light', 'rem', 'awake'];

const compactMetrics = {
  axisPaddingHorizontal: 0,
  axisMarginTop: 8,
  barHeight: 22,
  barRadius: 4,
  barY: 9,
  chartHeight: 40,
  shellPaddingBottom: 12,
  shellPaddingHorizontal: 12,
  shellPaddingTop: 10,
  viewboxHeight: 40,
};

const expandedMetrics = {
  axisPaddingHorizontal: 12,
  axisMarginTop: 10,
  barHeight: 46,
  barRadius: 4,
  barY: 3,
  chartHeight: 52,
  shellPaddingBottom: 10,
  shellPaddingHorizontal: 0,
  shellPaddingTop: 6,
  viewboxHeight: 52,
};

const selectionOutlineInset = 1;

function formatStageName(stage: SleepStage) {
  return stage === 'rem' ? 'REM' : `${stage[0].toUpperCase()}${stage.slice(1)}`;
}

export function SleepStageChart({
  segments,
  startLabel,
  middleLabel,
  endLabel,
  accentColor = colors.cyan,
  onSelectionChange,
  size = 'compact',
  testID,
}: {
  segments: SleepStageSegment[];
  startLabel: string;
  middleLabel: string;
  endLabel: string;
  accentColor?: string;
  onSelectionChange?: (selection: SleepStageSelection | null) => void;
  size?: 'compact' | 'expanded';
  testID?: string;
}) {
  const [chartWidth, setChartWidth] = useState(0);
  const [selection, setSelection] = useState<SleepStageSelection | null>(null);
  const selectionRef = useRef<SleepStageSelection | null>(null);
  const releaseScrollLockRef = useRef<(() => void) | null>(null);
  const frames = useMemo(() => buildSleepStageFrames(segments), [segments]);
  const selectedFrame = selection ? frames.find((frame) => frame.index === selection.index) ?? null : null;
  const acquireScreenScrollLock = useAcquireScreenScrollLock();
  const metrics = size === 'expanded' ? expandedMetrics : compactMetrics;
  const clipPathIdRef = useRef(`sleep-stage-bar-${Math.random().toString(36).slice(2, 10)}`);

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
        // Keep the scrub gesture attached to the chart until the user lifts
        // their finger so the parent ScrollView cannot steal the interaction
        // when the touch path drifts vertically.
        onPanResponderTerminationRequest: () => false,
      }),
    [commitSelection, ensureScrollLock, releaseScrollLock, shouldCaptureScrub, updateSelection],
  );

  return (
    <View style={styles.root}>
      <View style={styles.legend}>
        {stageOrder.map((stage) => (
          <View key={stage} style={styles.legendChip}>
            <View style={[styles.legendDot, { backgroundColor: sleepStageColors[stage] }]} />
            <Text style={styles.legendLabel}>{formatStageName(stage)}</Text>
          </View>
        ))}
      </View>
      <View
        style={[
          styles.chartShell,
          size === 'expanded' ? styles.chartShellExpanded : null,
          {
            paddingBottom: metrics.shellPaddingBottom,
            paddingHorizontal: metrics.shellPaddingHorizontal,
            paddingTop: metrics.shellPaddingTop,
          },
        ]}>
        <View
          onLayout={(event) => {
            setChartWidth(event.nativeEvent.layout.width);
          }}
          testID={testID ? `${testID}-viewport` : undefined}
          style={[styles.chartArea, { height: metrics.chartHeight }]}>
          <Svg
            height="100%"
            preserveAspectRatio="none"
            viewBox={`0 0 100 ${metrics.viewboxHeight}`}
            width="100%">
            <Defs>
              <ClipPath id={clipPathIdRef.current}>
                <Rect
                  height={metrics.barHeight}
                  rx={metrics.barRadius}
                  ry={metrics.barRadius}
                  width={100}
                  x={0}
                  y={metrics.barY}
                />
              </ClipPath>
            </Defs>
            <Rect
              fill={colors.surfaceMuted}
              height={metrics.barHeight}
              rx={metrics.barRadius}
              ry={metrics.barRadius}
              width={100}
              x={0}
              y={metrics.barY}
            />
            <G clipPath={`url(#${clipPathIdRef.current})`}>
              {frames.map((frame) => {
                const isSelected = selection?.index === frame.index;

                return (
                  <Rect
                    fill={sleepStageColors[frame.segment.stage]}
                    height={metrics.barHeight}
                    key={`${frame.segment.stage}-${frame.index}`}
                    opacity={selection ? (isSelected ? 1 : 0.38) : frame.segment.stage === 'awake' ? 0.94 : 1}
                    rx={0}
                    ry={0}
                    stroke={selection && isSelected ? 'transparent' : 'rgba(255,255,255,0.10)'}
                    strokeWidth={selection && isSelected ? 0 : 0.35}
                    testID={testID ? `${testID}-segment-${frame.index}` : undefined}
                    width={Math.max(frame.width, 0.8)}
                    x={frame.startX}
                    y={metrics.barY}
                  />
                );
              })}
            </G>
            {selectedFrame ? (
              <Rect
                fill="transparent"
                height={metrics.barHeight + selectionOutlineInset * 2}
                rx={metrics.barRadius + selectionOutlineInset}
                ry={metrics.barRadius + selectionOutlineInset}
                stroke={accentColor}
                strokeWidth={1}
                width={Math.max(selectedFrame.width, 1.1)}
                x={selectedFrame.startX}
                y={metrics.barY - selectionOutlineInset}
              />
            ) : null}
          </Svg>
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
                size === 'expanded' ? styles.selectionBubbleExpanded : null,
              ]}>
              <ChartSelectionBubble
                accentColor={accentColor}
                detail={
                  size === 'expanded'
                    ? formatClockRangeFromStartLabel(startLabel, selection.startMinute, selection.endMinute)
                    : undefined
                }
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
              marginTop: metrics.axisMarginTop,
              paddingHorizontal: metrics.axisPaddingHorizontal,
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
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  legendChip: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  legendDot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  legendLabel: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 11,
  },
  chartShell: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(3, 10, 16, 0.72)',
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    width: '100%',
  },
  chartShellExpanded: {
    borderRadius: 20,
  },
  chartArea: {
    position: 'relative',
    width: '100%',
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
  selectionBubbleExpanded: {
    left: 12,
    top: 6,
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
