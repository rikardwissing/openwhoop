import { HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  lineLimit,
  monospacedDigit,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';

import type { TonightWidgetProps } from '@/widgets/TonightWidget';

type SleepLiveActivityEnvironment = {
  colorScheme?: 'light' | 'dark';
};

const SleepLiveActivityComponent = (
  rawProps: TonightWidgetProps,
  environment: SleepLiveActivityEnvironment = {},
) => {
  'widget';

  const primaryIcon = 'moon.zzz.fill';
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const accent = '#52D8E8';
  const caution = '#ffd26b';
  const alert = '#ff7d70';
  const success = '#8dffb3';
  const isDark = environment.colorScheme !== 'light';
  const text = isDark ? '#F8FAFC' : '#0F172A';
  const secondary = isDark ? '#CBD5E1' : '#475569';
  const subtle = isDark ? '#94A3B8' : '#64748B';
  const sleepAccent = isDark ? '#B7B2FF' : '#4F46E5';
  const sleepCyan = isDark ? '#78E6F4' : '#0284C7';

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
  const headline = windDownActive ? 'Wind down now' : props.sleepInProgress ? 'Sleep in progress' : props.sleepThemeLabel;
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
  const activityLabel = windDownActive ? 'Wind down' : sleepWindowProgressActive ? 'Progress' : 'Sleep score';
  const batteryLabel = props.batteryLabel?.trim() || defaultProps.batteryLabel;

  return {
    banner: (
      <HStack alignment="center" spacing={12} modifiers={[padding({ all: 12 })]}>
        <Image color={ringColor} size={22} systemName={primaryIcon} />

        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
            {headline}
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(secondary), lineLimit(1)]}>
            {scheduleLine}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
            {detailLine}
          </Text>
        </VStack>

        <VStack alignment="trailing" spacing={2}>
          <Text modifiers={[font({ size: 11, weight: 'semibold' }), foregroundStyle(subtle), lineLimit(1)]}>
            {activityLabel}
          </Text>
          <Text
            modifiers={[
              font({ size: 22, weight: 'bold' }),
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
    ),
    bannerSmall: (
      <HStack alignment="center" spacing={8} modifiers={[padding({ all: 10 })]}>
        <Image color={ringColor} size={16} systemName={primaryIcon} />
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          {headline}
        </Text>
      </HStack>
    ),
    compactLeading: <Image color={compactLeadingColor} size={16} systemName={primaryIcon} />,
    compactTrailing: (
      <Text
        modifiers={[
          font({ size: 14, weight: 'bold' }),
          foregroundStyle(text),
          monospacedDigit(),
          lineLimit(1),
        ]}>
        {compactTrailingText}
      </Text>
    ),
    minimal: <Image color={compactLeadingColor} size={15} systemName={primaryIcon} />,
    expandedLeading: (
      <VStack alignment="leading" spacing={4} modifiers={[padding({ all: 12 })]}>
        <Image color={ringColor} size={24} systemName={primaryIcon} />
        <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(subtle), lineLimit(1)]}>
          {windDownActive ? 'Wind down' : props.sleepInProgress ? 'Sleeping' : 'Tonight'}
        </Text>
      </VStack>
    ),
    expandedCenter: (
      <VStack alignment="leading" spacing={4} modifiers={[padding({ all: 12 })]}>
        <Text modifiers={[font({ size: 15, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          {headline}
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(secondary), lineLimit(1)]}>
          {scheduleLine}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {detailLine}
        </Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack alignment="trailing" spacing={4} modifiers={[padding({ all: 12 })]}>
        <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(subtle), lineLimit(1)]}>
          {activityLabel}
        </Text>
        <Text
          modifiers={[
            font({ size: 26, weight: 'bold' }),
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