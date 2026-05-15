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

  function ringValue() {
    if (props.surfaceMode === 'sleep') {
      return sleepProgressValue;
    }

    if (props.surfaceMode === 'awake') {
      return scoreValue;
    }

    return 0;
  }

  function ringColor() {
    switch (props.surfaceMode) {
      case 'sleep':
        return sleepAccent;
      case 'wind_down':
        return sleepCyan;
      case 'bedtime_passed':
        return sleepWarm;
      case 'awake':
      default:
        return scoreRingColor;
    }
  }

  function ringText() {
    return props.surfaceMode === 'sleep' ? `${sleepProgressValue}` : scoreText;
  }

  function ringTextColor() {
    return props.surfaceMode === 'awake' ? scoreTextColor : sleepText;
  }

  function showRingIcon() {
    return props.surfaceMode !== 'awake';
  }

  function Ring({ size, scoreFontSize }: { size: number; scoreFontSize?: number }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={ringValue()}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ringColor()), frame({ width: size, height: size })]}
        />

        {showRingIcon() ? (
          <Image color={ringColor()} size={size >= 88 ? 26 : size >= 74 ? 26 : 20} systemName={primaryIcon} />
        ) : (
          <Text
            modifiers={[
              font({
                size: scoreFontSize ?? (size >= 88 ? 26 : size >= 74 ? 23 : 18),
                weight: 'bold',
                design: 'rounded',
              }),
              foregroundStyle(ringTextColor()),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {ringText()}
          </Text>
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

  function WidgetLockScreenCircularRing() {
    return (
      <ZStack
        alignment="center"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Gauge
          value={ringValue()}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ringColor())]}
        />

        {showRingIcon() ? (
          <Image color={ringColor()} size={18} systemName={primaryIcon} />
        ) : (
          <Text
            modifiers={[
              font({ size: 18, weight: 'bold', design: 'rounded' }),
              foregroundStyle(ringTextColor()),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {ringText()}
          </Text>
        )}
      </ZStack>
    );
  }

  function WidgetLockScreenCircularSleeping() {
    return <WidgetLockScreenCircularRing />;
  }

  function WidgetLockScreenCircularBedtimePassed() {
    return <WidgetLockScreenCircularRing />;
  }

  function WidgetLockScreenCircularWindDown() {
    return <WidgetLockScreenCircularRing />;
  }

  function WidgetLockScreenCircularAwake() {
    return <WidgetLockScreenCircularRing />;
  }

  function WidgetLockScreenInlineSleeping() {
    return (
      <ZStack modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), lineLimit(1)]}>
          Sleeping · Bed {formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)} · 100% by {formatClock(props.projectedSleepTimestamp)}
        </Text>
      </ZStack>
    );
  }

  function WidgetLockScreenInlineBedtimePassed() {
    return (
      <ZStack modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), lineLimit(1)]}>
          Past bedtime · Bed Now! · 100% by {formatClock(props.projectedSleepTimestamp)}
        </Text>
      </ZStack>
    );
  }

  function WidgetLockScreenInlineWindDown() {
    return (
      <ZStack modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), lineLimit(1)]}>
          Wind down · Bed {formatClock(props.bedtimeTimestamp)} · Wake {formatClock(props.wakeTimestamp)}
        </Text>
      </ZStack>
    );
  }

  function WidgetLockScreenInlineAwake() {
    return (
      <ZStack modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), lineLimit(1)]}>
          {scoreHeadline} · Bed {formatClock(props.bedtimeTimestamp)} · Wake {formatClock(props.wakeTimestamp)}
        </Text>
      </ZStack>
    );
  }

  function WidgetLockScreenWideSleeping() {
    return (
      <ZStack alignment="topTrailing" modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={8}>
          <Ring size={46} scoreFontSize={21} />
          <VStack alignment="leading" spacing={0}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(sleepCyan), lineLimit(1)]}>
              Sleep in progress
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Bed {formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              100% by {formatClock(props.projectedSleepTimestamp)}
            </Text>
          </VStack>
        </HStack>
      </ZStack>
    );
  }

  function WidgetLockScreenWideBedtimePassed() {
    return (
      <ZStack alignment="topTrailing" modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={8}>
          <Ring size={46} scoreFontSize={21} />
          <VStack alignment="leading" spacing={0}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(sleepCyan), lineLimit(1)]}>
              Bedtime has started
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Bed Now!
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              100% by {formatClock(props.projectedSleepTimestamp)}
            </Text>
          </VStack>
        </HStack>
      </ZStack>
    );
  }

  function WidgetLockScreenWideWindDown() {
    return (
      <ZStack alignment="topTrailing" modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={8}>
          <Ring size={46} scoreFontSize={21} />
          <VStack alignment="leading" spacing={0}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(sleepCyan), lineLimit(1)]}>
              Wind down now
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Bed {formatClock(props.bedtimeTimestamp)}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Wake {formatClock(props.wakeTimestamp)}
            </Text>
          </VStack>
        </HStack>
      </ZStack>
    );
  }

  function WidgetLockScreenWideAwake() {
    return (
      <ZStack alignment="topTrailing" modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={8}>
          <Ring size={46} scoreFontSize={21} />
          <VStack alignment="leading" spacing={0}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(success), lineLimit(1)]}>
              Tonight plan
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Bed {formatClock(props.bedtimeTimestamp)}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Wake {formatClock(props.wakeTimestamp)}
            </Text>
          </VStack>
        </HStack>
      </ZStack>
    );
  }

  function WidgetHomeScreenMediumSleeping() {
    return (
      <ZStack
        alignment="topTrailing"
        modifiers={[
          padding({ all: 4 }),
          widgetURL(homeWidgetURL),
          containerBackground(widgetBackgroundColor, 'widget'),
        ]}>
        <VStack alignment="leading" spacing={6}>
          <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(sleepCyan), lineLimit(1)]}>
            Sleep in progress
          </Text>
          <HStack alignment="center" spacing={14}>
            <VStack alignment="center" spacing={4}>
              <Ring size={88} />
              <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Progress
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={4}>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Sleep started
              </Text>
              <Text
                modifiers={[
                  font({ size: 26, weight: 'bold', design: 'rounded' }),
                  foregroundStyle(sleepWarm),
                  monospacedDigit(),
                  lineLimit(1),
                ]}>
                {formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)}
              </Text>
              <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                100% by {formatClock(props.projectedSleepTimestamp)}
              </Text>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(resolvedSubtle), lineLimit(1)]}>
                Sleep in progress
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

  function WidgetHomeScreenMediumBedtimePassed() {
    return (
      <ZStack
        alignment="topTrailing"
        modifiers={[
          padding({ all: 4 }),
          widgetURL(homeWidgetURL),
          containerBackground(widgetBackgroundColor, 'widget'),
        ]}>
        <VStack alignment="leading" spacing={6}>
          <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(sleepCyan), lineLimit(1)]}>
            Bedtime has started
          </Text>
          <HStack alignment="center" spacing={14}>
            <VStack alignment="center" spacing={4}>
              <Ring size={88} />
              <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Bedtime
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={4}>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Past bedtime
              </Text>
              <Text
                modifiers={[
                  font({ size: 28, weight: 'bold', design: 'rounded' }),
                  foregroundStyle(alert),
                  monospacedDigit(),
                  lineLimit(1),
                ]}>
                Now
              </Text>
              <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                100% by {formatClock(props.projectedSleepTimestamp)}
              </Text>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(resolvedSubtle), lineLimit(1)]}>
                Wake in {formatCountdown(props.wakeTimestamp)}
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

  function WidgetHomeScreenMediumWindDown() {
    return (
      <ZStack
        alignment="topTrailing"
        modifiers={[
          padding({ all: 4 }),
          widgetURL(homeWidgetURL),
          containerBackground(widgetBackgroundColor, 'widget'),
        ]}>
        <VStack alignment="leading" spacing={6}>
          <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(sleepCyan), lineLimit(1)]}>
            Time to wind down
          </Text>
          <HStack alignment="center" spacing={14}>
            <VStack alignment="center" spacing={4}>
              <Ring size={88} />
              <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Wind down
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={4}>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Tonight's bedtime
              </Text>
              <Text
                modifiers={[
                  font({ size: 26, weight: 'bold', design: 'rounded' }),
                  foregroundStyle(primaryColor),
                  monospacedDigit(),
                  lineLimit(1),
                ]}>
                {formatClock(props.bedtimeTimestamp)}
              </Text>
              <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Wake {formatClock(props.wakeTimestamp)}
              </Text>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(resolvedSubtle), lineLimit(1)]}>
                Bedtime in {formatCountdown(props.bedtimeTimestamp)}
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

  function WidgetHomeScreenMediumAwake() {
    return (
      <ZStack
        alignment="topTrailing"
        modifiers={[
          padding({ all: 4 }),
          widgetURL(homeWidgetURL),
          containerBackground(widgetBackgroundColor, 'widget'),
        ]}>
        <VStack alignment="leading" spacing={6}>
          <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(success), lineLimit(1)]}>
            Tonight plan
          </Text>
          <HStack alignment="center" spacing={14}>
            <VStack alignment="center" spacing={4}>
              <Ring size={88} />
              <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Last sleep
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={4}>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Tonight's bedtime
              </Text>
              <Text
                modifiers={[
                  font({ size: 26, weight: 'bold', design: 'rounded' }),
                  foregroundStyle(primaryColor),
                  monospacedDigit(),
                  lineLimit(1),
                ]}>
                {formatClock(props.bedtimeTimestamp)}
              </Text>
              <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                Wake {formatClock(props.wakeTimestamp)}
              </Text>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(resolvedSubtle), lineLimit(1)]}>
                Bedtime in {formatCountdown(props.bedtimeTimestamp)}
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

  function WidgetHomeScreenSmallSleeping() {
    return (
      <ZStack
        alignment="top"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={0} modifiers={[frame({ width: 134 }), padding({ top: 8 })]}>
          <Spacer />
          <BatteryBadge />
        </HStack>

        <VStack alignment="center" spacing={5} modifiers={[frame({ width: 134, height: 154 }), padding({ top: 8 })]}>
          <Ring size={76} />
          <VStack alignment="center" spacing={1}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Sleep in progress
            </Text>
            <Text
              modifiers={[
                font({ size: 22, weight: 'bold', design: 'rounded' }),
                foregroundStyle(sleepWarm),
                monospacedDigit(),
                lineLimit(1),
              ]}>
              {formatClock(props.sleepStartTimestamp || props.bedtimeTimestamp)}
            </Text>
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              100% by {formatClock(props.projectedSleepTimestamp)}
            </Text>
          </VStack>
        </VStack>
      </ZStack>
    );
  }

  function WidgetHomeScreenSmallBedtimePassed() {
    return (
      <ZStack
        alignment="top"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={0} modifiers={[frame({ width: 134 }), padding({ top: 8 })]}>
          <Spacer />
          <BatteryBadge />
        </HStack>

        <VStack alignment="center" spacing={5} modifiers={[frame({ width: 134, height: 154 }), padding({ top: 8 })]}>
          <Ring size={76} />
          <VStack alignment="center" spacing={1}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Bedtime has started
            </Text>
            <Text
              modifiers={[
                font({ size: 22, weight: 'bold', design: 'rounded' }),
                foregroundStyle(alert),
                monospacedDigit(),
                lineLimit(1),
              ]}>
              Now
            </Text>
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              100% by {formatClock(props.projectedSleepTimestamp)}
            </Text>
          </VStack>
        </VStack>
      </ZStack>
    );
  }

  function WidgetHomeScreenSmallWindDown() {
    return (
      <ZStack
        alignment="top"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={0} modifiers={[frame({ width: 134 }), padding({ top: 8 })]}>
          <Spacer />
          <BatteryBadge />
        </HStack>

        <VStack alignment="center" spacing={5} modifiers={[frame({ width: 134, height: 154 }), padding({ top: 8 })]}>
          <Ring size={76} />
          <VStack alignment="center" spacing={1}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Time to wind down
            </Text>
            <Text
              modifiers={[
                font({ size: 22, weight: 'bold', design: 'rounded' }),
                foregroundStyle(primaryColor),
                monospacedDigit(),
                lineLimit(1),
              ]}>
              {formatClock(props.bedtimeTimestamp)}
            </Text>
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Wake {formatClock(props.wakeTimestamp)}
            </Text>
          </VStack>
        </VStack>
      </ZStack>
    );
  }

  function WidgetHomeScreenSmallAwake() {
    return (
      <ZStack
        alignment="top"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={0} modifiers={[frame({ width: 134 }), padding({ top: 8 })]}>
          <Spacer />
          <BatteryBadge />
        </HStack>

        <VStack alignment="center" spacing={5} modifiers={[frame({ width: 134, height: 154 }), padding({ top: 8 })]}>
          <Ring size={76} />
          <VStack alignment="center" spacing={1}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Tonight's bedtime
            </Text>
            <Text
              modifiers={[
                font({ size: 22, weight: 'bold', design: 'rounded' }),
                foregroundStyle(primaryColor),
                monospacedDigit(),
                lineLimit(1),
              ]}>
              {formatClock(props.bedtimeTimestamp)}
            </Text>
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Wake {formatClock(props.wakeTimestamp)}
            </Text>
          </VStack>
        </VStack>
      </ZStack>
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
