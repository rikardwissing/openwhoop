import { Gauge, HStack, Image, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  frame,
  gaugeStyle,
  lineLimit,
  monospacedDigit,
  padding,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';

import type { TonightWidgetProps } from '@/widgets/TonightWidget';

const PRIMARY_ICON = 'moon.zzz.fill';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const SleepLiveActivityComponent = (rawProps: TonightWidgetProps) => {
  'widget';

  const accent = '#52D8E8';
  const caution = '#ffd26b';
  const alert = '#ff7d70';
  const success = '#8dffb3';
  const secondary = '#BCB8D8';
  const subtle = '#8582A9';
  const text = '#F8F4FF';
  const sleepAccent = '#B7B2FF';
  const sleepCyan = '#78E6F4';
  const sleepWarm = '#F4C66A';

  const defaultProps: Required<TonightWidgetProps> = {
    alarmStatusLabel: 'Open Unstrap',
    batteryCharging: false,
    batteryLabel: '--%',
    bedtimeLabel: '--',
    bedtimePassed: false,
    greetingLabel: 'Tonight plan',
    phaseLabel: 'Tonight plan',
    projectedSleepLabel: '--',
    progress: 0,
    score: null,
    scoreLabel: 'Waiting for sleep',
    sleepDebtLabel: 'Sync to update',
    sleepInProgress: false,
    sleepNeedLabel: 'Need --',
    sleepProgress: 0,
    sleepThemeActive: false,
    sleepThemeLabel: 'Tonight plan',
    updatedAtLabel: '--',
    wakeLabel: '--',
  };

  const props: Required<TonightWidgetProps> = {
    ...defaultProps,
    ...rawProps,
    progress: clamp(rawProps.progress ?? defaultProps.progress, 0, 1),
    sleepProgress: clamp(rawProps.sleepProgress ?? defaultProps.sleepProgress, 0, 1),
    score:
      rawProps.score === null || rawProps.score === undefined
        ? defaultProps.score
        : clamp(rawProps.score, 0, 100),
  };

  const scoreValue = props.score === null ? 0 : Math.round(props.score);
  const scoreText = props.score === null ? '--' : `${scoreValue}`;
  const plannedSleepProgressValue = Math.max(6, Math.min(96, Math.round(props.progress * 100)));
  const sleepProgressValue = Math.max(6, Math.min(96, Math.round(props.sleepProgress * 100)));
  const windDownActive = props.sleepThemeActive && props.sleepThemeLabel === 'Time to wind down';
  const sleepWindowProgressActive = props.sleepInProgress || props.bedtimePassed;
  const ringValue = props.sleepInProgress
    ? sleepProgressValue
    : props.bedtimePassed
      ? plannedSleepProgressValue
      : windDownActive
        ? 0
        : scoreValue;
  const ringText = sleepWindowProgressActive || windDownActive ? `${ringValue}` : scoreText;
  const scoreRingColor =
    props.score === null ? accent : props.score >= 80 ? success : props.score >= 65 ? caution : alert;
  const ringColor = sleepWindowProgressActive ? sleepAccent : windDownActive ? sleepCyan : scoreRingColor;
  const headline = windDownActive ? 'Wind down now' : props.sleepThemeLabel;
  const scheduleLine = props.sleepInProgress || props.bedtimePassed
    ? `Done by ${props.projectedSleepLabel}`
    : `Bed ${props.bedtimeLabel} · Wake ${props.wakeLabel}`;
  const detailLine = props.sleepInProgress
    ? `${props.phaseLabel} · Need ${props.sleepNeedLabel}`
    : windDownActive
      ? props.phaseLabel
      : `Bed ${props.bedtimeLabel} · Wake ${props.wakeLabel}`;
  const compactTrailingText = windDownActive ? 'Now' : sleepWindowProgressActive ? `${ringValue}` : props.bedtimeLabel;
  const compactLeadingColor = windDownActive ? sleepCyan : sleepAccent;
  const showSleepThemeIcon = props.sleepInProgress || windDownActive;
  const batteryLabel = props.batteryLabel?.trim() || defaultProps.batteryLabel;

  function ActivityRing({ size }: { size: number }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={ringValue}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ringColor), frame({ width: size, height: size })]}
        />

        {showSleepThemeIcon ? (
          <Image color={ringColor} size={size >= 56 ? 22 : 16} systemName={PRIMARY_ICON} />
        ) : (
          <Text
            modifiers={[
              font({ size: size >= 56 ? 22 : 15, weight: 'bold', design: 'rounded' }),
              foregroundStyle(text),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {ringText}
          </Text>
        )}
      </ZStack>
    );
  }

  const banner = (
    <HStack alignment="center" spacing={12} modifiers={[padding({ all: 14 })]}>
      <ActivityRing size={56} />

      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          {headline}
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          {scheduleLine}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {detailLine}
        </Text>
      </VStack>

      <Spacer />

      <VStack alignment="trailing" spacing={2}>
        <Text
          modifiers={[
            font({ size: 20, weight: 'bold', design: 'rounded' }),
            foregroundStyle(ringColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {ringText}
        </Text>
        <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {batteryLabel}
        </Text>
      </VStack>
    </HStack>
  );

  return {
    banner,
    bannerSmall: (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), padding({ all: 10 }), lineLimit(1)]}>
        {headline}
      </Text>
    ),
    compactLeading: <Image color={compactLeadingColor} size={16} systemName={PRIMARY_ICON} />,
    compactTrailing: (
      <Text
        modifiers={[
          font({ size: 14, weight: 'bold', design: 'rounded' }),
          foregroundStyle(text),
          monospacedDigit(),
          lineLimit(1),
        ]}>
        {compactTrailingText}
      </Text>
    ),
    minimal: <Image color={compactLeadingColor} size={15} systemName={PRIMARY_ICON} />,
    expandedLeading: <ActivityRing size={68} />,
    expandedCenter: (
      <VStack alignment="leading" spacing={4} modifiers={[padding({ leading: 6 })]}>
        <Text modifiers={[font({ size: 15, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          {headline}
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          {scheduleLine}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {detailLine}
        </Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack alignment="trailing" spacing={4}>
        <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(subtle), lineLimit(1)]}>
          {sleepWindowProgressActive ? 'Progress' : windDownActive ? 'Window' : 'Score'}
        </Text>
        <Text
          modifiers={[
            font({ size: 26, weight: 'bold', design: 'rounded' }),
            foregroundStyle(ringColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {ringText}
        </Text>
        <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {batteryLabel}
        </Text>
      </VStack>
    ),
    expandedBottom: (
      <HStack alignment="center" spacing={8} modifiers={[padding({ top: 6 })]}>
        <Image color={props.batteryCharging ? success : subtle} size={10} systemName="battery.100" />
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {props.phaseLabel}
        </Text>
      </HStack>
    ),
  };
};

export default createLiveActivity<TonightWidgetProps>('SleepWidgetV2', SleepLiveActivityComponent);