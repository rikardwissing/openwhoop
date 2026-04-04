import { act, render } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
import Svg from 'react-native-svg';

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';

function getScrollView(screen: ReturnType<typeof render>) {
  return screen.UNSAFE_getByType(ScrollView);
}

function createResponderEvent(locationX: number, isActive: boolean) {
  return {
    nativeEvent: {
      changedTouches: [],
      identifier: 0,
      locationX,
      locationY: 0,
      pageX: locationX,
      pageY: 0,
      target: 0,
      timestamp: 0,
      touches: [],
    },
    touchHistory: {
      indexOfSingleActiveTouch: isActive ? 0 : -1,
      mostRecentTimeStamp: 0,
      numberActiveTouches: isActive ? 1 : 0,
      touchBank: [
        {
          currentPageX: locationX,
          currentPageY: 0,
          currentTimeStamp: 0,
          previousPageX: locationX,
          previousPageY: 0,
          previousTimeStamp: 0,
          startPageX: locationX,
          startPageY: 0,
          startTimeStamp: 0,
          touchActive: isActive,
        },
      ],
    },
  };
}

describe('chart gesture ownership', () => {
  it('keeps trend scrubbing attached to the chart', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: 76 },
          { label: 'Wed', value: 74 },
        ]}
        testID="trend-chart-overlay"
      />,
    );

    const overlay = screen.getByTestId('trend-chart-overlay');
    expect(overlay.props.onResponderTerminationRequest()).toBe(false);
  });

  it('disables parent scrolling while trend scrubbing is active', () => {
    const screen = render(
      <ScreenShell>
        <TrendChart
          accentColor="#00ffff"
          points={[
            { label: 'Mon', value: 72 },
            { label: 'Tue', value: 76 },
            { label: 'Wed', value: 74 },
          ]}
          testID="trend-chart-overlay"
        />
      </ScreenShell>,
    );

    const overlay = screen.getByTestId('trend-chart-overlay');
    expect(getScrollView(screen).props.scrollEnabled).toBe(true);

    act(() => {
      overlay.props.onResponderGrant?.(createResponderEvent(24, true));
    });

    expect(getScrollView(screen).props.scrollEnabled).toBe(false);

    act(() => {
      overlay.props.onResponderRelease?.(createResponderEvent(24, false));
    });

    expect(getScrollView(screen).props.scrollEnabled).toBe(true);
  });

  it('keeps sleep-stage scrubbing attached to the chart', () => {
    const screen = render(
      <SleepStageChart
        endLabel="7:30 AM"
        middleLabel="3:00 AM"
        segments={[
          { stage: 'light', minutes: 120 },
          { stage: 'deep', minutes: 80 },
          { stage: 'rem', minutes: 95 },
        ]}
        startLabel="11:15 PM"
        testID="sleep-stage-chart-overlay"
      />,
    );

    const overlay = screen.getByTestId('sleep-stage-chart-overlay');
    expect(overlay.props.onResponderTerminationRequest()).toBe(false);
  });

  it('renders sleep stages as a uniform segmented bar with distinct deep and light colors', () => {
    const screen = render(
      <SleepStageChart
        endLabel="7:30 AM"
        middleLabel="3:00 AM"
        segments={[
          { stage: 'light', minutes: 120 },
          { stage: 'deep', minutes: 80 },
          { stage: 'rem', minutes: 95 },
        ]}
        startLabel="11:15 PM"
        testID="sleep-stage-chart"
      />,
    );

    const lightSegment = screen.getByTestId('sleep-stage-chart-segment-0');
    const deepSegment = screen.getByTestId('sleep-stage-chart-segment-1');
    const remSegment = screen.getByTestId('sleep-stage-chart-segment-2');
    const svg = screen.UNSAFE_getByType(Svg);

    expect(lightSegment.props.height).toBe(deepSegment.props.height);
    expect(deepSegment.props.height).toBe(remSegment.props.height);
    expect(lightSegment.props.fill).not.toEqual(deepSegment.props.fill);
    expect(svg.props.preserveAspectRatio).toBe('none');
  });

  it('disables parent scrolling while sleep-stage scrubbing is active', () => {
    const screen = render(
      <ScreenShell>
        <SleepStageChart
          endLabel="7:30 AM"
          middleLabel="3:00 AM"
          segments={[
            { stage: 'light', minutes: 120 },
            { stage: 'deep', minutes: 80 },
            { stage: 'rem', minutes: 95 },
          ]}
          startLabel="11:15 PM"
          testID="sleep-stage-chart-overlay"
        />
      </ScreenShell>,
    );

    const overlay = screen.getByTestId('sleep-stage-chart-overlay');
    expect(getScrollView(screen).props.scrollEnabled).toBe(true);

    act(() => {
      overlay.props.onResponderGrant?.(createResponderEvent(30, true));
    });

    expect(getScrollView(screen).props.scrollEnabled).toBe(false);

    act(() => {
      overlay.props.onResponderRelease?.(createResponderEvent(30, false));
    });

    expect(getScrollView(screen).props.scrollEnabled).toBe(true);
  });
});
