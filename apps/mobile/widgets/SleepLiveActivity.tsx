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

  const props: Required<TonightWidgetProps> = {
    batteryCharging: rawProps.batteryCharging ?? false,
    batteryPercent: rawProps.batteryPercent ?? null,
    bedtimeTimestamp: rawProps.bedtimeTimestamp ?? 0,
    napCreditMinutes: rawProps.napCreditMinutes ?? 0,
    progress: clamp(rawProps.progress ?? 0, 0, 1),
    projectedSleepTimestamp: rawProps.projectedSleepTimestamp ?? 0,
    score:
      rawProps.score === null || rawProps.score === undefined
        ? null
        : clamp(rawProps.score, 0, 100),
    sleepDebtMinutes: rawProps.sleepDebtMinutes ?? 0,
    sleepNeedMinutes: rawProps.sleepNeedMinutes ?? 0,
    sleepProgress: clamp(rawProps.sleepProgress ?? 0, 0, 1),
    sleepStartTimestamp: rawProps.sleepStartTimestamp ?? 0,
    surfaceMode: rawProps.surfaceMode,
    wakeTimestamp: rawProps.wakeTimestamp ?? 0,
  };

  const sleepProgressValue = Math.max(6, Math.min(96, Math.round(props.sleepProgress * 100)));
  const scoreRingColor =
    props.score === null ? accent : props.score >= 80 ? success : props.score >= 65 ? caution : alert;

  function formatClock(timestamp: number) {
    if (timestamp <= 0) {
      return '--';
    }

    return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatDuration(minutes: number) {
    if (minutes <= 0) {
      return '--';
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours === 0) {
      return `${remainingMinutes}m`;
    }

    if (remainingMinutes === 0) {
      return `${hours}h`;
    }

    return `${hours}h ${remainingMinutes}m`;
  }

  function sleepNeedLabel() {
    const duration = formatDuration(props.sleepNeedMinutes);
    return duration === '--' ? 'Need --' : `Need ${duration}`;
  }

  function batteryLabel() {
    if (props.batteryPercent === null) {
      return '--%';
    }

    return `${Math.max(0, Math.min(100, Math.round(props.batteryPercent)))}%`;
  }

  function batterySymbol() {
    const percent = props.batteryPercent;

    if (percent === null) {
      return 'battery.100';
    }

    if (percent <= 10) {
      return 'battery.25';
    }

    if (percent <= 35) {
      return 'battery.50';
    }

    if (percent <= 65) {
      return 'battery.75';
    }

    return 'battery.100';
  }

  function formatRelativeTimeText(timestamp: number, countsDown: boolean, now = new Date()) {
    if (timestamp <= 0) {
      return null;
    }

    const rawMinutes = countsDown
      ? (timestamp - now.getTime()) / 60_000
      : (now.getTime() - timestamp) / 60_000;
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

  function ringValue() {
    return props.surfaceMode === 'sleep' ? sleepProgressValue : 0;
  }

  function ringColor() {
    switch (props.surfaceMode) {
      case 'sleep':
        return sleepAccent;
      case 'bedtime_passed':
        return sleepWarm;
      case 'wind_down':
        return sleepCyan;
      case 'awake':
      default:
        return scoreRingColor;
    }
  }

  function rightHandTimer() {
    switch (props.surfaceMode) {
      case 'sleep':
        return {
          color: sleepAccent,
          text: formatRelativeTimeText(props.sleepStartTimestamp, false),
        };
      case 'bedtime_passed':
        return {
          color: alert,
          text: formatRelativeTimeText(props.bedtimeTimestamp, false),
        };
      case 'wind_down':
        return {
          color: sleepCyan,
          text: formatRelativeTimeText(props.bedtimeTimestamp, true),
        };
      case 'awake':
      default:
        return {
          color: scoreRingColor,
          text: null,
        };
    }
  }

  function compactTrailingText() {
    if (props.surfaceMode === 'sleep') {
      return `${sleepProgressValue}`;
    }

    if (props.surfaceMode === 'bedtime_passed') {
      return '0';
    }

    if (props.surfaceMode === 'wind_down') {
      return 'Now';
    }

    return formatClock(props.bedtimeTimestamp);
  }

  function ActivityRing({ size }: { size: number }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={ringValue()}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ringColor()), frame({ width: size, height: size })]}
        />

        <Image color={ringColor()} size={size >= 56 ? 22 : 16} systemName={primaryIcon} />
      </ZStack>
    );
  }

  function ActivityMetric({ size, allowsResizing }: { size: number; allowsResizing?: boolean }) {
    const timer = rightHandTimer();
    const needsCompression = timer.text?.includes(' ') ?? false;
    const resolvedSize = allowsResizing && needsCompression ? Math.max(16, size - 6) : size;

    if (timer.text) {
      return (
        <Text
          modifiers={[
            font({ size: resolvedSize, weight: 'bold', design: 'rounded' }),
            foregroundStyle(timer.color),
            monospacedDigit(),
            allowsTightening(needsCompression),
            kerning(allowsResizing && needsCompression ? -0.4 : undefined),
            lineLimit(1),
          ]}>
          {timer.text}
        </Text>
      );
    }

    return (
      <Text
        modifiers={[
          font({ size, weight: 'bold', design: 'rounded' }),
          foregroundStyle(ringColor()),
          monospacedDigit(),
          lineLimit(1),
        ]}>
        {compactTrailingText()}
      </Text>
    );
  }

  function CompactTrailingMetric() {
    const timer = rightHandTimer();
    const needsCompression = timer.text?.includes(' ') ?? false;
    const compactSize = needsCompression ? 12 : 14;

    if (timer.text) {
      return (
        <Text
          modifiers={[
            font({ size: compactSize, weight: 'bold', design: 'rounded' }),
            foregroundStyle(timer.color),
            monospacedDigit(),
            allowsTightening(needsCompression),
            kerning(needsCompression ? -0.3 : undefined),
            lineLimit(1),
          ]}>
          {timer.text}
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
        {compactTrailingText()}
      </Text>
    );
  }

  function BatteryBadge({ iconSize, textSize }: { iconSize: number; textSize: number }) {
    const batteryColor = props.batteryCharging
      ? success
      : props.batteryPercent !== null && props.batteryPercent < 10
        ? alert
        : props.batteryPercent !== null && props.batteryPercent < 20
          ? caution
          : secondary;

    return (
      <HStack alignment="center" spacing={3}>
        <Image color={batteryColor} size={iconSize} systemName={batterySymbol()} />
        <Text
          modifiers={[
            font({ size: textSize, weight: 'medium' }),
            foregroundStyle(batteryColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {batteryLabel()}
        </Text>
      </HStack>
    );
  }

  function LiveActivityBannerSleeping() {
    return (
      <HStack alignment="center" spacing={12} modifiers={[padding({ all: 14 })]}>
        <ActivityRing size={56} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
            Sleep in progress
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
            100% by {formatClock(props.projectedSleepTimestamp)}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
            {sleepNeedLabel()}
          </Text>
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={2}>
          <ActivityMetric size={20} />
          <BatteryBadge iconSize={11} textSize={11} />
        </VStack>
      </HStack>
    );
  }

  function LiveActivityBannerBedtimePassed() {
    const wakeCountdown = formatRelativeTimeText(props.wakeTimestamp, true);

    return (
      <HStack alignment="center" spacing={12} modifiers={[padding({ all: 14 })]}>
        <ActivityRing size={56} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
            Bedtime has started
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
            100% by {formatClock(props.projectedSleepTimestamp)}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
            {wakeCountdown ? `Wake in ${wakeCountdown}` : 'Wake soon'}
          </Text>
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={2}>
          <ActivityMetric size={20} />
          <BatteryBadge iconSize={11} textSize={11} />
        </VStack>
      </HStack>
    );
  }

  function LiveActivityBannerWindDown() {
    return (
      <HStack alignment="center" spacing={12} modifiers={[padding({ all: 14 })]}>
        <ActivityRing size={56} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
            Wind down now
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
            Bed {formatClock(props.bedtimeTimestamp)} · Wake {formatClock(props.wakeTimestamp)}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
            {sleepNeedLabel()}
          </Text>
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={2}>
          <ActivityMetric size={20} />
          <BatteryBadge iconSize={11} textSize={11} />
        </VStack>
      </HStack>
    );
  }

  function LiveActivityBannerAwake() {
    const bedCountdown = formatRelativeTimeText(props.bedtimeTimestamp, true);

    return (
      <HStack alignment="center" spacing={12} modifiers={[padding({ all: 14 })]}>
        <ActivityRing size={56} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
            Tonight plan
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
            Bed {formatClock(props.bedtimeTimestamp)} · Wake {formatClock(props.wakeTimestamp)}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
            {bedCountdown ? `Bed in ${bedCountdown}` : 'Tonight plan'}
          </Text>
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={2}>
          <ActivityMetric size={20} />
          <BatteryBadge iconSize={11} textSize={11} />
        </VStack>
      </HStack>
    );
  }

  function LiveActivityBannerSmallSleeping() {
    return (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), padding({ all: 10 }), lineLimit(1)]}>
        Sleep in progress
      </Text>
    );
  }

  function LiveActivityBannerSmallBedtimePassed() {
    return (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), padding({ all: 10 }), lineLimit(1)]}>
        Bedtime has started
      </Text>
    );
  }

  function LiveActivityBannerSmallWindDown() {
    return (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), padding({ all: 10 }), lineLimit(1)]}>
        Wind down now
      </Text>
    );
  }

  function LiveActivityBannerSmallAwake() {
    return (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), padding({ all: 10 }), lineLimit(1)]}>
        Tonight plan
      </Text>
    );
  }

  function LiveActivityCompactLeadingSleeping() {
    return <Image color={sleepAccent} size={16} systemName={primaryIcon} />;
  }

  function LiveActivityCompactLeadingBedtimePassed() {
    return <Image color={sleepWarm} size={16} systemName={primaryIcon} />;
  }

  function LiveActivityCompactLeadingWindDown() {
    return <Image color={sleepCyan} size={16} systemName={primaryIcon} />;
  }

  function LiveActivityCompactLeadingAwake() {
    return <Image color={sleepCyan} size={16} systemName={primaryIcon} />;
  }

  function LiveActivityCompactTrailingSleeping() {
    return <CompactTrailingMetric />;
  }

  function LiveActivityCompactTrailingBedtimePassed() {
    return <CompactTrailingMetric />;
  }

  function LiveActivityCompactTrailingWindDown() {
    return <CompactTrailingMetric />;
  }

  function LiveActivityCompactTrailingAwake() {
    return <CompactTrailingMetric />;
  }

  function LiveActivityMinimalSleeping() {
    return <Image color={sleepAccent} size={15} systemName={primaryIcon} />;
  }

  function LiveActivityMinimalBedtimePassed() {
    return <Image color={sleepWarm} size={15} systemName={primaryIcon} />;
  }

  function LiveActivityMinimalWindDown() {
    return <Image color={sleepCyan} size={15} systemName={primaryIcon} />;
  }

  function LiveActivityMinimalAwake() {
    return <Image color={sleepCyan} size={15} systemName={primaryIcon} />;
  }

  function LiveActivityExpandedLeadingSleeping() {
    return <LiveActivityExpandedLeadingRing />;
  }

  function LiveActivityExpandedLeadingBedtimePassed() {
    return <LiveActivityExpandedLeadingRing />;
  }

  function LiveActivityExpandedLeadingWindDown() {
    return <LiveActivityExpandedLeadingRing />;
  }

  function LiveActivityExpandedLeadingAwake() {
    return <LiveActivityExpandedLeadingRing />;
  }

  function LiveActivityExpandedLeadingRing() {
    return (
      <VStack alignment="leading" spacing={4}>
        <Spacer />
        <ActivityRing size={68} />
        <Spacer />
      </VStack>
    );
  }

  function LiveActivityExpandedCenterSleeping() {
    return (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          Sleep in progress
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          100% by {formatClock(props.projectedSleepTimestamp)}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {sleepNeedLabel()}
        </Text>
      </VStack>
    );
  }

  function LiveActivityExpandedCenterBedtimePassed() {
    const wakeCountdown = formatRelativeTimeText(props.wakeTimestamp, true);

    return (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          Bedtime has started
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          100% by {formatClock(props.projectedSleepTimestamp)}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {wakeCountdown ? `Wake in ${wakeCountdown}` : 'Wake soon'}
        </Text>
      </VStack>
    );
  }

  function LiveActivityExpandedCenterWindDown() {
    return (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          Wind down now
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          Bed {formatClock(props.bedtimeTimestamp)} · Wake {formatClock(props.wakeTimestamp)}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {sleepNeedLabel()}
        </Text>
      </VStack>
    );
  }

  function LiveActivityExpandedCenterAwake() {
    const bedCountdown = formatRelativeTimeText(props.bedtimeTimestamp, true);

    return (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          Tonight plan
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          Bed {formatClock(props.bedtimeTimestamp)} · Wake {formatClock(props.wakeTimestamp)}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {bedCountdown ? `Bed in ${bedCountdown}` : 'Tonight plan'}
        </Text>
      </VStack>
    );
  }

  function LiveActivityExpandedTrailingSleeping() {
    return <LiveActivityExpandedTrailingMetric />;
  }

  function LiveActivityExpandedTrailingBedtimePassed() {
    return <LiveActivityExpandedTrailingMetric />;
  }

  function LiveActivityExpandedTrailingWindDown() {
    return <LiveActivityExpandedTrailingMetric />;
  }

  function LiveActivityExpandedTrailingAwake() {
    return <LiveActivityExpandedTrailingMetric />;
  }

  function LiveActivityExpandedTrailingMetric() {
    return (
      <VStack alignment="trailing" spacing={4}>
        <Spacer />
        <ActivityMetric size={26} allowsResizing />
        <BatteryBadge iconSize={11} textSize={11} />
        <Spacer />
      </VStack>
    );
  }

  const banner = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityBannerSleeping />;
      case 'bedtime_passed':
        return <LiveActivityBannerBedtimePassed />;
      case 'wind_down':
        return <LiveActivityBannerWindDown />;
      case 'awake':
      default:
        return <LiveActivityBannerAwake />;
    }
  })();

  const bannerSmall = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityBannerSmallSleeping />;
      case 'bedtime_passed':
        return <LiveActivityBannerSmallBedtimePassed />;
      case 'wind_down':
        return <LiveActivityBannerSmallWindDown />;
      case 'awake':
      default:
        return <LiveActivityBannerSmallAwake />;
    }
  })();

  const compactLeading = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityCompactLeadingSleeping />;
      case 'bedtime_passed':
        return <LiveActivityCompactLeadingBedtimePassed />;
      case 'wind_down':
        return <LiveActivityCompactLeadingWindDown />;
      case 'awake':
      default:
        return <LiveActivityCompactLeadingAwake />;
    }
  })();

  const compactTrailing = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityCompactTrailingSleeping />;
      case 'bedtime_passed':
        return <LiveActivityCompactTrailingBedtimePassed />;
      case 'wind_down':
        return <LiveActivityCompactTrailingWindDown />;
      case 'awake':
      default:
        return <LiveActivityCompactTrailingAwake />;
    }
  })();

  const minimal = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityMinimalSleeping />;
      case 'bedtime_passed':
        return <LiveActivityMinimalBedtimePassed />;
      case 'wind_down':
        return <LiveActivityMinimalWindDown />;
      case 'awake':
      default:
        return <LiveActivityMinimalAwake />;
    }
  })();

  const expandedLeading = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityExpandedLeadingSleeping />;
      case 'bedtime_passed':
        return <LiveActivityExpandedLeadingBedtimePassed />;
      case 'wind_down':
        return <LiveActivityExpandedLeadingWindDown />;
      case 'awake':
      default:
        return <LiveActivityExpandedLeadingAwake />;
    }
  })();

  const expandedCenter = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityExpandedCenterSleeping />;
      case 'bedtime_passed':
        return <LiveActivityExpandedCenterBedtimePassed />;
      case 'wind_down':
        return <LiveActivityExpandedCenterWindDown />;
      case 'awake':
      default:
        return <LiveActivityExpandedCenterAwake />;
    }
  })();

  const expandedTrailing = (() => {
    switch (props.surfaceMode) {
      case 'sleep':
        return <LiveActivityExpandedTrailingSleeping />;
      case 'bedtime_passed':
        return <LiveActivityExpandedTrailingBedtimePassed />;
      case 'wind_down':
        return <LiveActivityExpandedTrailingWindDown />;
      case 'awake':
      default:
        return <LiveActivityExpandedTrailingAwake />;
    }
  })();

  return {
    banner,
    bannerSmall,
    compactLeading,
    compactTrailing,
    minimal,
    expandedLeading,
    expandedCenter,
    expandedTrailing,
  };
};

export default createLiveActivity<TonightWidgetProps>('SleepWidgetV2', SleepLiveActivityComponent);
