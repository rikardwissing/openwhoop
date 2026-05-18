import { Gauge, HStack, Image, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  containerBackground,
  foregroundStyle,
  font,
  frame,
  gaugeStyle,
  lineLimit,
  monospacedDigit,
  padding,
  tint,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

import type { TonightSurfaceMode } from '@/utils/sleepPlan';

export interface TonightWidgetProps {
  batteryCharging?: boolean;
  batteryPercent?: number | null;
  bedtimeTimestamp?: number;
  napCreditMinutes?: number;
  progress?: number;
  projectedSleepTimestamp?: number;
  score?: number | null;
  sleepDebtMinutes?: number;
  sleepNeedMinutes?: number;
  sleepProgress?: number;
  sleepStartTimestamp?: number;
  surfaceMode: TonightSurfaceMode;
  wakeTimestamp?: number;
}

const TonightWidgetComponent = (rawProps: TonightWidgetProps, environment: WidgetEnvironment) => {
  'widget';

  function buildTimeOfDayGreeting(now = new Date()) {
    const hour = now.getHours();

    if (hour < 12) {
      return 'Good morning';
    }

    if (hour < 18) {
      return 'Good afternoon';
    }

    if (hour < 22) {
      return 'Good evening';
    }

    return 'Good night';
  }

  const accent = '#52D8E8';
  const caution = '#ffd26b';
  const alert = '#ff7d70';
  const success = '#8dffb3';
  const secondary = '#A9B5D1';
  const subtle = '#7684A6';
  const text = '#F6F8FF';
  const widgetBackground = '#0F172A';
  const sleepAccent = '#B7B2FF';
  const sleepCyan = '#78E6F4';
  const sleepSecondary = '#BCB8D8';
  const sleepSubtle = '#8582A9';
  const sleepText = '#F8F4FF';
  const sleepWarm = '#F4C66A';
  const sleepWidgetBackground = '#080B1F';
  const homeWidgetURL = 'btwearable://';
  const primaryIcon = 'moon.zzz.fill';

  const props: Required<TonightWidgetProps> = {
    batteryCharging: rawProps.batteryCharging ?? false,
    batteryPercent: rawProps.batteryPercent ?? null,
    bedtimeTimestamp: rawProps.bedtimeTimestamp ?? 0,
    napCreditMinutes: rawProps.napCreditMinutes ?? 0,
    progress: Math.max(0, Math.min(1, rawProps.progress ?? 0)),
    projectedSleepTimestamp: rawProps.projectedSleepTimestamp ?? 0,
    score:
      rawProps.score === null || rawProps.score === undefined
        ? null
        : Math.max(0, Math.min(100, rawProps.score)),
    sleepDebtMinutes: rawProps.sleepDebtMinutes ?? 0,
    sleepNeedMinutes: rawProps.sleepNeedMinutes ?? 0,
    sleepProgress: Math.max(0, Math.min(1, rawProps.sleepProgress ?? 0)),
    sleepStartTimestamp: rawProps.sleepStartTimestamp ?? 0,
    surfaceMode: rawProps.surfaceMode,
    wakeTimestamp: rawProps.wakeTimestamp ?? 0,
  };

  const accessoryFamily = environment.widgetFamily.startsWith('accessory');
  const sleepTheme = props.surfaceMode !== 'awake';
  const resolvedText = sleepTheme ? sleepText : text;
  const resolvedSecondary = sleepTheme ? sleepSecondary : secondary;
  const resolvedSubtle = sleepTheme ? sleepSubtle : subtle;
  const primaryColor = accessoryFamily ? { type: 'hierarchical' as const, style: 'primary' as const } : resolvedText;
  const secondaryColor = accessoryFamily ? { type: 'hierarchical' as const, style: 'secondary' as const } : resolvedSecondary;
  const widgetBackgroundColor = sleepTheme ? sleepWidgetBackground : widgetBackground;
  const scoreValue = props.score === null ? 0 : Math.round(props.score);
  const scoreText = props.score === null ? '--' : `${scoreValue}`;
  const scoreHeadline = props.score === null ? 'Sleep --' : `Sleep ${scoreText}`;
  const scoreRingColor =
    props.score === null ? accent : props.score >= 80 ? success : props.score >= 65 ? caution : alert;
  const scoreTextColor =
    props.score === null
      ? text
      : props.score >= 80
        ? '#f5fff8'
        : props.score >= 65
          ? '#fff8ee'
          : '#fff3f1';
  const sleepProgressValue = Math.max(6, Math.min(96, Math.round(props.sleepProgress * 100)));
  type SurfaceColor = string | { type: 'hierarchical'; style: 'primary' | 'secondary' };
  type RingConfig = {
    color: string;
    text?: string;
    textColor?: string;
    value: number;
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

  function formatCountdown(timestamp: number, now = new Date()) {
    if (timestamp <= 0) {
      return '--';
    }

    const minutes = Math.max(0, Math.ceil((timestamp - now.getTime()) / 60_000));

    if (minutes <= 1) {
      return 'now';
    }

    return formatDuration(minutes);
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

  function sleepDebtLabel() {
    if (props.sleepDebtMinutes > 0) {
      return `${formatDuration(props.sleepDebtMinutes)} debt`;
    }

    if (props.napCreditMinutes > 0) {
      return `${formatDuration(props.napCreditMinutes)} nap credit`;
    }

    return 'No sleep debt';
  }

  function Ring({
    color,
    scoreFontSize,
    size,
    text: ringLabel,
    textColor: ringLabelColor = sleepText,
    value,
  }: {
    color: string;
    scoreFontSize?: number;
    size: number;
    text?: string;
    textColor?: string;
    value: number;
  }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={value}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(color), frame({ width: size, height: size })]}
        />

        {ringLabel ? (
          <Text
            modifiers={[
              font({
                size: scoreFontSize ?? (size >= 88 ? 26 : size >= 74 ? 23 : 18),
                weight: 'bold',
                design: 'rounded',
              }),
              foregroundStyle(ringLabelColor),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {ringLabel}
          </Text>
        ) : (
          <Image color={color} size={size >= 88 ? 26 : size >= 74 ? 26 : 20} systemName={primaryIcon} />
        )}
      </ZStack>
    );
  }

  function BatteryBadge() {
    const batteryStatusColor = props.batteryCharging
      ? success
      : props.batteryPercent !== null && props.batteryPercent < 10
        ? alert
        : props.batteryPercent !== null && props.batteryPercent < 20
          ? caution
          : null;
    const batteryIconColor = batteryStatusColor ?? resolvedSecondary;
    const batteryTextColor = batteryStatusColor ?? secondaryColor;

    return (
      <HStack alignment="center" spacing={3}>
        <Image color={batteryIconColor} size={11} systemName={batterySymbol()} />
        <Text
          modifiers={[
            font({ size: 10, weight: 'semibold' }),
            foregroundStyle(batteryTextColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {batteryLabel()}
        </Text>
      </HStack>
    );
  }

  function SleepNeedMetric() {
    return (
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
          Sleep need
        </Text>
        <Text
          modifiers={[
            font({ size: 18, weight: 'bold', design: 'rounded' }),
            foregroundStyle(primaryColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {formatDuration(props.sleepNeedMinutes)}
        </Text>
      </VStack>
    );
  }

  function WidgetLockScreenCircularRing({ ring }: { ring: RingConfig }) {
    return (
      <ZStack
        alignment="center"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Gauge
          value={ring.value}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ring.color)]}
        />

        {ring.text ? (
          <Text
            modifiers={[
              font({ size: 18, weight: 'bold', design: 'rounded' }),
              foregroundStyle(ring.textColor ?? sleepText),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {ring.text}
          </Text>
        ) : (
          <Image color={ring.color} size={18} systemName={primaryIcon} />
        )}
      </ZStack>
    );
  }

  function WidgetLockScreenCircularSleeping() {
    return <WidgetLockScreenCircularRing ring={{ color: sleepAccent, value: sleepProgressValue }} />;
  }

  function WidgetLockScreenCircularBedtimePassed() {
    return <WidgetLockScreenCircularRing ring={{ color: sleepWarm, value: 0 }} />;
  }

  function WidgetLockScreenCircularWindDown() {
    return <WidgetLockScreenCircularRing ring={{ color: sleepCyan, value: 0 }} />;
  }

  function WidgetLockScreenCircularAwake() {
    return (
      <WidgetLockScreenCircularRing
        ring={{ color: scoreRingColor, text: scoreText, textColor: scoreTextColor, value: scoreValue }}
      />
    );
  }

  function WidgetLockScreenInlineLayout({ text: inlineText }: { text: string }) {
    return (
      <ZStack modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), lineLimit(1)]}>{inlineText}</Text>
      </ZStack>
    );
  }

  function WidgetLockScreenInlineSleeping() {
    return (
      <WidgetLockScreenInlineLayout
        text={`Sleeping · Bed ${formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)} · 100% by ${formatClock(props.projectedSleepTimestamp)}`}
      />
    );
  }

  function WidgetLockScreenInlineBedtimePassed() {
    return (
      <WidgetLockScreenInlineLayout
        text={`Past bedtime · Bed Now! · 100% by ${formatClock(props.projectedSleepTimestamp)}`}
      />
    );
  }

  function WidgetLockScreenInlineWindDown() {
    return (
      <WidgetLockScreenInlineLayout
        text={`Wind down · Bed ${formatClock(props.bedtimeTimestamp)} · Wake ${formatClock(props.wakeTimestamp)}`}
      />
    );
  }

  function WidgetLockScreenInlineAwake() {
    return (
      <WidgetLockScreenInlineLayout
        text={`${scoreHeadline} · Bed ${formatClock(props.bedtimeTimestamp)} · Wake ${formatClock(props.wakeTimestamp)}`}
      />
    );
  }

  function WidgetLockScreenWideLayout({
    detail,
    headline,
    headlineColor,
    ring,
    schedule,
  }: {
    detail: string;
    headline: string;
    headlineColor: SurfaceColor;
    ring: RingConfig;
    schedule: string;
  }) {
    return (
      <ZStack alignment="topTrailing" modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={8}>
          <Ring {...ring} size={46} scoreFontSize={21} />
          <VStack alignment="leading" spacing={0}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(headlineColor), lineLimit(1)]}>
              {headline}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              {schedule}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              {detail}
            </Text>
          </VStack>
        </HStack>
      </ZStack>
    );
  }

  function WidgetLockScreenWideSleeping() {
    return (
      <WidgetLockScreenWideLayout
        detail={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
        headline="Sleep in progress"
        headlineColor={sleepCyan}
        ring={{ color: sleepAccent, value: sleepProgressValue }}
        schedule={`Bed ${formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)}`}
      />
    );
  }

  function WidgetLockScreenWideBedtimePassed() {
    return (
      <WidgetLockScreenWideLayout
        detail={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
        headline="Past bedtime"
        headlineColor={sleepCyan}
        ring={{ color: sleepWarm, value: 0 }}
        schedule="Bed Now!"
      />
    );
  }

  function WidgetLockScreenWideWindDown() {
    return (
      <WidgetLockScreenWideLayout
        detail={`Wake ${formatClock(props.wakeTimestamp)}`}
        headline="Wind down now"
        headlineColor={sleepCyan}
        ring={{ color: sleepCyan, value: 0 }}
        schedule={`Bed ${formatClock(props.bedtimeTimestamp)}`}
      />
    );
  }

  function WidgetLockScreenWideAwake() {
    const headline = buildTimeOfDayGreeting();

    return (
      <WidgetLockScreenWideLayout
        detail={`Wake ${formatClock(props.wakeTimestamp)}`}
        headline={headline}
        headlineColor={success}
        ring={{ color: scoreRingColor, text: scoreText, textColor: scoreTextColor, value: scoreValue }}
        schedule={`Bed ${formatClock(props.bedtimeTimestamp)}`}
      />
    );
  }

  function WidgetHomeScreenMediumLayout({
    detail,
    headline,
    headlineColor,
    ring,
    ringCaption,
    schedule,
    subdetail,
    value,
    valueColor,
    valueSize = 26,
  }: {
    detail: string;
    headline: string;
    headlineColor: SurfaceColor;
    ring: RingConfig;
    ringCaption: string;
    schedule: string;
    subdetail: string;
    value: string;
    valueColor: SurfaceColor;
    valueSize?: number;
  }) {
    return (
      <ZStack
        alignment="topTrailing"
        modifiers={[
          padding({ all: 4 }),
          widgetURL(homeWidgetURL),
          containerBackground(widgetBackgroundColor, 'widget'),
        ]}>
        <VStack alignment="leading" spacing={6}>
          <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(headlineColor), lineLimit(1)]}>
            {headline}
          </Text>
          <HStack alignment="center" spacing={14}>
            <VStack alignment="center" spacing={4}>
              <Ring {...ring} size={88} />
              <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                {ringCaption}
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={4}>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                {schedule}
              </Text>
              <Text
                modifiers={[
                  font({ size: valueSize, weight: 'bold', design: 'rounded' }),
                  foregroundStyle(valueColor),
                  monospacedDigit(),
                  lineLimit(1),
                ]}>
                {value}
              </Text>
              <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                {detail}
              </Text>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(resolvedSubtle), lineLimit(1)]}>
                {subdetail}
              </Text>
            </VStack>
            <Spacer />
            <VStack alignment="leading" spacing={2}>
              <SleepNeedMetric />
              <Text modifiers={[font({ size: 10, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                {sleepDebtLabel()}
              </Text>
            </VStack>
          </HStack>
        </VStack>
        <VStack alignment="trailing" spacing={0} modifiers={[padding({ top: 2, trailing: 6 })]}>
          <BatteryBadge />
        </VStack>
      </ZStack>
    );
  }

  function WidgetHomeScreenMediumSleeping() {
    return (
      <WidgetHomeScreenMediumLayout
        detail={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
        headline="Sweet dreams"
        headlineColor={sleepCyan}
        ring={{ color: sleepAccent, value: sleepProgressValue }}
        ringCaption="Progress"
        schedule="Sleep started"
        subdetail="Sleep in progress"
        value={formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)}
        valueColor={sleepWarm}
      />
    );
  }

  function WidgetHomeScreenMediumBedtimePassed() {
    return (
      <WidgetHomeScreenMediumLayout
        detail={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
        headline="Go to bed!"
        headlineColor={sleepCyan}
        ring={{ color: sleepWarm, value: 0 }}
        ringCaption="Bedtime"
        schedule="Past bedtime"
        subdetail={`Wake in ${formatCountdown(props.wakeTimestamp)}`}
        value="Now"
        valueColor={alert}
        valueSize={28}
      />
    );
  }

  function WidgetHomeScreenMediumWindDown() {
    return (
      <WidgetHomeScreenMediumLayout
        detail={`Wake ${formatClock(props.wakeTimestamp)}`}
        headline="Time to wind down"
        headlineColor={sleepCyan}
        ring={{ color: sleepCyan, value: 0 }}
        ringCaption="Wind down"
        schedule="Tonight's bedtime"
        subdetail={`Bedtime in ${formatCountdown(props.bedtimeTimestamp)}`}
        value={formatClock(props.bedtimeTimestamp)}
        valueColor={primaryColor}
      />
    );
  }

  function WidgetHomeScreenMediumAwake() {
    const headline = buildTimeOfDayGreeting();

    return (
      <WidgetHomeScreenMediumLayout
        detail={`Wake ${formatClock(props.wakeTimestamp)}`}
        headline={headline}
        headlineColor={success}
        ring={{ color: scoreRingColor, text: scoreText, textColor: scoreTextColor, value: scoreValue }}
        ringCaption="Last sleep"
        schedule="Tonight's bedtime"
        subdetail={`Bedtime in ${formatCountdown(props.bedtimeTimestamp)}`}
        value={formatClock(props.bedtimeTimestamp)}
        valueColor={primaryColor}
      />
    );
  }

  function WidgetHomeScreenSmallLayout({
    detail,
    ring,
    title,
    value,
    valueColor,
  }: {
    detail: string;
    ring: RingConfig;
    title: string;
    value: string;
    valueColor: string | { type: 'hierarchical'; style: 'primary' };
  }) {
    return (
      <ZStack
        alignment="top"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={0} modifiers={[frame({ width: 134 }), padding({ top: 8 })]}>
          <Spacer />
          <BatteryBadge />
        </HStack>

        <VStack alignment="center" spacing={5} modifiers={[frame({ width: 134, height: 154 }), padding({ top: 8 })]}>
          <Ring {...ring} size={76} />
          <VStack alignment="center" spacing={1}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              {title}
            </Text>
            <Text
              modifiers={[
                font({ size: 22, weight: 'bold', design: 'rounded' }),
                foregroundStyle(valueColor),
                monospacedDigit(),
                lineLimit(1),
              ]}>
              {value}
            </Text>
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              {detail}
            </Text>
          </VStack>
        </VStack>
      </ZStack>
    );
  }

  function WidgetHomeScreenSmallSleeping() {
    return (
      <WidgetHomeScreenSmallLayout
        detail={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
        ring={{ color: sleepAccent, value: sleepProgressValue }}
        title="Sleep in progress"
        value={formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)}
        valueColor={sleepWarm}
      />
    );
  }

  function WidgetHomeScreenSmallBedtimePassed() {
    return (
      <WidgetHomeScreenSmallLayout
        detail={`100% by ${formatClock(props.projectedSleepTimestamp)}`}
        ring={{ color: sleepWarm, value: 0 }}
        title="Past bedtime"
        value="Now"
        valueColor={alert}
      />
    );
  }

  function WidgetHomeScreenSmallWindDown() {
    return (
      <WidgetHomeScreenSmallLayout
        detail={`Wake ${formatClock(props.wakeTimestamp)}`}
        ring={{ color: sleepCyan, value: 0 }}
        title="Time to wind down"
        value={formatClock(props.bedtimeTimestamp)}
        valueColor={primaryColor}
      />
    );
  }

  function WidgetHomeScreenSmallAwake() {
    return (
      <WidgetHomeScreenSmallLayout
        detail={`Wake ${formatClock(props.wakeTimestamp)}`}
        ring={{ color: scoreRingColor, text: scoreText, textColor: scoreTextColor, value: scoreValue }}
        title="Tonight's bedtime"
        value={formatClock(props.bedtimeTimestamp)}
        valueColor={primaryColor}
      />
    );
  }

  if (environment.widgetFamily === 'accessoryCircular') {
    switch (props.surfaceMode) {
      case 'sleep':
        return <WidgetLockScreenCircularSleeping />;
      case 'bedtime_passed':
        return <WidgetLockScreenCircularBedtimePassed />;
      case 'wind_down':
        return <WidgetLockScreenCircularWindDown />;
      case 'awake':
      default:
        return <WidgetLockScreenCircularAwake />;
    }
  }

  if (environment.widgetFamily === 'accessoryInline') {
    switch (props.surfaceMode) {
      case 'sleep':
        return <WidgetLockScreenInlineSleeping />;
      case 'bedtime_passed':
        return <WidgetLockScreenInlineBedtimePassed />;
      case 'wind_down':
        return <WidgetLockScreenInlineWindDown />;
      case 'awake':
      default:
        return <WidgetLockScreenInlineAwake />;
    }
  }

  if (environment.widgetFamily === 'accessoryRectangular') {
    switch (props.surfaceMode) {
      case 'sleep':
        return <WidgetLockScreenWideSleeping />;
      case 'bedtime_passed':
        return <WidgetLockScreenWideBedtimePassed />;
      case 'wind_down':
        return <WidgetLockScreenWideWindDown />;
      case 'awake':
      default:
        return <WidgetLockScreenWideAwake />;
    }
  }

  if (environment.widgetFamily === 'systemMedium') {
    switch (props.surfaceMode) {
      case 'sleep':
        return <WidgetHomeScreenMediumSleeping />;
      case 'bedtime_passed':
        return <WidgetHomeScreenMediumBedtimePassed />;
      case 'wind_down':
        return <WidgetHomeScreenMediumWindDown />;
      case 'awake':
      default:
        return <WidgetHomeScreenMediumAwake />;
    }
  }

  switch (props.surfaceMode) {
    case 'sleep':
      return <WidgetHomeScreenSmallSleeping />;
    case 'bedtime_passed':
      return <WidgetHomeScreenSmallBedtimePassed />;
    case 'wind_down':
      return <WidgetHomeScreenSmallWindDown />;
    case 'awake':
    default:
      return <WidgetHomeScreenSmallAwake />;
  }
};

export default createWidget<TonightWidgetProps>('SleepWidgetV2', TonightWidgetComponent);
