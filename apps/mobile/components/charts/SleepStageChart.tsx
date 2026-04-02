import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

import {
  buildSleepStageFrames,
  selectSleepStageAtX,
} from '@/components/charts/chartSelection';
import { colors, sleepStageColors, typography } from '@/constants/theme';
import type { SleepStage, SleepStageSegment, SleepStageSelection } from '@/types/health';

const stageHeights: Record<SleepStage, number> = {
  awake: 12,
  rem: 20,
  deep: 24,
  light: 18,
};

export function SleepStageChart({
  segments,
  startLabel,
  middleLabel,
  endLabel,
  accentColor = colors.cyan,
  onSelectionChange,
  testID,
}: {
  segments: SleepStageSegment[];
  startLabel: string;
  middleLabel: string;
  endLabel: string;
  accentColor?: string;
  onSelectionChange?: (selection: SleepStageSelection | null) => void;
  testID?: string;
}) {
  const [chartWidth, setChartWidth] = useState(0);
  const [selection, setSelection] = useState<SleepStageSelection | null>(null);
  const selectionRef = useRef<SleepStageSelection | null>(null);
  const frames = useMemo(() => buildSleepStageFrames(segments), [segments]);

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

  useEffect(() => {
    commitSelection(null);
  }, [commitSelection, segments]);

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

  return (
    <View>
      <View style={styles.legend}>
        {(['awake', 'rem', 'deep', 'light'] as SleepStage[]).map((stage) => (
          <View key={stage} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: sleepStageColors[stage] }]} />
            <Text style={styles.legendLabel}>{stage === 'rem' ? 'REM' : stage[0].toUpperCase() + stage.slice(1)}</Text>
          </View>
        ))}
      </View>
      <View
        onLayout={(event) => {
          setChartWidth(event.nativeEvent.layout.width);
        }}
        style={styles.chartArea}>
        <Svg height="100%" viewBox="0 0 100 30" width="100%">
          {frames.map((frame) => {
            const isSelected = selection?.index === frame.index;
            const width = Math.max(frame.width - 0.7, 0.8);

            return (
              <Rect
                fill={sleepStageColors[frame.segment.stage]}
                height={stageHeights[frame.segment.stage]}
                key={`${frame.segment.stage}-${frame.index}`}
                opacity={
                  selection
                    ? isSelected
                      ? 1
                      : 0.22
                    : frame.segment.stage === 'awake'
                      ? 0.92
                      : 1
                }
                rx="0.8"
                ry="0.8"
                stroke={isSelected ? accentColor : 'transparent'}
                strokeWidth={isSelected ? 0.9 : 0}
                width={width}
                x={frame.startX}
                y={30 - stageHeights[frame.segment.stage]}
              />
            );
          })}
        </Svg>
        <View
          collapsable={false}
          style={styles.overlay}
          testID={testID}
          {...panResponder.panHandlers}
        />
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisLabel}>{startLabel}</Text>
        <Text style={styles.axisLabel}>{middleLabel}</Text>
        <Text style={styles.axisLabel}>{endLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 8,
  },
  legendItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  legendDot: {
    borderRadius: 999,
    height: 7,
    width: 7,
  },
  legendLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
  },
  chartArea: {
    height: 92,
    position: 'relative',
    width: '100%',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -4,
  },
  axisLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
  },
});
