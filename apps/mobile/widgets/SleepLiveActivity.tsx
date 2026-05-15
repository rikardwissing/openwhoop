import { Gauge, HStack, Image, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  allowsTightening,
  font,
  foregroundStyle,
  frame,
  gaugeStyle,
  kerning,
  lineLimit,
  monospacedDigit,
  offset,
  padding,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';

import type { TonightWidgetProps } from '@/widgets/TonightWidget';

const SleepLiveActivityComponent = (rawProps: TonightWidgetProps) => {
  'widget';

  const primaryIcon = 'moon.zzz.fill';
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
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
    bedtimeTimestamp: 0,
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
    sleepStartTimestamp: 0,
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

  const sleepProgressValue = Math.max(6, Math.min(96, Math.round(props.sleepProgress * 100)));
  const windDownActive = props.sleepThemeActive && props.sleepThemeLabel === 'Time to wind down';
  const postBedtimeAwaitingSleep = props.bedtimePassed && !props.sleepInProgress;
  const sleepWindowProgressActive = props.sleepInProgress || props.bedtimePassed;
  const ringValue = props.sleepInProgress
    ? sleepProgressValue
    : postBedtimeAwaitingSleep
      ? 0
      : windDownActive
        ? 0
        : 0;
  const scoreRingColor =
    props.score === null ? accent : props.score >= 80 ? success : props.score >= 65 ? caution : alert;
  const ringColor = props.sleepInProgress
    ? sleepAccent
    : windDownActive
      ? sleepCyan
      : postBedtimeAwaitingSleep
        ? sleepWarm
        : scoreRingColor;
  const headline = windDownActive ? 'Wind down now' : props.sleepThemeLabel;
  const scheduleLine = props.sleepInProgress || props.bedtimePassed
    ? `100% by ${props.projectedSleepLabel}`
    : `Bed ${props.bedtimeLabel} · Wake ${props.wakeLabel}`;
  const sleepNeedDetail = props.sleepNeedLabel.startsWith('Need ') ? props.sleepNeedLabel : `Need ${props.sleepNeedLabel}`;
  const detailLine = props.sleepInProgress ? sleepNeedDetail : windDownActive ? sleepNeedDetail : props.phaseLabel;
  const compactTrailingText = windDownActive ? 'Now' : sleepWindowProgressActive ? `${ringValue}` : props.bedtimeLabel;

  const showSleepThemeIcon = true;
  const batteryLabel = (() => {
    const value = rawProps.batteryLabel?.trim();
    if (value) {
      return value;
    }
    return props.batteryLabel;
  })();
  const batteryPercent = (() => {
    const parsed = Number.parseInt(batteryLabel, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
  })();
  const batterySymbol = (() => {
    if (batteryPercent === null) {
      return 'battery.100';
    }

    if (batteryPercent <= 10) {
      return 'battery.25';
    }

    if (batteryPercent <= 35) {
      return 'battery.50';
    }

    if (batteryPercent <= 65) {
      return 'battery.75';
    }

    return 'battery.100';
  })();
  const bedtimeDate = props.bedtimeTimestamp > 0 ? new Date(props.bedtimeTimestamp) : null;
  const sleepStartDate = props.sleepStartTimestamp > 0 ? new Date(props.sleepStartTimestamp) : null;
  const bedtimeTimerActive = !props.sleepInProgress && (windDownActive || props.bedtimePassed) && bedtimeDate !== null;
  const sleepDurationActive = props.sleepInProgress && sleepStartDate !== null;
  const rightHandReferenceDate = sleepDurationActive ? sleepStartDate : bedtimeTimerActive ? bedtimeDate : null;
  const rightHandCountsDown = windDownActive;
  const rightHandTimerColor = sleepDurationActive ? sleepAccent : props.bedtimePassed ? alert : sleepCyan;
  const compactLeadingColor = sleepDurationActive ? sleepAccent : props.bedtimePassed ? sleepWarm : sleepCyan;
  const rightHandTitle = sleepDurationActive
    ? 'Asleep'
    : props.bedtimePassed
      ? 'Past bed'
      : windDownActive
        ? 'Bedtime in'
        : sleepWindowProgressActive
          ? 'Progress'
          : 'Score';

  function formatRelativeTimeText(referenceDate: Date, countsDown: boolean, now = new Date()) {
    const rawMinutes = countsDown
      ? (referenceDate.getTime() - now.getTime()) / 60_000
      : (now.getTime() - referenceDate.getTime()) / 60_000;
    const totalMinutes = Math.max(0, Math.round(rawMinutes));

    if (countsDown && totalMinutes <= 0) {
      return 'Now';
    }

    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (minutes === 0) {
      return `${hours}h`;
    }

    return `${hours}h ${minutes}m`;
  }

  const rightHandTimerText = rightHandReferenceDate
    ? formatRelativeTimeText(rightHandReferenceDate, rightHandCountsDown)
    : null;
  const rightHandTimerNeedsCompression = rightHandTimerText?.includes(' ') ?? false;

  function ActivityRing({ size }: { size: number }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={ringValue}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ringColor), frame({ width: size, height: size })]}
        />

        {showSleepThemeIcon ? <Image color={ringColor} size={size >= 56 ? 22 : 16} systemName={primaryIcon} /> : null}
      </ZStack>
    );
  }

  function ActivityMetric({ size, staticColor, allowsResizing }: { size: number; staticColor: string; allowsResizing?: boolean }) {
    const resolvedSize = allowsResizing && rightHandTimerNeedsCompression ? Math.max(16, size - 6) : size;

    if (rightHandTimerText !== null) {
      return (
        <Text
          modifiers={[
            font({ size: resolvedSize, weight: 'bold', design: 'rounded' }),
            foregroundStyle(rightHandTimerColor),
            monospacedDigit(),
            allowsTightening(rightHandTimerNeedsCompression),
            kerning(allowsResizing &&rightHandTimerNeedsCompression ? -0.4 : undefined),
            lineLimit(1),
          ]}>
          {rightHandTimerText}
        </Text>
      );
    }

    return (
      <Text
        modifiers={[
          font({ size, weight: 'bold', design: 'rounded' }),
          foregroundStyle(staticColor),
          monospacedDigit(),
          lineLimit(1),
        ]}>
        {compactTrailingText}
      </Text>
    );
  }

  function CompactTrailingMetric() {
    const compactSize = rightHandTimerNeedsCompression ? 12 : 14;

    if (rightHandTimerText !== null) {
      return (
        <Text
          modifiers={[
            font({ size: compactSize, weight: 'bold', design: 'rounded' }),
            foregroundStyle(rightHandTimerColor),
            monospacedDigit(),
            allowsTightening(rightHandTimerNeedsCompression),
            kerning(rightHandTimerNeedsCompression ? -0.3 : undefined),
            lineLimit(1),
          ]}>
          {rightHandTimerText}
        </Text>
      );
    }

    return (
      <Text
        modifiers={[
          font({ size: 14, weight: 'bold', design: 'rounded' }),
          foregroundStyle(text),
          monospacedDigit(),
          lineLimit(1),
        ]}>
        {compactTrailingText}
      </Text>
    );
  }

  function BatteryBadge({ iconSize, textSize }: { iconSize: number; textSize: number }) {
    const batteryColor = props.batteryCharging
      ? success
      : batteryPercent !== null && batteryPercent < 10
        ? alert
        : batteryPercent !== null && batteryPercent < 20
          ? caution
          : secondary;

    return (
      <HStack alignment="center" spacing={3}>
        <Image color={batteryColor} size={iconSize} systemName={batterySymbol} />
        <Text
          modifiers={[
            font({ size: textSize, weight: 'medium' }),
            foregroundStyle(batteryColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {batteryLabel}
        </Text>
      </HStack>
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
        <ActivityMetric size={20} staticColor={ringColor} />
        <BatteryBadge iconSize={11} textSize={11} />
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
    compactLeading: <Image color={compactLeadingColor} size={16} systemName={primaryIcon} />,
    compactTrailing: <CompactTrailingMetric />,
    minimal: <Image color={compactLeadingColor} size={15} systemName={primaryIcon} />,
    expandedLeading: (
      <VStack alignment="leading" spacing={4}>
        <Spacer />
        <ActivityRing size={68} />
        <Spacer />
      </VStack>
    ),
    expandedCenter: (
      <VStack alignment="leading" spacing={4}>
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
    ),
    expandedTrailing: (
      <VStack alignment="trailing" spacing={4}>
        <Spacer />
        <ActivityMetric size={26} staticColor={ringColor} allowsResizing />
        <BatteryBadge iconSize={11} textSize={11} />
        <Spacer />
      </VStack>
    ),
  };
};

export default createLiveActivity<TonightWidgetProps>('SleepWidgetV2', SleepLiveActivityComponent);