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
  type ActivityRingConfig = {
    color: string;
    value: number;
  };
  type ActivityMetricConfig = {
    fallbackColor: string;
    fallbackText: string;
    timerColor: string;
    timerText: string | null;
  };

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

  function ActivityRing({ ring, size }: { ring: ActivityRingConfig; size: number }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={ring.value}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ring.color), frame({ width: size, height: size })]}
        />

        <Image color={ring.color} size={size >= 56 ? 22 : 16} systemName={primaryIcon} />
      </ZStack>
    );
  }

  function ActivityMetric({
    allowsResizing,
    metric,
    size,
  }: {
    allowsResizing?: boolean;
    metric: ActivityMetricConfig;
    size: number;
  }) {
    const needsCompression = metric.timerText?.includes(' ') ?? false;
    const resolvedSize = allowsResizing && needsCompression ? Math.max(16, size - 6) : size;

    if (metric.timerText) {
      return (
        <Text
          modifiers={[
            font({ size: resolvedSize, weight: 'bold', design: 'rounded' }),
            foregroundStyle(metric.timerColor),
            monospacedDigit(),
            allowsTightening(needsCompression),
            kerning(allowsResizing && needsCompression ? -0.4 : undefined),
            lineLimit(1),
          ]}>
          {metric.timerText}
        </Text>
      );
    }

    return (
      <Text
        modifiers={[
          font({ size, weight: 'bold', design: 'rounded' }),
          foregroundStyle(metric.fallbackColor),
          monospacedDigit(),
          lineLimit(1),
        ]}>
        {metric.fallbackText}
      </Text>
    );
  }

  function CompactTrailingMetric({ metric }: { metric: ActivityMetricConfig }) {
    const needsCompression = metric.timerText?.includes(' ') ?? false;
    const compactSize = needsCompression ? 12 : 14;

    if (metric.timerText) {
      return (
        <Text
          modifiers={[
            font({ size: compactSize, weight: 'bold', design: 'rounded' }),
            foregroundStyle(metric.timerColor),
            monospacedDigit(),
            allowsTightening(needsCompression),
            kerning(needsCompression ? -0.3 : undefined),
            lineLimit(1),
          ]}>
          {metric.timerText}
        </Text>
      );
    }

    return (
      <Text
        modifiers={[
          font({ size: 14, weight: 'bold', design: 'rounded' }),
          foregroundStyle(metric.fallbackColor),
          monospacedDigit(),
          lineLimit(1),
        ]}>
        {metric.fallbackText}
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

  function LiveActivityBannerLayout({
    detail,
    headline,
    metric,
    ring,
    schedule,
  }: {
    detail: string;
    headline: string;
    metric: ActivityMetricConfig;
    ring: ActivityRingConfig;
    schedule: string;
  }) {
    return (
      <HStack alignment="center" spacing={12} modifiers={[padding({ all: 14 })]}>
        <ActivityRing ring={ring} size={56} />
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
            {headline}
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
            {schedule}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
            {detail}
          </Text>
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={2}>
          <ActivityMetric metric={metric} size={20} />
          <BatteryBadge iconSize={11} textSize={11} />
        </VStack>
      </HStack>
    );
  }

  function LiveActivityBannerSleeping() {
    return (
      <LiveActivityBannerLayout
        detail={sleepNeedLabel()}
        headline="Sleep in progress"
        metric={{
          fallbackColor: sleepAccent,
          fallbackText: `${sleepProgressValue}`,
          timerColor: sleepAccent,
          timerText: formatRelativeTimeText(props.sleepStartTimestamp, false),
        }}
        ring={{ color: sleepAccent, value: sleepProgressValue }}
        schedule={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
      />
    );
  }

  function LiveActivityBannerBedtimePassed() {
    const wakeCountdown = formatRelativeTimeText(props.wakeTimestamp, true);

    return (
      <LiveActivityBannerLayout
        detail={wakeCountdown ? `Wake in ${wakeCountdown}` : 'Wake soon'}
        headline="It is past your bedtime"
        metric={{
          fallbackColor: sleepWarm,
          fallbackText: '0',
          timerColor: alert,
          timerText: formatRelativeTimeText(props.bedtimeTimestamp, false),
        }}
        ring={{ color: sleepWarm, value: 0 }}
        schedule={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
      />
    );
  }

  function LiveActivityBannerWindDown() {
    return (
      <LiveActivityBannerLayout
        detail={sleepNeedLabel()}
        headline="Wind down now"
        metric={{
          fallbackColor: sleepCyan,
          fallbackText: 'Now',
          timerColor: sleepCyan,
          timerText: formatRelativeTimeText(props.bedtimeTimestamp, true),
        }}
        ring={{ color: sleepCyan, value: 0 }}
        schedule={`Bed ${formatClock(props.bedtimeTimestamp)} · Wake ${formatClock(props.wakeTimestamp)}`}
      />
    );
  }

  function LiveActivityBannerAwake() {
    const bedCountdown = formatRelativeTimeText(props.bedtimeTimestamp, true);

    return (
      <LiveActivityBannerLayout
        detail={bedCountdown ? `Bed in ${bedCountdown}` : 'Tonight plan'}
        headline="Tonight plan"
        metric={{
          fallbackColor: scoreRingColor,
          fallbackText: formatClock(props.bedtimeTimestamp),
          timerColor: scoreRingColor,
          timerText: null,
        }}
        ring={{ color: scoreRingColor, value: 0 }}
        schedule={`Bed ${formatClock(props.bedtimeTimestamp)} · Wake ${formatClock(props.wakeTimestamp)}`}
      />
    );
  }

  function LiveActivityBannerSmallLayout({ headline }: { headline: string }) {
    return (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), padding({ all: 10 }), lineLimit(1)]}>
        {headline}
      </Text>
    );
  }

  function LiveActivityBannerSmallSleeping() {
    return <LiveActivityBannerSmallLayout headline="Sleep in progress" />;
  }

  function LiveActivityBannerSmallBedtimePassed() {
    return <LiveActivityBannerSmallLayout headline="It is past your bedtime" />;
  }

  function LiveActivityBannerSmallWindDown() {
    return <LiveActivityBannerSmallLayout headline="Wind down now" />;
  }

  function LiveActivityBannerSmallAwake() {
    return <LiveActivityBannerSmallLayout headline="Tonight plan" />;
  }

  function LiveActivityIcon({ color, size }: { color: string; size: number }) {
    return <Image color={color} size={size} systemName={primaryIcon} />;
  }

  function LiveActivityCompactLeadingSleeping() {
    return <LiveActivityIcon color={sleepAccent} size={16} />;
  }

  function LiveActivityCompactLeadingBedtimePassed() {
    return <LiveActivityIcon color={sleepWarm} size={16} />;
  }

  function LiveActivityCompactLeadingWindDown() {
    return <LiveActivityIcon color={sleepCyan} size={16} />;
  }

  function LiveActivityCompactLeadingAwake() {
    return <LiveActivityIcon color={sleepCyan} size={16} />;
  }

  function LiveActivityCompactTrailingSleeping() {
    return (
      <CompactTrailingMetric
        metric={{
          fallbackColor: sleepAccent,
          fallbackText: `${sleepProgressValue}`,
          timerColor: sleepAccent,
          timerText: formatRelativeTimeText(props.sleepStartTimestamp, false),
        }}
      />
    );
  }

  function LiveActivityCompactTrailingBedtimePassed() {
    return (
      <CompactTrailingMetric
        metric={{
          fallbackColor: sleepWarm,
          fallbackText: '0',
          timerColor: alert,
          timerText: formatRelativeTimeText(props.bedtimeTimestamp, false),
        }}
      />
    );
  }

  function LiveActivityCompactTrailingWindDown() {
    return (
      <CompactTrailingMetric
        metric={{
          fallbackColor: sleepCyan,
          fallbackText: 'Now',
          timerColor: sleepCyan,
          timerText: formatRelativeTimeText(props.bedtimeTimestamp, true),
        }}
      />
    );
  }

  function LiveActivityCompactTrailingAwake() {
    return (
      <CompactTrailingMetric
        metric={{
          fallbackColor: text,
          fallbackText: formatClock(props.bedtimeTimestamp),
          timerColor: scoreRingColor,
          timerText: null,
        }}
      />
    );
  }

  function LiveActivityMinimalSleeping() {
    return <LiveActivityIcon color={sleepAccent} size={15} />;
  }

  function LiveActivityMinimalBedtimePassed() {
    return <LiveActivityIcon color={sleepWarm} size={15} />;
  }

  function LiveActivityMinimalWindDown() {
    return <LiveActivityIcon color={sleepCyan} size={15} />;
  }

  function LiveActivityMinimalAwake() {
    return <LiveActivityIcon color={sleepCyan} size={15} />;
  }

  function LiveActivityExpandedLeadingSleeping() {
    return <LiveActivityExpandedLeadingRing ring={{ color: sleepAccent, value: sleepProgressValue }} />;
  }

  function LiveActivityExpandedLeadingBedtimePassed() {
    return <LiveActivityExpandedLeadingRing ring={{ color: sleepWarm, value: 0 }} />;
  }

  function LiveActivityExpandedLeadingWindDown() {
    return <LiveActivityExpandedLeadingRing ring={{ color: sleepCyan, value: 0 }} />;
  }

  function LiveActivityExpandedLeadingAwake() {
    return <LiveActivityExpandedLeadingRing ring={{ color: scoreRingColor, value: 0 }} />;
  }

  function LiveActivityExpandedLeadingRing({ ring }: { ring: ActivityRingConfig }) {
    return (
      <VStack alignment="leading" spacing={4}>
        <Spacer />
        <ActivityRing ring={ring} size={68} />
        <Spacer />
      </VStack>
    );
  }

  function LiveActivityExpandedCenterLayout({
    detail,
    headline,
    schedule,
  }: {
    detail: string;
    headline: string;
    schedule: string;
  }) {
    return (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          {headline}
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          {schedule}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          {detail}
        </Text>
      </VStack>
    );
  }

  function LiveActivityExpandedCenterSleeping() {
    return (
      <LiveActivityExpandedCenterLayout
        detail={sleepNeedLabel()}
        headline="Sleep in progress"
        schedule={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
      />
    );
  }

  function LiveActivityExpandedCenterBedtimePassed() {
    const wakeCountdown = formatRelativeTimeText(props.wakeTimestamp, true);

    return (
      <LiveActivityExpandedCenterLayout
        detail={wakeCountdown ? `Wake in ${wakeCountdown}` : 'Wake soon'}
        headline="It is past your bedtime"
        schedule={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
      />
    );
  }

  function LiveActivityExpandedCenterWindDown() {
    return (
      <LiveActivityExpandedCenterLayout
        detail={sleepNeedLabel()}
        headline="Wind down now"
        schedule={`Bed ${formatClock(props.bedtimeTimestamp)} · Wake ${formatClock(props.wakeTimestamp)}`}
      />
    );
  }

  function LiveActivityExpandedCenterAwake() {
    const bedCountdown = formatRelativeTimeText(props.bedtimeTimestamp, true);

    return (
      <LiveActivityExpandedCenterLayout
        detail={bedCountdown ? `Bed in ${bedCountdown}` : 'Tonight plan'}
        headline="Tonight plan"
        schedule={`Bed ${formatClock(props.bedtimeTimestamp)} · Wake ${formatClock(props.wakeTimestamp)}`}
      />
    );
  }

  function LiveActivityExpandedTrailingSleeping() {
    return (
      <LiveActivityExpandedTrailingMetric
        metric={{
          fallbackColor: sleepAccent,
          fallbackText: `${sleepProgressValue}`,
          timerColor: sleepAccent,
          timerText: formatRelativeTimeText(props.sleepStartTimestamp, false),
        }}
      />
    );
  }

  function LiveActivityExpandedTrailingBedtimePassed() {
    return (
      <LiveActivityExpandedTrailingMetric
        metric={{
          fallbackColor: sleepWarm,
          fallbackText: '0',
          timerColor: alert,
          timerText: formatRelativeTimeText(props.bedtimeTimestamp, false),
        }}
      />
    );
  }

  function LiveActivityExpandedTrailingWindDown() {
    return (
      <LiveActivityExpandedTrailingMetric
        metric={{
          fallbackColor: sleepCyan,
          fallbackText: 'Now',
          timerColor: sleepCyan,
          timerText: formatRelativeTimeText(props.bedtimeTimestamp, true),
        }}
      />
    );
  }

  function LiveActivityExpandedTrailingAwake() {
    return (
      <LiveActivityExpandedTrailingMetric
        metric={{
          fallbackColor: scoreRingColor,
          fallbackText: formatClock(props.bedtimeTimestamp),
          timerColor: scoreRingColor,
          timerText: null,
        }}
      />
    );
  }

  function LiveActivityExpandedTrailingMetric({ metric }: { metric: ActivityMetricConfig }) {
    return (
      <VStack alignment="trailing" spacing={4}>
        <Spacer />
        <ActivityMetric metric={metric} size={26} allowsResizing />
        <BatteryBadge iconSize={11} textSize={11} />
        <Spacer />
      </VStack>
    );
  }

  switch (props.surfaceMode) {
    case 'sleep':
      return {
        banner: <LiveActivityBannerSleeping />,
        bannerSmall: <LiveActivityBannerSmallSleeping />,
        compactLeading: <LiveActivityCompactLeadingSleeping />,
        compactTrailing: <LiveActivityCompactTrailingSleeping />,
        minimal: <LiveActivityMinimalSleeping />,
        expandedLeading: <LiveActivityExpandedLeadingSleeping />,
        expandedCenter: <LiveActivityExpandedCenterSleeping />,
        expandedTrailing: <LiveActivityExpandedTrailingSleeping />,
      };
    case 'bedtime_passed':
      return {
        banner: <LiveActivityBannerBedtimePassed />,
        bannerSmall: <LiveActivityBannerSmallBedtimePassed />,
        compactLeading: <LiveActivityCompactLeadingBedtimePassed />,
        compactTrailing: <LiveActivityCompactTrailingBedtimePassed />,
        minimal: <LiveActivityMinimalBedtimePassed />,
        expandedLeading: <LiveActivityExpandedLeadingBedtimePassed />,
        expandedCenter: <LiveActivityExpandedCenterBedtimePassed />,
        expandedTrailing: <LiveActivityExpandedTrailingBedtimePassed />,
      };
    case 'wind_down':
      return {
        banner: <LiveActivityBannerWindDown />,
        bannerSmall: <LiveActivityBannerSmallWindDown />,
        compactLeading: <LiveActivityCompactLeadingWindDown />,
        compactTrailing: <LiveActivityCompactTrailingWindDown />,
        minimal: <LiveActivityMinimalWindDown />,
        expandedLeading: <LiveActivityExpandedLeadingWindDown />,
        expandedCenter: <LiveActivityExpandedCenterWindDown />,
        expandedTrailing: <LiveActivityExpandedTrailingWindDown />,
      };
    case 'awake':
    default:
      return {
        banner: <LiveActivityBannerAwake />,
        bannerSmall: <LiveActivityBannerSmallAwake />,
        compactLeading: <LiveActivityCompactLeadingAwake />,
        compactTrailing: <LiveActivityCompactTrailingAwake />,
        minimal: <LiveActivityMinimalAwake />,
        expandedLeading: <LiveActivityExpandedLeadingAwake />,
        expandedCenter: <LiveActivityExpandedCenterAwake />,
        expandedTrailing: <LiveActivityExpandedTrailingAwake />,
      };
  }
};

export default createLiveActivity<TonightWidgetProps>('SleepWidgetV2', SleepLiveActivityComponent);
