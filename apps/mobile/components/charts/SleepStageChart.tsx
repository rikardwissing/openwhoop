import { StyleSheet, Text, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

import { colors, sleepStageColors, typography } from '@/constants/theme';
import type { SleepStage, SleepStageSegment } from '@/types/health';

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
}: {
  segments: SleepStageSegment[];
  startLabel: string;
  middleLabel: string;
  endLabel: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.minutes, 0);
  let position = 0;

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
      <Svg height={92} viewBox="0 0 100 30" width="100%">
        {segments.map((segment, index) => {
          const width = total === 0 ? 0 : (segment.minutes / total) * 100;
          const height = stageHeights[segment.stage];
          const rect = (
            <Rect
              fill={sleepStageColors[segment.stage]}
              key={`${segment.stage}-${index}`}
              opacity={segment.stage === 'awake' ? 0.92 : 1}
              rx="0.8"
              ry="0.8"
              width={Math.max(width - 0.7, 0.8)}
              x={position}
              y={30 - height}
              height={height}
            />
          );

          position += width;
          return rect;
        })}
      </Svg>
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
