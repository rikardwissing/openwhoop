import { Pressable, StyleSheet } from 'react-native';

import { GlowRing } from '@/components/ui/GlowRing';
import type { MetricTone } from '@/types/health';

export function DashboardHeroMetricCard({
  caption,
  displayDigits = 0,
  displaySuffix = '%',
  label,
  onPress,
  progressMax = 100,
  score,
  testID,
  tone = 'neutral',
}: {
  caption: string;
  displayDigits?: number;
  displaySuffix?: string;
  label: string;
  onPress: () => void;
  progressMax?: number;
  score: number | null;
  testID?: string;
  tone?: MetricTone;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.pressable, pressed ? styles.pressablePressed : null]}
      testID={testID}>
      <GlowRing
        caption={caption}
        compact
        displayDigits={displayDigits}
        displaySuffix={displaySuffix}
        label={label}
        progressMax={progressMax}
        score={score}
        size={110}
        tone={tone}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 124,
  },
  pressablePressed: {
    opacity: 0.86,
  },
});
