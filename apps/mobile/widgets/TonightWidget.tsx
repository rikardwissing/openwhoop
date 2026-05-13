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

export interface TonightWidgetProps {
  alarmStatusLabel?: string;
  batteryCharging?: boolean;
  batteryLabel?: string;
  bedtimeLabel?: string;
  bedtimeTimestamp?: number;
  bedtimePassed?: boolean;
  greetingLabel?: string;
  phaseLabel?: string;
  projectedSleepLabel?: string;
  progress?: number;
  score?: number | null;
  scoreLabel?: string;
  sleepDebtLabel?: string;
  sleepInProgress?: boolean;
  sleepNeedLabel?: string;
  sleepProgress?: number;
  sleepStartTimestamp?: number;
  sleepThemeActive?: boolean;
  sleepThemeLabel?: string;
  updatedAtLabel?: string;
  wakeLabel?: string;
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
    progress: Math.max(0, Math.min(1, rawProps.progress ?? defaultProps.progress)),
    sleepProgress: Math.max(0, Math.min(1, rawProps.sleepProgress ?? defaultProps.sleepProgress)),
    score:
      rawProps.score === null || rawProps.score === undefined
        ? defaultProps.score
        : Math.max(0, Math.min(100, rawProps.score)),
  };

  const homeBatteryLabel = (() => {
    const value = rawProps.batteryLabel?.trim();
    if (value) {
      return value;
    }
    return props.batteryLabel;
  })();

  const batteryPercent = (() => {
    const parsed = Number.parseInt(homeBatteryLabel, 10);
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

  const accessoryFamily = environment.widgetFamily.startsWith('accessory');
  const widgetBackgroundColor = props.sleepThemeActive ? sleepWidgetBackground : widgetBackground;
  const resolvedText = props.sleepThemeActive ? sleepText : text;
  const resolvedSecondary = props.sleepThemeActive ? sleepSecondary : secondary;
  const resolvedSubtle = props.sleepThemeActive ? sleepSubtle : subtle;
  const primaryColor = accessoryFamily ? { type: 'hierarchical' as const, style: 'primary' as const } : resolvedText;
  const secondaryColor = accessoryFamily ? { type: 'hierarchical' as const, style: 'secondary' as const } : resolvedSecondary;
  const scoreValue = props.score === null ? 0 : Math.round(props.score);
  const scoreText = props.score === null ? '--' : `${scoreValue}`;
  const windDownActive = props.sleepThemeActive && props.sleepThemeLabel === 'Time to wind down';
  const plannedSleepProgressValue = Math.max(6, Math.min(96, Math.round(props.progress * 100)));
  const sleepProgressValue = Math.max(6, Math.min(96, Math.round(props.sleepProgress * 100)));
  const projectedSleepActive = props.sleepInProgress;
  const postBedtimeActive = props.bedtimePassed && !props.sleepInProgress;
  const ringValue = projectedSleepActive
    ? sleepProgressValue
    : postBedtimeActive
      ? plannedSleepProgressValue
      : windDownActive
        ? 0
        : scoreValue;
  const ringText = projectedSleepActive ? `${ringValue}` : scoreText;
  const scoreHeadline = projectedSleepActive
    ? `Sleep ${ringValue}`
    : props.score === null
      ? 'Sleep --'
      : `Sleep ${scoreText}`;
  const scoreRingColor =
    props.score === null ? accent : props.score >= 80 ? success : props.score >= 65 ? caution : alert;
  const ringColor = projectedSleepActive
    ? sleepAccent
    : windDownActive
      ? sleepCyan
      : postBedtimeActive || props.sleepThemeActive
        ? sleepWarm
        : scoreRingColor;
  const scoreTextColor =
    props.score === null
      ? resolvedText
      : props.score >= 80
        ? '#f5fff8'
        : props.score >= 65
          ? '#fff8ee'
          : '#fff3f1';
  const ringTextColor = props.sleepThemeActive ? resolvedText : scoreTextColor;
  const bedtimeColor = props.sleepInProgress ? sleepWarm : props.bedtimePassed ? alert : primaryColor;
  const bedtimeTitle = props.sleepInProgress ? 'Sleep started' : props.bedtimePassed ? 'Past bedtime' : "Tonight's bedtime";
  const bedtimeValue = props.bedtimePassed ? 'Now' : props.bedtimeLabel;
  const wakeTitle = props.sleepInProgress || props.bedtimePassed ? '100% by' : 'Wake';
  const wakeValue = props.sleepInProgress || props.bedtimePassed ? props.projectedSleepLabel : props.wakeLabel;
  const lockscreenBedtimeValue = props.bedtimePassed ? `${bedtimeValue}!` : bedtimeValue;
  const greetingColor = props.sleepThemeActive ? sleepCyan : success;
  const inlineLead = projectedSleepActive ? scoreHeadline : postBedtimeActive ? 'Past bedtime' : windDownActive ? 'Wind down' : scoreHeadline;
  const lockscreenThemeLabel = windDownActive ? 'Wind down now' : props.sleepThemeLabel;
  const smallBedtimeTitle = props.sleepThemeActive ? props.sleepThemeLabel : bedtimeTitle;
  const showSleepThemeIcon = props.sleepThemeActive && !projectedSleepActive;
  const homeWidgetURL = 'btwearable://';

  function Metric({ label, value }: { label: string; value: string }) {
    return (
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
          {label}
        </Text>
        <Text
          modifiers={[
            font({ size: 18, weight: 'bold', design: 'rounded' }),
            foregroundStyle(primaryColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {value}
        </Text>
      </VStack>
    );
  }

  function ScoreRing({ size, scoreFontSize }: { size: number; scoreFontSize?: number }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={ringValue}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ringColor), frame({ width: size, height: size })]}
        />

        {showSleepThemeIcon ? (
          <Image color={ringColor} size={size >= 88 ? 26 : size >= 74 ? 26 : 20} systemName="moon.zzz.fill" />
        ) : (
          <Text
            modifiers={[
              font({
                size: scoreFontSize ?? (size >= 88 ? 26 : size >= 74 ? 23 : 18),
                weight: 'bold',
                design: 'rounded',
              }),
              foregroundStyle(ringTextColor),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {ringText}
          </Text>
        )}
      </ZStack>
    );
  }

  function BatteryBadge() {
    const batteryIconColor = props.batteryCharging ? success : resolvedSecondary;
    const batteryTextColor = props.batteryCharging ? success : secondaryColor;

    return (
      <HStack alignment="center" spacing={3}>
        <Image color={batteryIconColor} size={11} systemName={batterySymbol} />
        <Text
          modifiers={[
            font({ size: 10, weight: 'semibold' }),
            foregroundStyle(batteryTextColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {homeBatteryLabel}
        </Text>
      </HStack>
    );
  }

  if (environment.widgetFamily === 'accessoryCircular') {
    return (
      <ZStack
        alignment="center"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Gauge
          value={ringValue}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(ringColor)]}
        />

        {showSleepThemeIcon ? (
          <Image color={ringColor} size={18} systemName="moon.zzz.fill" />
        ) : (
          <Text
            modifiers={[
              font({ size: 18, weight: 'bold', design: 'rounded' }),
              foregroundStyle(ringTextColor),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {ringText}
          </Text>
        )}
      </ZStack>
    );
  }

  if (environment.widgetFamily === 'accessoryInline') {
    return (
      <ZStack modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), lineLimit(1)]}>
          {inlineLead} · Bed {lockscreenBedtimeValue} · {wakeTitle} {wakeValue}
        </Text>
      </ZStack>
    );
  }

  if (environment.widgetFamily === 'accessoryRectangular') {
    return (
      <ZStack
        alignment="topTrailing"
        modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <HStack alignment="center" spacing={8}>
          <ScoreRing size={46} scoreFontSize={21} />

          <VStack alignment="leading" spacing={0}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(greetingColor), lineLimit(1)]}>
              {props.sleepThemeActive ? lockscreenThemeLabel : props.greetingLabel}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Bed {lockscreenBedtimeValue}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              {wakeTitle} {wakeValue}
            </Text>
          </VStack>
        </HStack>
      </ZStack>
    );
  }

  if (environment.widgetFamily === 'systemMedium') {
    return (
      <ZStack
        alignment="topTrailing"
        modifiers={[padding({ all: 4 }), widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
        <VStack alignment="leading" spacing={6}>
          <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(greetingColor), lineLimit(1)]}>
            {props.sleepThemeActive ? props.sleepThemeLabel : props.greetingLabel}
          </Text>
          <HStack alignment="center" spacing={14}>
            <VStack alignment="center" spacing={4}>
              <ScoreRing size={88} />
              <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                {projectedSleepActive ? 'Progress' : postBedtimeActive ? 'Bedtime' : props.sleepThemeActive ? 'Wind down' : 'Last sleep'}
              </Text>
            </VStack>

            <VStack alignment="leading" spacing={4}>
              <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                {bedtimeTitle}
              </Text>
              <Text
                modifiers={[
                  font({ size: 28, weight: 'bold', design: 'rounded' }),
                  foregroundStyle(bedtimeColor),
                  monospacedDigit(),
                  lineLimit(1),
                ]}>
                {bedtimeValue}
              </Text>
              <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
                {wakeTitle} {wakeValue}
              </Text>
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(resolvedSubtle), lineLimit(1)]}>
                {props.phaseLabel}
              </Text>
            </VStack>

            <Spacer />
            <VStack alignment="leading" spacing={2}>
              <Metric label="Sleep need" value={props.sleepNeedLabel} />
              <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(resolvedSubtle), lineLimit(1)]}>
                {props.sleepDebtLabel}
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

  return (
    <ZStack
      alignment="top"
      modifiers={[widgetURL(homeWidgetURL), containerBackground(widgetBackgroundColor, 'widget')]}>
      <HStack
        alignment="center"
        spacing={0}
        modifiers={[frame({ width: 134 }), padding({ top: 8 })]}>
        <Spacer />
        <BatteryBadge />
      </HStack>

      <VStack alignment="center" spacing={5} modifiers={[frame({ width: 134, height: 154 }), padding({ top: 8 })]}>
        <ScoreRing size={76} />

        <VStack alignment="center" spacing={1}>
          <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
            {smallBedtimeTitle}
          </Text>
          <Text
            modifiers={[
              font({ size: 22, weight: 'bold', design: 'rounded' }),
              foregroundStyle(bedtimeColor),
              monospacedDigit(),
              lineLimit(1),
            ]}>
            {bedtimeValue}
          </Text>
          <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
            {wakeTitle} {wakeValue}
          </Text>
        </VStack>
      </VStack>
    </ZStack>
  );
};

export default createWidget<TonightWidgetProps>('SleepWidgetV2', TonightWidgetComponent);
