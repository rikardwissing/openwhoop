import { act, fireEvent, render, within } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';
import Svg from 'react-native-svg';

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');

  return {
    Ionicons: ({ name, testID }: { name: string; testID?: string }) =>
      React.createElement(Text, { testID }, name),
  };
});

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { HeartSnapshotCard } from '@/components/dashboard/DashboardSnapshotCards';
import {
  buildFocusedHeartMarkerWindow,
  buildHeartDomainAnimation,
  buildHeartAxisLabels,
  buildHeartWindowDomains,
  buildVisibleHeartDomain,
  buildHeartViewportDayLabel,
  buildHeartViewportLabel,
  buildHeartChartViewBox,
  getHeartViewBoxWidth,
  getHeartViewportContentWidth,
  getHeartViewportPointSpacing,
  getHeartViewportZoomScale,
  interpolateHeartDomain,
  getRetainedPointsFromNewestAfterGrowth,
  getVisibleHeartWindowStart,
  PannableHeartChart,
  shouldTriggerHeartLoadMore,
} from '@/components/dashboard/PannableHeartChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { formatAxisTime } from '@/utils/dateTime';

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

function createGestureState(dx: number, dy = 0) {
  return {
    dx,
    dy,
  };
}

describe('chart gesture ownership', () => {
  it('derives stable viewport geometry for the pannable heart chart', () => {
    expect(getHeartViewportPointSpacing(240, 13)).toBe(20);
    expect(getHeartViewportContentWidth(240, 25, 13)).toBe(480);
    expect(getHeartViewBoxWidth(13)).toBe(12);
    expect(getHeartViewportZoomScale(13, 7)).toBe(2);
    expect(
      buildHeartViewportLabel(
        Array.from({ length: 25 }, (_, index) => ({
          label: `${index}`,
          value: 60 + index,
        })),
        13,
      ),
    ).toBe('12 - 24');
    expect(
      buildHeartViewportLabel(
        Array.from({ length: 25 }, (_, index) => ({
          label: `${index}`,
          value: 60 + index,
        })),
        13,
        6,
      ),
    ).toBe('6 - 18');
    expect(
      buildHeartViewportDayLabel(
        Array.from({ length: 25 }, (_, index) => ({
          label: formatAxisTime(new Date(2026, 3, 22, 23, index * 5)),
          value: 60 + index,
        })),
        13,
        '2026-04-23',
      ),
    ).toBe('Apr 23');
    expect(
      buildHeartViewportDayLabel(
        Array.from({ length: 25 }, (_, index) => ({
          label: formatAxisTime(new Date(2026, 3, 22, 23, index * 5)),
          value: 60 + index,
        })),
        13,
        '2026-04-23',
        0,
      ),
    ).toBe('Apr 22');
    expect(
      buildHeartAxisLabels(
        Array.from({ length: 25 }, (_, index) => ({
          label: formatAxisTime(new Date(2026, 3, 22, 23, index * 5)),
          value: 60 + index,
        })),
        13,
        '2026-04-23',
        0,
      )[0],
    ).toBe('Apr 22 · 11 PM');
    expect(buildHeartChartViewBox(6.5, 13)).toBe('6.5 0 12 40');
    expect(
      buildVisibleHeartDomain(
        [
          { label: '0', value: 205 },
          { label: '1', value: 72 },
          { label: '2', value: 74 },
          { label: '3', value: 76 },
          { label: '4', value: 78 },
        ],
        3,
        2,
      )?.max,
    ).toBeLessThan(100);
    expect(
      buildHeartWindowDomains(
        [
          { label: '0', value: 60 },
          { label: '1', value: 70 },
          { label: '2', value: 80 },
          { label: '3', value: 90 },
        ],
        2,
      ),
    ).toEqual({
      mins: [56.5, 66, 75.5],
      maxs: [73.5, 84, 94.5],
    });
    expect(interpolateHeartDomain(1.5, [10, 20, 30], [40, 50, 60])).toEqual({ min: 25, max: 55 });
    expect(
      buildFocusedHeartMarkerWindow(
        {
          startFraction: 0.25,
          endFraction: 0.5,
        },
        120,
        60,
      ),
    ).toEqual({
      startIndex: 29,
      endIndex: 60,
      windowPointCount: 40,
      windowStart: 25,
    });
    expect(
      buildFocusedHeartMarkerWindow(
        {
          startFraction: 0.2,
          endFraction: 0.22,
        },
        120,
        60,
      ),
    ).toEqual({
      startIndex: 23,
      endIndex: 27,
      windowPointCount: 6,
      windowStart: 22,
    });
    const domainAnimation = buildHeartDomainAnimation(
      { min: 50, max: 100 },
      { min: 70, max: 90 },
    );
    expect(domainAnimation.scaleY).toBeCloseTo(2.5);
    expect(domainAnimation.translateY).toBeCloseTo(-20);
    expect(getRetainedPointsFromNewestAfterGrowth(0, 12, 12)).toBe(0);
    expect(getRetainedPointsFromNewestAfterGrowth(5, 12, 24)).toBe(5);
    expect(getVisibleHeartWindowStart(12, 0)).toBe(12);
    expect(getVisibleHeartWindowStart(12, 5)).toBe(7);
  });

  it('only triggers heart-history loading when dragging deeper into the oldest loaded edge', () => {
    expect(
      shouldTriggerHeartLoadMore({
        canLoadMore: true,
        isLoadingMore: false,
        windowStart: 0,
        translationX: 24,
      }),
    ).toBe(true);

    expect(
      shouldTriggerHeartLoadMore({
        canLoadMore: true,
        isLoadingMore: false,
        windowStart: 4,
        translationX: 30,
      }),
    ).toBe(false);

    expect(
      shouldTriggerHeartLoadMore({
        canLoadMore: true,
        isLoadingMore: false,
        windowStart: 1.4,
        translationX: 24,
      }),
    ).toBe(true);

    expect(
      shouldTriggerHeartLoadMore({
        canLoadMore: true,
        isLoadingMore: true,
        windowStart: 0.2,
        translationX: 36,
      }),
    ).toBe(false);
  });

  it('starts the pannable heart chart on the newest visible window labels', () => {
    const screen = render(
      <PannableHeartChart
        chartTestID="heart-chart"
        points={Array.from({ length: 25 }, (_, index) => ({
          label: `${index}`,
          value: 60 + index,
        }))}
        windowPointCount={13}
      />,
    );

    expect(screen.getByTestId('heart-chart-content')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('24')).toBeTruthy();
  });

  it('keeps the newest visible heart window when background history expands', () => {
    const screen = render(
      <PannableHeartChart
        chartTestID="heart-chart"
        points={Array.from({ length: 13 }, (_, index) => ({
          label: `${index}`,
          value: 60 + index,
        }))}
        windowPointCount={13}
      />,
    );

    act(() => {
      screen.rerender(
        <PannableHeartChart
          chartTestID="heart-chart"
          points={Array.from({ length: 25 }, (_, index) => ({
            label: `${index}`,
            value: 60 + index,
          }))}
          windowPointCount={13}
        />,
      );
    });

    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('24')).toBeTruthy();
  });

  it('zooms into a sleep marker window and can return to the latest window', () => {
    const screen = render(
      <PannableHeartChart
        chartTestID="heart-chart"
        jumpToLatestSignal={0}
        markers={[
          {
            id: 'sleep-focus',
            kind: 'sleep',
            label: 'Sleep',
            timeLabel: '1:00 AM - 4:00 AM',
            startFraction: 0.25,
            endFraction: 0.5,
          },
        ]}
        points={Array.from({ length: 120 }, (_, index) => ({
          label: `${index}`,
          value: 60 + (index % 20),
        }))}
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-chart-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    expect(screen.getByText('60')).toBeTruthy();
    expect(screen.getByText('90')).toBeTruthy();
    expect(screen.getByText('119')).toBeTruthy();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-chart-marker-sleep-focus'));
    });

    expect(screen.getByText('25')).toBeTruthy();
    expect(screen.getByText('45')).toBeTruthy();
    expect(screen.getByText('64')).toBeTruthy();

    act(() => {
      screen.rerender(
        <PannableHeartChart
          chartTestID="heart-chart"
          jumpToLatestSignal={1}
          markers={[
            {
              id: 'sleep-focus',
              kind: 'sleep',
              label: 'Sleep',
              timeLabel: '1:00 AM - 4:00 AM',
              startFraction: 0.25,
              endFraction: 0.5,
            },
          ]}
          points={Array.from({ length: 120 }, (_, index) => ({
            label: `${index}`,
            value: 60 + (index % 20),
          }))}
          windowPointCount={60}
        />,
      );
    });

    expect(screen.getByText('60')).toBeTruthy();
    expect(screen.getByText('90')).toBeTruthy();
    expect(screen.getByText('119')).toBeTruthy();
  });

  it('restyles the heart snapshot card while a focused sleep session is active', () => {
    const screen = render(
      <HeartSnapshotCard
        chartTestID="heart-card"
        snapshot={{
          restingHr: 48,
          averageHr: 69,
          maxHr: 131,
          series: Array.from({ length: 120 }, (_, index) => ({
            label: `${index}`,
            value: 58 + (index % 24),
          })),
          markers: [
            {
              id: 'sleep-focus',
              kind: 'sleep',
              label: 'Sleep',
              timeLabel: '1:00 AM - 4:00 AM',
              startFraction: 0.25,
              endFraction: 0.5,
              details: {
                durationMinutes: 180,
                score: 82,
                asleepMinutes: 165,
                timeInBedMinutes: 180,
                remMinutes: 42,
                deepMinutes: 35,
                stages: [
                  { stage: 'light', minutes: 74 },
                  { stage: 'rem', minutes: 42 },
                  { stage: 'deep', minutes: 35 },
                  { stage: 'awake', minutes: 14 },
                ],
              },
            },
          ],
        }}
        trailingLabel="Last 12h"
        windowPointCount={60}
      />,
    );

    expect(screen.getByText('Heart Rate')).toBeTruthy();
    expect(screen.queryByText('Return')).toBeNull();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-marker-sleep-focus'));
    });

    expect(screen.queryByText('Heart Rate')).toBeNull();
    expect(screen.getByTestId('heart-card-marker-sleep-focus')).toBeTruthy();
    expect(screen.getByText('Sleep')).toBeTruthy();
    expect(screen.getByText('Return')).toBeTruthy();
    expect(screen.getByText('Score')).toBeTruthy();
    expect(screen.getByText('Asleep')).toBeTruthy();
    expect(screen.getByText('Efficiency')).toBeTruthy();
    expect(screen.getByText('2:45')).toBeTruthy();
    expect(screen.queryByText('In bed')).toBeNull();
    expect(screen.getByText('Sleep stages')).toBeTruthy();
    expect(screen.getByText('Awake')).toBeTruthy();
    expect(screen.queryByTestId('heart-card-stage-highlight-rem-0')).toBeNull();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-stage-rem'));
    });

    expect(screen.getByTestId('heart-card-stage-highlight-rem-0')).toBeTruthy();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-stage-rem'));
    });

    expect(screen.queryByTestId('heart-card-stage-highlight-rem-0')).toBeNull();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-return-button'));
    });

    expect(screen.getByText('Heart Rate')).toBeTruthy();
    expect(screen.getByTestId('heart-card-marker-sleep-focus')).toBeTruthy();
    expect(screen.queryByText('Return')).toBeNull();
  });

  it('renders interval markers on trend charts', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        markers={[
          {
            id: 'sleep-session',
            iconName: 'moon',
            accentColor: '#5d78ff',
            backgroundColor: 'rgba(93, 120, 255, 0.14)',
            startFraction: 0,
            endFraction: 0.32,
          },
          {
            id: 'tempo-run',
            iconName: 'walk',
            accentColor: '#ffd26b',
            backgroundColor: 'rgba(255, 210, 107, 0.14)',
            startFraction: 0.4,
            endFraction: 0.48,
          },
        ]}
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: 76 },
          { label: 'Wed', value: 74 },
        ]}
        testID="trend-chart"
      />,
    );

    const sleepMarker = screen.getByTestId('trend-chart-marker-sleep-session');
    const activityMarker = screen.getByTestId('trend-chart-marker-tempo-run');

    expect(sleepMarker).toBeTruthy();
    expect(activityMarker).toBeTruthy();
    expect(StyleSheet.flatten(sleepMarker.props.style)?.top).toBe(
      StyleSheet.flatten(activityMarker.props.style)?.top,
    );
  });

  it('renders daily aggregate series as rounded bars when bar mode is enabled', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        mode="bar"
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: 76 },
          { label: 'Wed', value: 74 },
        ]}
        testID="trend-chart"
      />,
    );

    expect(screen.getByTestId('trend-chart-bar-0')).toBeTruthy();
    expect(screen.getByTestId('trend-chart-bar-1')).toBeTruthy();
    expect(screen.getByTestId('trend-chart-bar-2')).toBeTruthy();
  });

  it('keeps the last bar gap consistent with the preceding bars', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        mode="bar"
        points={Array.from({ length: 14 }, (_, index) => ({
          label: `${index}`,
          value: 60 + index,
        }))}
        testID="trend-chart"
      />,
    );

    const bar10 = screen.getByTestId('trend-chart-bar-10');
    const bar11 = screen.getByTestId('trend-chart-bar-11');
    const bar12 = screen.getByTestId('trend-chart-bar-12');
    const bar13 = screen.getByTestId('trend-chart-bar-13');
    const gapBeforeLast = Number(bar13.props.x) - (Number(bar12.props.x) + Number(bar12.props.width));
    const priorGap = Number(bar11.props.x) - (Number(bar10.props.x) + Number(bar10.props.width));

    expect(Math.abs(gapBeforeLast - priorGap)).toBeLessThan(0.01);
  });

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

  it('shows a visible scrub readout while inspecting trend values', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: 76 },
          { label: 'Wed', value: 74 },
        ]}
        selectionValueFormatter={(selection) =>
          selection.point.value === null ? 'No data' : `${selection.point.value} bpm`
        }
        testID="trend-chart"
      />,
    );

    const viewport = screen.getByTestId('trend-chart-viewport');
    const overlay = screen.getByTestId('trend-chart');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 120, height: 148 } } });
    });

    act(() => {
      overlay.props.onResponderGrant?.(createResponderEvent(60, true));
    });

    const bubble = screen.getByTestId('trend-chart-selection-bubble');

    expect(bubble).toBeTruthy();
    expect(within(bubble).getByText('Tue')).toBeTruthy();
    expect(within(bubble).getByText('76 bpm')).toBeTruthy();
  });

  it('reports horizontal drags on the trend chart axis row', () => {
    const onAxisPan = jest.fn();
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        axisTestID="trend-chart-axis"
        onAxisPan={onAxisPan}
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: 76 },
          { label: 'Wed', value: 74 },
        ]}
        testID="trend-chart-overlay"
      />,
    );

    const axis = screen.getByTestId('trend-chart-axis');
    expect(axis.props.onStartShouldSetResponder?.()).toBe(true);
    expect(axis.props.onStartShouldSetResponderCapture?.(createResponderEvent(20, true))).toBe(true);

    act(() => {
      axis.props.onResponderGrant?.(createResponderEvent(20, true), createGestureState(0));
      axis.props.onResponderRelease?.(createResponderEvent(8, false), createGestureState(-48));
    });

    expect(onAxisPan).toHaveBeenNthCalledWith(1, { phase: 'start', dx: 0 });
    expect(onAxisPan).toHaveBeenNthCalledWith(2, { phase: 'end', dx: 0 });
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

  it('shows a visible scrub readout while inspecting sleep stages', () => {
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

    const viewport = screen.getByTestId('sleep-stage-chart-viewport');
    const overlay = screen.getByTestId('sleep-stage-chart');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 120, height: 40 } } });
    });

    act(() => {
      overlay.props.onResponderGrant?.(createResponderEvent(60, true));
    });

    const bubble = screen.getByTestId('sleep-stage-chart-selection-bubble');

    expect(bubble).toBeTruthy();
    expect(within(bubble).getByText('Deep sleep')).toBeTruthy();
    expect(within(bubble).getByText('1h 20m')).toBeTruthy();
  });

  it('shows a visible scrub readout while inspecting heart history', () => {
    const screen = render(
      <PannableHeartChart
        chartTestID="heart-chart"
        points={Array.from({ length: 25 }, (_, index) => ({
          label: `${index}`,
          value: 60 + index,
        }))}
        windowPointCount={13}
      />,
    );

    const viewport = screen.getByTestId('heart-chart-viewport');
    const overlay = screen.getByTestId('heart-chart');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 120, height: 150 } } });
    });

    act(() => {
      overlay.props.onResponderGrant?.(createResponderEvent(60, true));
    });

    const bubble = screen.getByTestId('heart-chart-selection-bubble');

    expect(bubble).toBeTruthy();
    expect(within(bubble).getByText('18')).toBeTruthy();
    expect(within(bubble).getByText('78 BPM')).toBeTruthy();
  });
});
