import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';

import { colors, typography } from '@/constants/theme';
import type { MetricTone } from '@/types/health';

const sparkles = [
  { x: 44, y: 16, r: 1.4, o: 0.25 },
  { x: 54, y: 12, r: 1.8, o: 0.4 },
  { x: 60, y: 14, r: 1.2, o: 0.32 },
  { x: 72, y: 18, r: 1.5, o: 0.34 },
  { x: 79, y: 22, r: 1.2, o: 0.38 },
  { x: 84, y: 29, r: 1.4, o: 0.28 },
  { x: 26, y: 78, r: 1.1, o: 0.22 },
  { x: 20, y: 64, r: 1.4, o: 0.19 },
  { x: 16, y: 52, r: 1.2, o: 0.16 },
  { x: 14, y: 38, r: 1.6, o: 0.14 },
];

const tonePalette: Record<
  MetricTone,
  {
    caption: string;
    glow: string;
    gradientEnd: string;
    gradientMid: string;
    gradientStart: string;
    innerStroke: string;
    label: string;
    outerStroke: string;
    score: string;
    sparkleA: string;
    sparkleB: string;
    track: string;
  }
> = {
  good: {
    caption: 'rgba(236, 255, 114, 0.88)',
    glow: 'rgba(141, 255, 179, 0.18)',
    gradientEnd: colors.primaryBright,
    gradientMid: colors.primary,
    gradientStart: colors.success,
    innerStroke: 'rgba(236, 255, 114, 0.2)',
    label: colors.success,
    outerStroke: 'rgba(141, 255, 179, 0.18)',
    score: '#f5fff8',
    sparkleA: colors.primaryBright,
    sparkleB: colors.success,
    track: 'rgba(141, 255, 179, 0.22)',
  },
  caution: {
    caption: 'rgba(255, 210, 107, 0.92)',
    glow: 'rgba(255, 210, 107, 0.16)',
    gradientEnd: colors.heart,
    gradientMid: colors.primaryBright,
    gradientStart: '#ffd995',
    innerStroke: 'rgba(236, 255, 114, 0.18)',
    label: colors.heart,
    outerStroke: 'rgba(255, 210, 107, 0.18)',
    score: '#fff8ee',
    sparkleA: colors.primaryBright,
    sparkleB: colors.heart,
    track: 'rgba(255, 210, 107, 0.22)',
  },
  alert: {
    caption: 'rgba(255, 125, 112, 0.92)',
    glow: 'rgba(255, 125, 112, 0.18)',
    gradientEnd: '#ffd995',
    gradientMid: '#ffb174',
    gradientStart: colors.alert,
    innerStroke: 'rgba(255, 210, 107, 0.14)',
    label: colors.alert,
    outerStroke: 'rgba(255, 125, 112, 0.18)',
    score: '#fff3f1',
    sparkleA: '#ffb174',
    sparkleB: colors.alert,
    track: 'rgba(255, 125, 112, 0.24)',
  },
  neutral: {
    caption: colors.subtle,
    glow: 'rgba(89, 245, 255, 0.14)',
    gradientEnd: colors.primaryBright,
    gradientMid: colors.indigo,
    gradientStart: colors.cyan,
    innerStroke: 'rgba(93, 120, 255, 0.16)',
    label: colors.cyan,
    outerStroke: 'rgba(132, 154, 199, 0.18)',
    score: colors.text,
    sparkleA: colors.cyan,
    sparkleB: colors.primaryBright,
    track: 'rgba(89, 245, 255, 0.2)',
  },
};

export function GlowRing({
  score,
  label,
  caption,
  size = 300,
  compact = false,
  displayDigits = 0,
  displaySuffix = '%',
  progressMax = 100,
  labelColor,
  tone = 'neutral',
}: {
  score: number | null;
  label: string;
  caption: string;
  size?: number;
  compact?: boolean;
  displayDigits?: number;
  displaySuffix?: string;
  progressMax?: number;
  labelColor?: string;
  tone?: MetricTone;
}) {
  const palette = tonePalette[tone];
  const strokeWidth = size * 0.08;
  const radius = size / 2 - strokeWidth / 1.8;
  const circumference = 2 * Math.PI * radius;
  const progress = score === null ? 0.08 : Math.max(0.06, Math.min(score / Math.max(progressMax, 1), 0.96));
  const dashOffset = circumference * (1 - progress);
  const displayScore =
    score === null
      ? '--'
      : `${Number(score.toFixed(displayDigits)).toString()}${displaySuffix}`;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <View style={[styles.ringGlow, { backgroundColor: palette.glow }]} />
      <Svg height={size} viewBox="0 0 100 100" width={size}>
        <Defs>
          <SvgLinearGradient id="ringGradient" x1="0%" x2="100%" y1="100%" y2="0%">
            <Stop offset="0%" stopColor={palette.gradientStart} />
            <Stop offset="65%" stopColor={palette.gradientMid} />
            <Stop offset="100%" stopColor={palette.gradientEnd} />
          </SvgLinearGradient>
        </Defs>
        <Circle
          cx="50"
          cy="50"
          fill="transparent"
          r="37"
          stroke={palette.outerStroke}
          strokeWidth="6.6"
        />
        <Circle
          cx="50"
          cy="50"
          fill="transparent"
          r="32"
          stroke={palette.innerStroke}
          strokeWidth="1.8"
        />
        <Circle
          cx="50"
          cy="50"
          fill="transparent"
          r="37"
          stroke={palette.track}
          strokeLinecap="round"
          strokeWidth="9"
          transform="rotate(-90 50 50)"
        />
        <Circle
          cx="50"
          cy="50"
          fill="transparent"
          r="37"
          stroke="url(#ringGradient)"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          strokeWidth="7.2"
          transform="rotate(-90 50 50)"
        />
        {sparkles.map((sparkle, index) => (
          <Circle
            key={index}
            cx={sparkle.x}
            cy={sparkle.y}
            fill={index % 2 === 0 ? palette.sparkleA : palette.sparkleB}
            opacity={sparkle.o}
            r={sparkle.r}
          />
        ))}
      </Svg>
      <View style={styles.inner}>
        <Text style={[styles.caption, compact ? styles.captionCompact : null, { color: palette.caption }]}>
          {caption}
        </Text>
        <Text style={[styles.score, compact ? styles.scoreCompact : null, { color: palette.score }]}>
          {displayScore}
        </Text>
        <Text
          style={[
            styles.label,
            compact ? styles.labelCompact : null,
            { color: labelColor ?? palette.label },
          ]}>
          {label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  ringGlow: {
    backgroundColor: 'rgba(86, 246, 255, 0.16)',
    borderRadius: 220,
    height: '78%',
    opacity: 0.7,
    position: 'absolute',
    width: '78%',
  },
  inner: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'absolute',
  },
  caption: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 14,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  captionCompact: {
    fontSize: 9,
    letterSpacing: 0.6,
  },
  score: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 48,
    lineHeight: 56,
    marginTop: 4,
  },
  scoreCompact: {
    fontSize: 21,
    lineHeight: 24,
    marginTop: 1,
  },
  label: {
    color: colors.success,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  labelCompact: {
    fontSize: 10,
  },
});
