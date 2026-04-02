import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type HeartIconName =
  | 'heart'
  | 'heart-outline'
  | 'heart-circle'
  | 'heart-circle-outline'
  | 'heart-half'
  | 'heart-dislike'
  | 'heart-dislike-outline';

export function PulsingHeartIcon({
  bpm,
  color,
  name = 'heart',
  size,
  style,
}: {
  bpm: number | null;
  color: string;
  name?: HeartIconName;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  const animation = useRef(new Animated.Value(0)).current;
  const liveBpm = useMemo(() => {
    if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) {
      return null;
    }

    return Math.max(42, Math.min(Math.round(bpm), 190));
  }, [bpm]);

  useEffect(() => {
    animation.stopAnimation();

    if (liveBpm === null) {
      animation.setValue(0);
      return;
    }

    const beatDurationMs = 60_000 / liveBpm;
    const expandDurationMs = Math.max(80, Math.min(beatDurationMs * 0.18, 150));
    const settleDurationMs = Math.max(120, Math.min(beatDurationMs * 0.26, 210));
    const restDurationMs = Math.max(0, beatDurationMs - expandDurationMs - settleDurationMs);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(animation, {
          duration: expandDurationMs,
          easing: Easing.out(Easing.quad),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(animation, {
          duration: settleDurationMs,
          easing: Easing.inOut(Easing.quad),
          toValue: 0,
          useNativeDriver: true,
        }),
        Animated.delay(restDurationMs),
      ]),
      { resetBeforeIteration: true }
    );

    loop.start();

    return () => {
      loop.stop();
      animation.stopAnimation();
      animation.setValue(0);
    };
  }, [animation, liveBpm]);

  return (
    <Animated.View
      style={[
        styles.iconWrap,
        style,
        liveBpm
          ? {
              opacity: animation.interpolate({
                inputRange: [0, 1],
                outputRange: [0.94, 1],
              }),
              transform: [
                {
                  scale: animation.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 1.12],
                  }),
                },
              ],
            }
          : null,
      ]}>
      <Ionicons color={color} name={name} size={size} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
