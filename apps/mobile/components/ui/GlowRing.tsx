import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';

import { colors, typography } from '@/constants/theme';

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

export function GlowRing({
  score,
  label,
  caption,
  size = 300,
}: {
  score: number;
  label: string;
  caption: string;
  size?: number;
}) {
  const strokeWidth = size * 0.08;
  const radius = size / 2 - strokeWidth / 1.8;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0.06, Math.min(score / 100, 0.96));
  const dashOffset = circumference * (1 - progress);

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <View style={styles.ringGlow} />
      <Svg height={size} viewBox="0 0 100 100" width={size}>
        <Defs>
          <SvgLinearGradient id="ringGradient" x1="0%" x2="100%" y1="100%" y2="0%">
            <Stop offset="0%" stopColor={colors.cyan} />
            <Stop offset="65%" stopColor={colors.primary} />
            <Stop offset="100%" stopColor={colors.primaryBright} />
          </SvgLinearGradient>
        </Defs>
        <Circle
          cx="50"
          cy="50"
          fill="transparent"
          r="37"
          stroke="rgba(132, 154, 199, 0.18)"
          strokeWidth="6.6"
        />
        <Circle
          cx="50"
          cy="50"
          fill="transparent"
          r="32"
          stroke="rgba(86, 246, 255, 0.18)"
          strokeWidth="1.8"
        />
        <Circle
          cx="50"
          cy="50"
          fill="transparent"
          r="37"
          stroke="rgba(114, 255, 107, 0.18)"
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
            fill={index % 2 === 0 ? colors.primary : colors.primaryBright}
            opacity={sparkle.o}
            r={sparkle.r}
          />
        ))}
      </Svg>
      <View style={styles.inner}>
        <Text style={styles.caption}>{caption}</Text>
        <Text style={styles.score}>{score}%</Text>
        <Text style={styles.label}>{label}</Text>
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
  score: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 48,
    lineHeight: 56,
    marginTop: 4,
  },
  label: {
    color: colors.success,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
});
