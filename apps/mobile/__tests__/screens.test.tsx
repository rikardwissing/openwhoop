import type { ReactElement } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockBack = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
  }),
}));

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { MockHealthRepository } from '@/data/mock/MockHealthRepository';
import { HealthDataProvider } from '@/providers/HealthDataProvider';
import {
  WearableSyncContextProvider,
  defaultWearableSyncContextValue,
} from '@/providers/WearableSyncProvider';
import { HeartScreen } from '@/screens/HeartScreen';
import { LiveEventsScreen } from '@/screens/LiveEventsScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { SleepScreen } from '@/screens/SleepScreen';
import { TodayScreen } from '@/screens/TodayScreen';
import { WellnessScreen } from '@/screens/WellnessScreen';
import type { DeviceState, SyncProgress, SyncResult, WearableLiveEvent, WearableScanResult } from '@/types/device';

jest.mock('@/services/databaseExport', () => ({
  exportAndShareDatabaseSnapshot: jest.fn(async () => ({
    fileName: 'btwearable.db',
    fileUri: 'file:///mock-cache/exports/btwearable.db',
    sizeBytes: 4096,
  })),
}));

function createWearableContextValue(overrides: Partial<{
  deviceState: DeviceState;
  liveEvents: WearableLiveEvent[];
  progress: SyncProgress;
  scanResults: WearableScanResult[];
  scan: () => Promise<void>;
  selectDevice: (device: WearableScanResult) => Promise<void>;
  forgetDevice: () => Promise<void>;
  syncSelected: () => Promise<SyncResult | null>;
  restartDevice: () => Promise<void>;
  setAlarm: (unixSeconds: number) => Promise<void>;
  disableAlarm: () => Promise<void>;
}> = {}) {
  return {
    ...defaultWearableSyncContextValue,
    ...overrides,
    deviceState: {
      ...defaultWearableSyncContextValue.deviceState,
      ...overrides.deviceState,
    },
  };
}

function renderWithProviders(children: ReactElement, wearableOverrides = {}) {
  return render(
    <HealthDataProvider repository={new MockHealthRepository({ delayMs: 0 })}>
      <WearableSyncContextProvider value={createWearableContextValue(wearableOverrides)}>
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
  beforeEach(() => {
    mockPush.mockClear();
    mockBack.mockClear();
  });

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
    expect(screen.getByText('Live events')).toBeTruthy();
    expect(screen.getByText('Restart wearable')).toBeTruthy();
    expect(screen.getByText('Export for Analysis')).toBeTruthy();
    expect(screen.getByText('Export Database')).toBeTruthy();
    expect(screen.getByText('Battery')).toBeTruthy();
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Charge')).toBeTruthy();
    expect(screen.getByText('Wear')).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  it('opens the live events screen from settings', () => {
    const screen = renderWithProviders(<SettingsScreen />);

    fireEvent.press(screen.getByText('Live events'));

    expect(mockPush).toHaveBeenCalledWith('/live-events');
  });

  it('runs the restart action from settings', () => {
    const restartDevice = jest.fn(async () => {});
    const screen = renderWithProviders(<SettingsScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
      },
      restartDevice,
    });

    fireEvent.press(screen.getByText('Restart wearable'));

    expect(restartDevice).toHaveBeenCalledTimes(1);
  });

  it('renders battery percent and derived status when available', () => {
    const screen = renderWithProviders(<SettingsScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
        batteryPercent: 85,
        chargingStatus: 'charging',
        bodyStatus: 'on-body',
      },
    });

    expect(screen.getByText('85%')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Charging')).toBeTruthy();
    expect(screen.getByText('On body')).toBeTruthy();
  });

  it('renders an empty live event screen state', () => {
    const screen = renderWithProviders(<LiveEventsScreen />);

    expect(screen.getByText('Live Events')).toBeTruthy();
    expect(screen.getByText('No live events seen yet in this session.')).toBeTruthy();
  });

  it('renders newest-first live events with titles and details', () => {
    const screen = renderWithProviders(<LiveEventsScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
      },
      liveEvents: [
        {
          id: 'event-2',
          observedAt: '2026-04-02 10:00:05',
          deviceUnixMs: 1_775_125_205_000,
          source: 'event',
          kind: 'charging-off',
          title: 'Charging stopped',
          detail: null,
        },
        {
          id: 'event-1',
          observedAt: '2026-04-02 10:00:00',
          deviceUnixMs: null,
          source: 'command',
          kind: 'firmware-reply',
          title: 'Firmware reply',
          detail: 'Harvard 1.2.3 · Boylston 4.5.6',
        },
      ],
    });

    expect(screen.getByText('Charging stopped')).toBeTruthy();
    expect(screen.getByText('Firmware reply')).toBeTruthy();
    expect(screen.getByText('Harvard 1.2.3 · Boylston 4.5.6')).toBeTruthy();
    expect(screen.getByText('Event')).toBeTruthy();
    expect(screen.getByText('Command')).toBeTruthy();
  });
});
