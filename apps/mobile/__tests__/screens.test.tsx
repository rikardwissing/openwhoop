import type { ReactElement } from 'react';
import { act, render } from '@testing-library/react-native';

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { MockHealthRepository } from '@/data/mock/MockHealthRepository';
import { HealthDataProvider } from '@/providers/HealthDataProvider';
import {
  WearableSyncContextProvider,
  defaultWearableSyncContextValue,
} from '@/providers/WearableSyncProvider';
import { HeartScreen } from '@/screens/HeartScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { SleepScreen } from '@/screens/SleepScreen';
import { TodayScreen } from '@/screens/TodayScreen';
import { WellnessScreen } from '@/screens/WellnessScreen';

function renderWithProviders(children: ReactElement) {
  return render(
    <HealthDataProvider repository={new MockHealthRepository({ delayMs: 0 })}>
      <WearableSyncContextProvider value={defaultWearableSyncContextValue}>
        {children}
      </WearableSyncContextProvider>
    </HealthDataProvider>,
  );
}

function applyChartSelection(
  screen: ReturnType<typeof renderWithProviders>,
  component: any,
  testID: string,
  selection: unknown,
) {
  const chart = screen.UNSAFE_getAllByType(component).find((node) => node.props.testID === testID);
  expect(chart).toBeTruthy();

  act(() => {
    chart?.props.onSelectionChange?.(selection);
  });
}

describe('screen rendering', () => {
  it('renders the today screen dashboard', async () => {
    const screen = renderWithProviders(<TodayScreen />);

    expect(await screen.findByText('Good afternoon')).toBeTruthy();
    expect(await screen.findByText('Heart Rate')).toBeTruthy();
    expect(await screen.findByText('Strain')).toBeTruthy();
  });

  it('renders the sleep screen', async () => {
    const screen = renderWithProviders(<SleepScreen />);

    expect(await screen.findByText('Sleep Score Trend')).toBeTruthy();
    expect(await screen.findByText('Recent Nights')).toBeTruthy();
  });

  it('swaps sleep-stage readout while scrubbing and restores on release', async () => {
    const screen = renderWithProviders(<SleepScreen />);
    await screen.findByTestId('sleep-last-night-stage-chart');

    expect(await screen.findByText('Efficiency 91%')).toBeTruthy();

    applyChartSelection(screen, SleepStageChart, 'sleep-last-night-stage-chart', {
      endMinute: 32,
      index: 0,
      segment: { stage: 'light', minutes: 32 },
      startMinute: 0,
    });

    expect(screen.getByText('Light sleep')).toBeTruthy();
    expect(screen.getByText('32m')).toBeTruthy();

    applyChartSelection(screen, SleepStageChart, 'sleep-last-night-stage-chart', null);

    expect(screen.getByText('Efficiency 91%')).toBeTruthy();
  });

  it('renders the heart screen', async () => {
    const screen = renderWithProviders(<HeartScreen />);

    expect(await screen.findByText('Intraday Heart Rate')).toBeTruthy();
    expect(await screen.findByText('Resting HR Trend')).toBeTruthy();
  });

  it('swaps heart chart readout while scrubbing and restores on release', async () => {
    const screen = renderWithProviders(<HeartScreen />);
    await screen.findByTestId('heart-intraday-chart');

    expect(await screen.findByText('24-hour average')).toBeTruthy();
    expect(await screen.findByText('79 BPM')).toBeTruthy();

    applyChartSelection(screen, TrendChart, 'heart-intraday-chart', {
      index: 13,
      point: { label: '8:15 PM', value: 142 },
    });

    expect(screen.getAllByText('8:15 PM').length).toBeGreaterThan(0);
    expect(screen.getByText('142 BPM')).toBeTruthy();

    applyChartSelection(screen, TrendChart, 'heart-intraday-chart', null);

    expect(screen.getByText('24-hour average')).toBeTruthy();
    expect(screen.getByText('79 BPM')).toBeTruthy();
  });

  it('renders the wellness screen', async () => {
    const screen = renderWithProviders(<WellnessScreen />);

    expect(await screen.findByText('Stress')).toBeTruthy();
    expect(await screen.findByText('Recent Activity')).toBeTruthy();
  });

  it('renders the settings screen device controls', () => {
    const screen = renderWithProviders(<SettingsScreen />);

    expect(screen.getByText('Selected Wearable')).toBeTruthy();
    expect(screen.getByText('Scan nearby')).toBeTruthy();
  });
});
