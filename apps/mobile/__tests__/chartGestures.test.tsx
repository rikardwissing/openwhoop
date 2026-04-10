import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { ScrollView, StyleSheet, processColor } from 'react-native';
import Svg, { Stop } from 'react-native-svg';

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
  buildHeartSleepStageSelectionRanges,
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
import { colors } from '@/constants/theme';
import { formatAxisTime } from '@/utils/dateTime';

function getScrollView(screen: ReturnType<typeof render>) {
  return screen.UNSAFE_getByType(ScrollView);
}

function normalizeSvgColor(value: unknown) {
  return typeof value === 'object' && value !== null && 'payload' in value
    ? (value as { payload: number }).payload
    : value;
}

function createResponderEvent(locationX: number, isActive: boolean, startPageX = locationX) {
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
          startPageX,
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
      windowPointCount: 32,
      windowStart: 29,
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
      windowPointCount: 5,
      windowStart: 23,
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

  it('zooms into a sleep marker window and can return to the latest window', async () => {
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

    expect(screen.getByText('29')).toBeTruthy();
    expect(screen.getByText('45')).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();

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

    await waitFor(() => {
      expect(screen.getByText('60')).toBeTruthy();
      expect(screen.getByText('90')).toBeTruthy();
      expect(screen.getByText('119')).toBeTruthy();
    });
  });

  it('restyles the heart snapshot card while a focused sleep session is active', async () => {
    const sleepMarker = {
      id: 'sleep-focus',
      kind: 'sleep' as const,
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
          { stage: 'light' as const, minutes: 74 },
          { stage: 'rem' as const, minutes: 42 },
          { stage: 'deep' as const, minutes: 35 },
          { stage: 'awake' as const, minutes: 14 },
        ],
      },
    };
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
          markers: [sleepMarker],
        }}
        trailingLabel="Last 12h"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-card-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    expect(screen.getByText('Heart Rate')).toBeTruthy();
    expect(screen.queryByText('Return')).toBeNull();
    expect(screen.UNSAFE_getAllByType(Stop).some((stop) => stop.props.stopColor === colors.indigo)).toBe(false);

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-marker-sleep-focus'));
    });

    expect(screen.getByText('29')).toBeTruthy();
    expect(screen.getByTestId('heart-card-marker-sleep-focus')).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();
    await waitFor(() =>
      expect(screen.UNSAFE_getAllByType(Stop).some((stop) => stop.props.stopColor === colors.indigo)).toBe(true),
    );
    await waitFor(() => expect(screen.getByText('Return')).toBeTruthy());
    expect(screen.getByText('Score')).toBeTruthy();
    expect(screen.getByText('Asleep')).toBeTruthy();
    expect(screen.getByText('Efficiency')).toBeTruthy();
    expect(screen.getByText('2:45')).toBeTruthy();
    expect(screen.queryByText('In bed')).toBeNull();
    await waitFor(() => expect(screen.getByText('Awake')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('heart-card-stage-rem')).toBeTruthy());
    expect(screen.queryByTestId('heart-card-stage-highlight-rem-0')).toBeNull();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-stage-rem'));
    });

    expect(screen.getByTestId('heart-card-stage-highlight-rem-0')).toBeTruthy();

    const overlay = screen.getByTestId('heart-card');
    const focusedWindow = buildFocusedHeartMarkerWindow(sleepMarker, 120, 60)!;
    const remRange = buildHeartSleepStageSelectionRanges(120, sleepMarker, 'rem')[0]!;
    const pointSpacing = 240 / Math.max(focusedWindow.windowPointCount - 1, 1);
    const remMidIndex = Math.round((remRange.startIndex + remRange.endIndex) / 2);
    const remTouchX = (remMidIndex - focusedWindow.windowStart) * pointSpacing;
    const outsideTouchX = (focusedWindow.windowStart + 2 - focusedWindow.windowStart) * pointSpacing;

    act(() => {
      overlay.props.onResponderGrant?.(createResponderEvent(outsideTouchX, true));
    });

    expect(screen.queryByTestId('heart-card-selection-bubble')).toBeNull();

    act(() => {
      overlay.props.onResponderGrant?.(createResponderEvent(remTouchX, true));
    });

    const bubble = screen.getByTestId('heart-card-selection-bubble');

    expect(bubble).toBeTruthy();
    expect(within(bubble).getByText(`${remMidIndex}`)).toBeTruthy();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-stage-rem'));
    });

    expect(screen.queryByTestId('heart-card-stage-highlight-rem-0')).toBeNull();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-card-return-button'));
    });

    await waitFor(() => expect(screen.queryByText('Return')).toBeNull(), { timeout: 2500 });
    expect(screen.getByText('Heart Rate')).toBeTruthy();
    expect(screen.getByTestId('heart-card-marker-sleep-focus')).toBeTruthy();
  });

  it('keeps the focused activity gradient warm without the green primary stop', async () => {
    const screen = render(
      <HeartSnapshotCard
        chartTestID="heart-activity-card"
        snapshot={{
          restingHr: 49,
          averageHr: 71,
          maxHr: 133,
          series: Array.from({ length: 120 }, (_, index) => ({
            label: `${index}`,
            value: 57 + (index % 26),
          })),
          markers: [
            {
              id: 'workout-session',
              kind: 'activity',
              label: 'Workout',
              timeLabel: '12:10 - 1:10',
              startFraction: 0.42,
              endFraction: 0.55,
              details: {
                durationMinutes: 60,
                reviewState: 'confirmed',
                source: 'manual',
              },
            },
          ],
        }}
        trailingLabel="Last 12h"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-activity-card-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-activity-card-marker-workout-session')).toBeTruthy();
    });

    act(() => {
      fireEvent.press(screen.getByTestId('heart-activity-card-marker-workout-session'));
    });

    await waitFor(() => {
      expect(screen.getByText('Workout')).toBeTruthy();
      expect(screen.getByText('Return')).toBeTruthy();
      expect(screen.UNSAFE_getAllByType(Stop).some((stop) => stop.props.stopColor === colors.primary)).toBe(false);
    });
  });

  it('renders activity draft editing affordances and suppresses chart scrubbing while a draft is active', async () => {
    const points = Array.from({ length: 120 }, (_, index) => ({
      label: formatAxisTime(new Date(2026, 3, 23, 12, index * 5)),
      value: 60 + (index % 24),
    }));
    const expectedAxisLabels = buildHeartAxisLabels(points, 60, '2026-04-23');
    const screen = render(
      <PannableHeartChart
        accentColor={colors.heart}
        activityDraft={{
          kind: 'Workout',
          endMinuteOffset: 104 * 5,
          startMinuteOffset: 92 * 5,
        }}
        anchorDayKey="2026-04-23"
        axisTestID="heart-draft-axis"
        chartTestID="heart-draft"
        height={150}
        markers={[]}
        points={points}
        resetKey="2026-04-23"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-draft-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-draft-draft-band')).toBeTruthy();
      expect(screen.getByTestId('heart-draft-draft-body')).toBeTruthy();
      expect(screen.getByTestId('heart-draft-draft-marker')).toBeTruthy();
      expect(screen.getByTestId('heart-draft-draft-start-handle')).toBeTruthy();
      expect(screen.getByTestId('heart-draft-draft-end-handle')).toBeTruthy();
      expect(screen.getByText(expectedAxisLabels[0] ?? '')).toBeTruthy();
      expect(screen.getByText(expectedAxisLabels[1] ?? '')).toBeTruthy();
      expect(screen.getByText(expectedAxisLabels[2] ?? '')).toBeTruthy();
    });

    const overlay = screen.getByTestId('heart-draft');
    const axis = screen.getByTestId('heart-draft-axis');
    const body = screen.getByTestId('heart-draft-draft-body');

    expect(overlay.props.onMoveShouldSetResponderCapture?.(createResponderEvent(60, true), createGestureState(60))).toBe(
      false,
    );
    expect(axis.props.onStartShouldSetResponderCapture?.(createResponderEvent(20, true))).toBeFalsy();
    expect(body.props.onStartShouldSetResponder?.(createResponderEvent(0, true))).toBe(true);
    expect(body.props.onResponderTerminationRequest?.()).toBe(false);
  });

  it('keeps the add new activity action visible after a same-length heart snapshot refresh', async () => {
    const activityReviewActions = {
      confirmActivity: jest.fn(async () => undefined),
      createManualActivity: jest.fn(async () => 'manual-1'),
      createManualSleep: jest.fn(async () => 'sleep-2026-04-23'),
      dismissActivity: jest.fn(async () => undefined),
      relabelActivity: jest.fn(async () => undefined),
      updateActivity: jest.fn(async () => undefined),
      updateSleep: jest.fn(async () => undefined),
    };
    const firstSnapshot = {
      restingHr: 48,
      averageHr: 69,
      maxHr: 131,
      series: Array.from({ length: 120 }, (_, index) => ({
        label: `${index}`,
        value: 58 + (index % 24),
      })),
      markers: [],
    };
    const secondSnapshot = {
      restingHr: 47,
      averageHr: 68,
      maxHr: 129,
      series: Array.from({ length: 120 }, (_, index) => ({
        label: `${index}`,
        value: 56 + (index % 20),
      })),
      markers: [],
    };
    const screen = render(
      <HeartSnapshotCard
        activityReviewActions={activityReviewActions}
        chartTestID="heart-add-action"
        snapshot={firstSnapshot}
        trailingLabel="Last 12h"
        viewportKey="2026-04-23"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-add-action-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-add-action-add-activity-button')).toBeTruthy();
      expect(screen.getByText('Add New Activity')).toBeTruthy();
    });

    act(() => {
      screen.rerender(
        <HeartSnapshotCard
          activityReviewActions={activityReviewActions}
          chartTestID="heart-add-action"
          snapshot={secondSnapshot}
          trailingLabel="Last 12h"
          viewportKey="2026-04-23"
          windowPointCount={60}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-add-action-add-activity-button')).toBeTruthy();
      expect(screen.getByText('Add New Activity')).toBeTruthy();
    });
  });

  it('restores the idle add action when a focused marker is no longer present in the current snapshot', async () => {
    const activityReviewActions = {
      confirmActivity: jest.fn(async () => undefined),
      createManualActivity: jest.fn(async () => 'manual-1'),
      createManualSleep: jest.fn(async () => 'sleep-2026-04-23'),
      dismissActivity: jest.fn(async () => undefined),
      relabelActivity: jest.fn(async () => undefined),
      updateActivity: jest.fn(async () => undefined),
      updateSleep: jest.fn(async () => undefined),
    };
    const firstSnapshot = {
      restingHr: 48,
      averageHr: 69,
      maxHr: 131,
      series: Array.from({ length: 120 }, (_, index) => ({
        label: `${index}`,
        value: 58 + (index % 24),
      })),
      markers: [
        {
          id: 'stale-workout',
          kind: 'activity' as const,
          label: 'Workout',
          timeLabel: '12:10 - 1:10',
          startFraction: 0.42,
          endFraction: 0.55,
          details: {
            durationMinutes: 60,
            reviewState: 'confirmed' as const,
            source: 'manual' as const,
          },
        },
      ],
    };
    const secondSnapshot = {
      restingHr: 47,
      averageHr: 68,
      maxHr: 129,
      series: Array.from({ length: 120 }, (_, index) => ({
        label: `${index}`,
        value: 56 + (index % 20),
      })),
      markers: [],
    };
    const screen = render(
      <HeartSnapshotCard
        activityReviewActions={activityReviewActions}
        chartTestID="heart-stale-focus"
        snapshot={firstSnapshot}
        trailingLabel="Apr 23"
        viewportKey="history-heart-card"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-stale-focus-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-stale-focus-marker-stale-workout')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('heart-stale-focus-marker-stale-workout'));

    await waitFor(() => {
      expect(screen.getByText('Workout')).toBeTruthy();
      expect(screen.queryByTestId('heart-stale-focus-add-activity-button')).toBeNull();
      expect(screen.getByTestId('heart-stale-focus-return-button')).toBeTruthy();
    });

    act(() => {
      screen.rerender(
        <HeartSnapshotCard
          activityReviewActions={activityReviewActions}
          chartTestID="heart-stale-focus"
          snapshot={secondSnapshot}
          trailingLabel="Apr 24"
          viewportKey="history-heart-card"
          windowPointCount={60}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-stale-focus-add-activity-button')).toBeTruthy();
      expect(screen.getByText('Add New Activity')).toBeTruthy();
      expect(screen.queryByTestId('heart-stale-focus-return-button')).toBeNull();
    });
  });

  it('derives heart metrics from the current visible window', async () => {
    const screen = render(
      <HeartSnapshotCard
        chartTestID="heart-window-metrics"
        snapshot={{
          restingHr: 40,
          averageHr: 75,
          maxHr: 140,
          series: [
            { label: '1', value: 50 },
            { label: '2', value: 60 },
            { label: '3', value: 70 },
            { label: '4', value: 80 },
            { label: '5', value: 90 },
            { label: '6', value: 100 },
          ],
          markers: [],
        }}
        trailingLabel="Last 12h"
        viewportKey="2026-04-23"
        windowPointCount={4}
      />,
    );

    const viewport = screen.getByTestId('heart-window-metrics-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByText('Low')).toBeTruthy();
      expect(screen.getByText('70 BPM')).toBeTruthy();
      expect(screen.getByText('85 BPM')).toBeTruthy();
      expect(screen.getByText('100 BPM')).toBeTruthy();
      expect(screen.queryByText('40 BPM')).toBeNull();
    });

    const chart = screen.UNSAFE_getByType(PannableHeartChart);

    act(() => {
      chart.props.onViewportWindowChange?.({
        windowPointCount: 3,
        windowStart: 0,
      });
    });

    await waitFor(() => {
      expect(screen.getByText('50 BPM')).toBeTruthy();
      expect(screen.getByText('60 BPM')).toBeTruthy();
      expect(screen.getByText('70 BPM')).toBeTruthy();
      expect(screen.queryByText('100 BPM')).toBeNull();
    });
  });

  it('keeps the idle add activity panel mounted when new heart data increases the base window size', async () => {
    const activityReviewActions = {
      confirmActivity: jest.fn(async () => undefined),
      createManualActivity: jest.fn(async () => 'manual-1'),
      createManualSleep: jest.fn(async () => 'sleep-2026-04-23'),
      dismissActivity: jest.fn(async () => undefined),
      relabelActivity: jest.fn(async () => undefined),
      updateActivity: jest.fn(async () => undefined),
      updateSleep: jest.fn(async () => undefined),
    };
    const firstSnapshot = {
      restingHr: 48,
      averageHr: 69,
      maxHr: 131,
      series: Array.from({ length: 120 }, (_, index) => ({
        label: `${index}`,
        value: 58 + (index % 24),
      })),
      markers: [],
    };
    const secondSnapshot = {
      restingHr: 48,
      averageHr: 69,
      maxHr: 131,
      series: Array.from({ length: 121 }, (_, index) => ({
        label: `${index}`,
        value: 58 + (index % 24),
      })),
      markers: [],
    };
    const screen = render(
      <HeartSnapshotCard
        activityReviewActions={activityReviewActions}
        chartTestID="heart-add-visible"
        snapshot={firstSnapshot}
        trailingLabel="Last 12h"
        viewportKey="2026-04-23"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-add-visible-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-add-visible-add-activity-button')).toBeTruthy();
      expect(screen.getByTestId('heart-add-visible-activity-detail-panel')).toBeTruthy();
    });

    act(() => {
      screen.rerender(
        <HeartSnapshotCard
          activityReviewActions={activityReviewActions}
          chartTestID="heart-add-visible"
          snapshot={secondSnapshot}
          trailingLabel="Last 12h"
          viewportKey="2026-04-23"
          windowPointCount={61}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-add-visible-add-activity-button')).toBeTruthy();
      expect(screen.getByTestId('heart-add-visible-activity-detail-panel')).toBeTruthy();
    });
  });

  it('keeps the idle add activity panel visible across history viewport key changes', async () => {
    const activityReviewActions = {
      confirmActivity: jest.fn(async () => undefined),
      createManualActivity: jest.fn(async () => 'manual-1'),
      createManualSleep: jest.fn(async () => 'sleep-2026-04-23'),
      dismissActivity: jest.fn(async () => undefined),
      relabelActivity: jest.fn(async () => undefined),
      updateActivity: jest.fn(async () => undefined),
      updateSleep: jest.fn(async () => undefined),
    };
    const snapshot = {
      restingHr: 48,
      averageHr: 69,
      maxHr: 131,
      series: Array.from({ length: 120 }, (_, index) => ({
        label: `${index}`,
        value: 58 + (index % 24),
      })),
      markers: [],
    };
    const screen = render(
      <HeartSnapshotCard
        activityReviewActions={activityReviewActions}
        chartTestID="heart-history-idle"
        snapshot={snapshot}
        trailingLabel="Apr 23"
        viewportKey="2026-04-23"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-history-idle-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-history-idle-add-activity-button')).toBeTruthy();
      expect(screen.getByTestId('heart-history-idle-activity-detail-panel')).toBeTruthy();
      expect(StyleSheet.flatten(screen.getByTestId('heart-history-idle-activity-detail-panel').props.style)?.opacity).toBe(1);
    });

    act(() => {
      screen.rerender(
        <HeartSnapshotCard
          activityReviewActions={activityReviewActions}
          chartTestID="heart-history-idle"
          snapshot={snapshot}
          trailingLabel="Apr 22"
          viewportKey="2026-04-22"
          windowPointCount={60}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-history-idle-add-activity-button')).toBeTruthy();
      expect(screen.getByTestId('heart-history-idle-activity-detail-panel')).toBeTruthy();
      expect(StyleSheet.flatten(screen.getByTestId('heart-history-idle-activity-detail-panel').props.style)?.opacity).toBe(1);
    });
  });

  it('stages heart card chrome changes when entering and leaving draft mode', async () => {
    const activityReviewActions = {
      confirmActivity: jest.fn(async () => undefined),
      createManualActivity: jest.fn(async () => 'manual-1'),
      createManualSleep: jest.fn(async () => 'sleep-2026-04-23'),
      dismissActivity: jest.fn(async () => undefined),
      relabelActivity: jest.fn(async () => undefined),
      updateActivity: jest.fn(async () => undefined),
      updateSleep: jest.fn(async () => undefined),
    };
    const screen = render(
      <HeartSnapshotCard
        activityReviewActions={activityReviewActions}
        chartTestID="heart-draft-card"
        snapshot={{
          restingHr: 48,
          averageHr: 69,
          maxHr: 131,
          series: Array.from({ length: 120 }, (_, index) => ({
            label: formatAxisTime(new Date(2026, 3, 23, 12, index * 5)),
            value: 58 + (index % 24),
          })),
          markers: [],
        }}
        trailingLabel="Last 12h"
        viewportKey="2026-04-23"
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-draft-card-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-draft-card-add-activity-button')).toBeTruthy();
      expect(screen.getByTestId('heart-draft-card-title').props.children).toBe('Heart Rate');
    });

    expect(screen.getByTestId('heart-draft-card-latest-button')).toBeTruthy();
    expect(screen.queryByTestId('heart-draft-card-draft-cancel')).toBeNull();

    fireEvent.press(screen.getByTestId('heart-draft-card-add-activity-button'));

    expect(screen.getByTestId('heart-draft-card-title').props.children).toBe('Heart Rate');
    expect(screen.getByTestId('heart-draft-card-latest-button')).toBeTruthy();
    expect(screen.queryByTestId('heart-draft-card-draft-cancel')).toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('heart-draft-card-title').props.children).toBe('Activity');
      expect(screen.getByTestId('heart-draft-card-draft-cancel')).toBeTruthy();
      expect(screen.getByText('Draft activity')).toBeTruthy();
    });

    expect(screen.UNSAFE_getAllByType(Stop).some((stop) => stop.props.stopColor === colors.heart)).toBe(false);

    expect(screen.queryByTestId('heart-draft-card-latest-button')).toBeNull();

    fireEvent.press(screen.getByTestId('heart-draft-card-draft-cancel'));

    expect(screen.UNSAFE_getAllByType(Stop).some((stop) => stop.props.stopColor === colors.heart)).toBe(false);

    expect(screen.getByTestId('heart-draft-card-title').props.children).toBe('Activity');
    expect(screen.getByTestId('heart-draft-card-draft-cancel')).toBeTruthy();
    expect(screen.queryByTestId('heart-draft-card-latest-button')).toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('heart-draft-card-title').props.children).toBe('Heart Rate');
      expect(screen.getByTestId('heart-draft-card-latest-button')).toBeTruthy();
      expect(screen.getByTestId('heart-draft-card-add-activity-button')).toBeTruthy();
    });
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
    const svg = screen.UNSAFE_getByType(Svg);

    expect(sleepMarker).toBeTruthy();
    expect(activityMarker).toBeTruthy();
    expect(svg.props.preserveAspectRatio).toBe('none');
    expect(StyleSheet.flatten(sleepMarker.props.style)?.top).toBe(
      StyleSheet.flatten(activityMarker.props.style)?.top,
    );
  });

  it('renders dashed bridges across bounded missing spans in line charts', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: null },
          { label: 'Wed', value: 74 },
        ]}
        testID="trend-chart"
      />,
    );

    const bridge = screen.getByTestId('trend-chart-bridge-0');

    expect(bridge).toBeTruthy();
    expect(normalizeSvgColor(bridge.props.stroke)).toBe(processColor(colors.subtle));
    expect(bridge.props.strokeDasharray).toEqual(['2.2', '2.2']);
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
    expect(screen.queryByTestId('trend-chart-bridge-0')).toBeNull();
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

  it('keeps missing trend buckets selectable without drawing an active dot', () => {
    const screen = render(
      <TrendChart
        accentColor="#00ffff"
        points={[
          { label: 'Mon', value: 72 },
          { label: 'Tue', value: null },
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
    expect(within(bubble).getByText('No data')).toBeTruthy();
    expect(screen.queryByTestId('trend-chart-active-dot')).toBeNull();
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

  it('keeps dashed heart-chart bridges stable while zooming between windows', async () => {
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
          value: index >= 34 && index <= 36 ? null : 60 + (index % 20),
        }))}
        windowPointCount={60}
      />,
    );

    const viewport = screen.getByTestId('heart-chart-viewport');

    act(() => {
      viewport.props.onLayout?.({ nativeEvent: { layout: { width: 240, height: 150 } } });
    });

    expect(screen.getByTestId('heart-chart-bridge-0')).toBeTruthy();

    act(() => {
      fireEvent.press(screen.getByTestId('heart-chart-marker-sleep-focus'));
    });

    expect(screen.getByTestId('heart-chart-bridge-0')).toBeTruthy();

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
            value: index >= 34 && index <= 36 ? null : 60 + (index % 20),
          }))}
          windowPointCount={60}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('heart-chart-bridge-0')).toBeTruthy();
    });
  });
});
