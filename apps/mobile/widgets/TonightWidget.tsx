import { Gauge, HStack, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
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
  bedtimeLabel?: string;
  phaseLabel?: string;
  progress?: number;
  score?: number | null;
  scoreLabel?: string;
  sleepDebtLabel?: string;
  sleepNeedLabel?: string;
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
  const defaultProps: Required<TonightWidgetProps> = {
    alarmStatusLabel: 'Open Unstrap',
    bedtimeLabel: '--',
    phaseLabel: 'Tonight plan',
    progress: 0,
    score: null,
    scoreLabel: 'Waiting for sleep',
    sleepDebtLabel: 'Sync to update',
    sleepNeedLabel: 'Need --',
    updatedAtLabel: '--',
    wakeLabel: '--',
  };

  const props: Required<TonightWidgetProps> = {
    ...defaultProps,
    ...rawProps,
    progress: Math.max(0, Math.min(1, rawProps.progress ?? defaultProps.progress)),
    score:
      rawProps.score === null || rawProps.score === undefined
        ? defaultProps.score
        : Math.max(0, Math.min(100, rawProps.score)),
  };

  const accessoryFamily = environment.widgetFamily.startsWith('accessory');
  const primaryColor = accessoryFamily ? { type: 'hierarchical' as const, style: 'primary' as const } : text;
  const secondaryColor = accessoryFamily ? { type: 'hierarchical' as const, style: 'secondary' as const } : secondary;
  const scoreValue = props.score === null ? 0 : Math.round(props.score);
  const scoreText = props.score === null ? '--' : `${scoreValue}`;
  const scoreHeadline = props.score === null ? 'Sleep --' : `Sleep ${scoreText}%`;
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

  function ScoreRing({ size }: { size: number }) {
    return (
      <ZStack alignment="center" modifiers={[frame({ width: size, height: size })]}>
        <Gauge
          value={scoreValue}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(scoreRingColor), frame({ width: size, height: size })]}
        />

        <Text
          modifiers={[
            font({ size: size >= 88 ? 26 : size >= 74 ? 23 : 18, weight: 'bold', design: 'rounded' }),
            foregroundStyle(scoreTextColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {scoreText}
        </Text>
      </ZStack>
    );
  }

  if (environment.widgetFamily === 'accessoryCircular') {
    return (
      <ZStack alignment="center" modifiers={[widgetURL('btwearable://sleep')]}> 
        <Gauge
          value={scoreValue}
          min={0}
          max={100}
          modifiers={[gaugeStyle('circularCapacity'), tint(scoreRingColor)]}
        />

        <Text
          modifiers={[
            font({ size: 18, weight: 'bold', design: 'rounded' }),
            foregroundStyle(scoreTextColor),
            monospacedDigit(),
            lineLimit(1),
          ]}>
          {scoreText}
        </Text>
      </ZStack>
    );
  }

  if (environment.widgetFamily === 'accessoryInline') {
    return (
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), lineLimit(1)]}>
        {scoreHeadline} · Bed {props.bedtimeLabel}
      </Text>
    );
  }

  if (environment.widgetFamily === 'accessoryRectangular') {
    return (
      <VStack alignment="leading" spacing={2} modifiers={[widgetURL('btwearable://sleep')]}> 
        <Text modifiers={[font({ size: 13, weight: 'bold' }), foregroundStyle(primaryColor), lineLimit(1)]}>
          {scoreHeadline} · Bed {props.bedtimeLabel}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
          {props.scoreLabel} · Wake {props.wakeLabel}
        </Text>
      </VStack>
    );
  }

  if (environment.widgetFamily === 'systemMedium') {
    return (
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[padding({ all: 4 }), widgetURL('btwearable://sleep'), containerBackground(widgetBackground, 'widget')]}> 
        <HStack alignment="center" spacing={14}>
          <VStack alignment="center" spacing={4}>
            <ScoreRing size={88} />
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Last sleep
            </Text>
          </VStack>

          <VStack alignment="leading" spacing={4}>
            <Text modifiers={[font({ size: 10, weight: 'semibold' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Tonight's bedtime
            </Text>
            <Text
              modifiers={[
                font({ size: 28, weight: 'bold', design: 'rounded' }),
                foregroundStyle(primaryColor),
                monospacedDigit(),
                lineLimit(1),
              ]}>
              {props.bedtimeLabel}
            </Text>
            <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
              Wake {props.wakeLabel}
            </Text>
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
              {props.phaseLabel}
            </Text>
          </VStack>

          <Spacer />
          <VStack alignment="leading" spacing={2}>
            <Metric label="Sleep need" value={props.sleepNeedLabel} />
            <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
              {props.sleepDebtLabel}
            </Text>
          </VStack>
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack
      alignment="center"
      spacing={5}
      modifiers={[padding({ all: 4 }), widgetURL('btwearable://sleep'), containerBackground(widgetBackground, 'widget')]}> 
      <ScoreRing size={76} />

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
          {props.bedtimeLabel}
        </Text>
        <Text modifiers={[font({ size: 11, weight: 'medium' }), foregroundStyle(secondaryColor), lineLimit(1)]}>
          Wake {props.wakeLabel}
        </Text>
      </VStack>
    </VStack>
  );
};

export default createWidget<TonightWidgetProps>('TonightWidget', TonightWidgetComponent);
