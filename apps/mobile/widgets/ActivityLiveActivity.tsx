import { HStack, Image, Link, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  background,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';

export interface ActivityLiveActivityProps {
  activityId?: string;
  activityName?: string;
  liveHeartRate?: number | null;
  startTimestamp?: number;
  stopUrl?: string;
}

const ActivityLiveActivityComponent = (rawProps: ActivityLiveActivityProps) => {
  'widget';

  const accent = '#FF6B7A';
  const cyan = '#6DE7F2';
  const success = '#8DFFB3';
  const text = '#F8F4FF';
  const subtle = '#9793B8';
  const stopBackground = '#30151B';
  const startTimestamp = rawProps.startTimestamp && rawProps.startTimestamp > 0
    ? rawProps.startTimestamp
    : Date.now();
  const startDate = new Date(startTimestamp);
  const activityName = rawProps.activityName ?? 'Running';
  const liveHeartRate = rawProps.liveHeartRate ?? null;
  const stopUrl = rawProps.stopUrl ?? 'btwearable://activity-stop?source=live-activity';

  function heartRateLabel() {
    if (liveHeartRate === null) {
      return '-- bpm';
    }

    return `${Math.round(liveHeartRate)} bpm`;
  }

  function ActivityIcon({ color, size }: { color: string; size: number }) {
    return <Image color={color} size={size} systemName="figure.run" />;
  }

  function ElapsedTimer({ color, size }: { color: string; size: number }) {
    return (
      <Text
        date={startDate}
        dateStyle="timer"
        modifiers={[
          font({ size, weight: 'bold', design: 'rounded' }),
          foregroundStyle(color),
          monospacedDigit(),
          lineLimit(1),
        ]}
      />
    );
  }

  function StopLink() {
    return (
      <Link
        destination={stopUrl}
        label="Stop"
        modifiers={[
          background(stopBackground),
          cornerRadius(13),
          font({ size: 13, weight: 'bold' }),
          foregroundStyle(accent),
          padding({ horizontal: 12, vertical: 7 }),
        ]}
      />
    );
  }

  function Banner() {
    return (
      <HStack alignment="center" spacing={12} modifiers={[padding({ all: 14 })]}>
        <ZStack alignment="center" modifiers={[frame({ width: 50, height: 50 })]}>
          <ActivityIcon color={accent} size={28} />
        </ZStack>
        <VStack alignment="leading" spacing={3}>
          <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
            {activityName} in progress
          </Text>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(cyan), monospacedDigit(), lineLimit(1)]}>
            {heartRateLabel()}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
            Live activity
          </Text>
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={7}>
          <ElapsedTimer color={success} size={20} />
          <StopLink />
        </VStack>
      </HStack>
    );
  }

  function BannerSmall() {
    return (
      <HStack alignment="center" spacing={8} modifiers={[padding({ all: 10 })]}>
        <ActivityIcon color={accent} size={15} />
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
          {activityName} in progress
        </Text>
        <Spacer />
        <ElapsedTimer color={success} size={13} />
      </HStack>
    );
  }

  function ExpandedLeading() {
    return (
      <VStack alignment="leading" spacing={4}>
        <Spacer />
        <ActivityIcon color={accent} size={34} />
        <Spacer />
      </VStack>
    );
  }

  function ExpandedCenter() {
    return (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(text), lineLimit(1)]}>
          {activityName} in progress
        </Text>
        <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(cyan), lineLimit(1)]}>
          {heartRateLabel()}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'medium' }), foregroundStyle(subtle), lineLimit(1)]}>
          Stop opens Unstrap
        </Text>
      </VStack>
    );
  }

  function ExpandedTrailing() {
    return (
      <VStack alignment="trailing" spacing={7}>
        <Spacer />
        <ElapsedTimer color={success} size={24} />
        <StopLink />
        <Spacer />
      </VStack>
    );
  }

  return {
    banner: <Banner />,
    bannerSmall: <BannerSmall />,
    compactLeading: <ActivityIcon color={accent} size={16} />,
    compactTrailing: <ElapsedTimer color={success} size={14} />,
    minimal: <ActivityIcon color={accent} size={15} />,
    expandedLeading: <ExpandedLeading />,
    expandedCenter: <ExpandedCenter />,
    expandedTrailing: <ExpandedTrailing />,
  };
};

export default createLiveActivity<ActivityLiveActivityProps>('ActivityLiveActivityV1', ActivityLiveActivityComponent);
