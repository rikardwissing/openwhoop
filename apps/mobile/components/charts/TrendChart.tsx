import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Line, Path, Stop } from 'react-native-svg';

import { colors, typography } from '@/constants/theme';
import type { TrendPoint } from '@/types/health';

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

export function TrendChart({
  points,
  accentColor,
  height = 148,
}: {
  points: TrendPoint[];
  accentColor: string;
  height?: number;
}) {
  if (points.length === 0) {
    return null;
  }

  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const span = Math.max(max - min, 1);
  const coordinates = points.map((point, index) => ({
    x: points.length === 1 ? 50 : (index / (points.length - 1)) * 100,
    y: 4 + ((max - point.value) / span) * 28,
  }));
  const path = buildLine(coordinates);
  const area = `${path} L 100 36 L 0 36 Z`;
  const [start, end] = colorStops(accentColor);
  const labels = [points[0]?.label, points[Math.floor(points.length / 2)]?.label, points.at(-1)?.label];

  return (
    <View>
      <Svg height={height} viewBox="0 0 100 40" width="100%">
        <Defs>
          <SvgLinearGradient id="trendStroke" x1="0%" x2="100%" y1="100%" y2="0%">
            <Stop offset="0%" stopColor={start} />
            <Stop offset="100%" stopColor={end} />
          </SvgLinearGradient>
          <SvgLinearGradient id="trendFill" x1="0%" x2="0%" y1="0%" y2="100%">
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
        <Path d={area} fill="url(#trendFill)" />
        <Path d={path} fill="none" stroke="rgba(86, 246, 255, 0.14)" strokeWidth="4.8" />
        <Path d={path} fill="none" stroke="url(#trendStroke)" strokeLinecap="round" strokeWidth="2.2" />
      </Svg>
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
