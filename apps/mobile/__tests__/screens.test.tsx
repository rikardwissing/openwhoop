import type { ReactElement } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockSegments: string[] = ['(tabs)', 'settings'];

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
  }),
  useSegments: () => mockSegments,
}));

jest.mock('@/services/background/backgroundSyncState', () => ({
  getBackgroundSyncState: jest.fn(async () => ({
    pairedDeviceId: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastSuccessAt: null,
    lastSource: null,
    lastResult: null,
    lastError: null,
    lastImportedReadings: null,
    notificationPermission: 'unknown',
    notificationBaselineAt: null,
  })),
}));

jest.mock('@/services/background/backgroundSyncTask', () => ({
  ensureBackgroundSyncRegistered: jest.fn(async () => {}),
  enableBackgroundSyncAfterPairing: jest.fn(async () => {}),
  disableBackgroundSync: jest.fn(async () => {}),
  getBackgroundSyncDiagnostics: jest.fn(async () => ({
    apiStatus: 'available',
    isTaskDefined: true,
    isTaskRegistered: true,
    minimumIntervalMinutes: 15,
  })),
  triggerBackgroundSyncForTesting: jest.fn(async () => true),
}));

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { WearableProgressOverlay } from '@/components/ui/WearableProgressOverlay';
import { MockHealthRepository } from '@/data/mock/MockHealthRepository';
import { HealthDataProvider } from '@/providers/HealthDataProvider';
import {
  WearableSyncContextProvider,
  defaultWearableSyncContextValue,
} from '@/providers/WearableSyncProvider';
import { HeartScreen } from '@/screens/HeartScreen';
import { LiveEventsScreen } from '@/screens/LiveEventsScreen';
import { PairWearableScreen } from '@/screens/PairWearableScreen';
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
  backgroundSyncDiagnostics: typeof defaultWearableSyncContextValue.backgroundSyncDiagnostics;
  liveEvents: WearableLiveEvent[];
  progress: SyncProgress;
  scanResults: WearableScanResult[];
  scan: () => Promise<void>;
  pairDevice: (device: WearableScanResult) => Promise<SyncResult | null>;
  selectDevice: (device: WearableScanResult) => Promise<void>;
  forgetDevice: () => Promise<void>;
  syncSelected: (options?: { showOverlay?: boolean }) => Promise<SyncResult | null>;
  triggerBackgroundSyncTest: () => Promise<boolean>;
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

function getRefreshControl(screen: ReturnType<typeof renderWithProviders>) {
  const scrollView = screen.UNSAFE_getAllByType(ScrollView).find((node) => node.props.refreshControl);
  expect(scrollView?.props.refreshControl).toBeTruthy();
  return scrollView?.props.refreshControl;
}

describe('screen rendering', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockBack.mockClear();
    mockReplace.mockClear();
    mockSegments = ['(tabs)', 'settings'];
  });

  it('renders the today screen dashboard', async () => {
    const screen = renderWithProviders(<TodayScreen />);

    expect(await screen.findByText('Good afternoon')).toBeTruthy();
    expect(await screen.findByText('Heart Rate')).toBeTruthy();
    expect(await screen.findByText('Strain')).toBeTruthy();
  });

  it('shows live heart rate on the today dashboard when streaming is active', async () => {
    const screen = renderWithProviders(<TodayScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
        liveHeartRate: 68,
        liveHeartRateAt: Date.now(),
      },
    });

    expect(await screen.findByText('Live')).toBeTruthy();
    expect(await screen.findByText('68 bpm')).toBeTruthy();
  });

  it('opens settings from the shared header and shows the wearable battery badge', async () => {
    const screen = renderWithProviders(<TodayScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
        batteryPercent: 85,
      },
    });

    expect(await screen.findByText('85%')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Open settings'));

    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('runs sync from pull-to-refresh on dashboard screens when a wearable is selected', async () => {
    const syncSelected = jest.fn(async () => null);
    const screen = renderWithProviders(<TodayScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
      },
      syncSelected,
    });

    expect(await screen.findByText('Heart Rate')).toBeTruthy();

    const refreshControl = getRefreshControl(screen);

    act(() => {
      refreshControl?.props.onRefresh();
    });

    expect(syncSelected).toHaveBeenCalledTimes(1);
    expect(syncSelected).toHaveBeenCalledWith({ showOverlay: false });
  });

  it('hides the full-screen progress overlay for non-overlay sync progress', () => {
    const screen = renderWithProviders(<WearableProgressOverlay />, {
      progress: {
        status: 'syncing',
        message: 'Refreshing from pull-to-refresh...',
        showOverlay: false,
      },
    });

    expect(screen.queryByText('Syncing wearable')).toBeNull();
  });

  it('renders the sleep screen', async () => {
    const screen = renderWithProviders(<SleepScreen />);

    expect(await screen.findByText('Sleep Score Trend')).toBeTruthy();
    expect(await screen.findByText('Recent Nights')).toBeTruthy();
    expect(await screen.findByText('Time in Bed')).toBeTruthy();
  });

  it('rounds the sleep score ring to a whole percent', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });
    const sleepHistory = await repository.getSleepHistory('14d');
    jest.spyOn(repository, 'getSleepHistory').mockResolvedValue({
      ...sleepHistory,
      headlineScore: 82.4,
    });

    const screen = render(
      <HealthDataProvider repository={repository}>
        <WearableSyncContextProvider value={createWearableContextValue()}>
          <SleepScreen />
        </WearableSyncContextProvider>
      </HealthDataProvider>,
    );

    expect(await screen.findByText('82%')).toBeTruthy();
    expect(screen.queryByText('82.4%')).toBeNull();
  });

  it('moves backward and forward through sleep days', async () => {
    const screen = renderWithProviders(<SleepScreen />);

    await screen.findByTestId('sleep-last-night-stage-chart');
    expect(screen.getByTestId('sleep-selected-session-label').props.children).toBe('Apr 23');
    expect(screen.getByText('82%')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sleep-day-backward-button'));

    await waitFor(() => {
      expect(screen.getByTestId('sleep-selected-session-label').props.children).toBe('Apr 22');
    });
    expect(screen.getByText('86%')).toBeTruthy();

    fireEvent.press(screen.getByTestId('sleep-day-forward-button'));

    await waitFor(() => {
      expect(screen.getByTestId('sleep-selected-session-label').props.children).toBe('Apr 23');
    });
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

  it('shows live heart rate on the heart screen when streaming is active', async () => {
    const screen = renderWithProviders(<HeartScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
        liveHeartRate: 72,
        liveHeartRateAt: Date.now(),
      },
    });

    expect(await screen.findByText('Live')).toBeTruthy();
    expect(await screen.findByText('72 bpm')).toBeTruthy();
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

    expect(screen.getByText('Unstrap')).toBeTruthy();
    expect(screen.getByText('Your data. Unlocked.')).toBeTruthy();
    expect(screen.getByText('Performance Diagnostics')).toBeTruthy();
    expect(screen.getByText('Run Full Perf Sweep')).toBeTruthy();
    expect(screen.getByText('Selected Wearable')).toBeTruthy();
    expect(screen.getByText('Live events')).toBeTruthy();
    expect(screen.getByText('Restart wearable')).toBeTruthy();
    expect(screen.getByText('Export for Analysis')).toBeTruthy();
    expect(screen.getByText('Export Snapshot')).toBeTruthy();
    expect(screen.getByText('Battery')).toBeTruthy();
    expect(screen.getAllByText('Status').length).toBeGreaterThan(0);
    expect(screen.getByText('Charge')).toBeTruthy();
    expect(screen.getByText('Wear')).toBeTruthy();
    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.getByText('Registered')).toBeTruthy();
    expect(screen.getByText('15m')).toBeTruthy();
    expect(screen.getByText('Last started')).toBeTruthy();
    expect(screen.getByText('Last finished')).toBeTruthy();
    expect(screen.getByText('Trigger test run')).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
    expect(screen.queryByText('Scan nearby')).toBeNull();
    expect(screen.queryByText('Scan Results')).toBeNull();
  });

  it('runs the background sync test trigger from settings', () => {
    const triggerBackgroundSyncTest = jest.fn(async () => true);
    const screen = renderWithProviders(<SettingsScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
      },
      triggerBackgroundSyncTest,
    });

    fireEvent.press(screen.getByText('Trigger test run'));

    expect(triggerBackgroundSyncTest).toHaveBeenCalledTimes(1);
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

    expect(screen.getAllByText('85%').length).toBeGreaterThan(0);
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

  it('renders the pairing screen and auto-starts a scan', () => {
    const scan = jest.fn(async () => {});
    const screen = renderWithProviders(<PairWearableScreen />, {
      scan,
      progress: {
        status: 'scanning',
        message: 'Scanning for nearby wearables...',
      },
    });

    expect(screen.getByText('Pair Wearable')).toBeTruthy();
    expect(screen.getByText('Connect your wearable. Unlock your data.')).toBeTruthy();
    expect(screen.getByText('Nearby Wearables')).toBeTruthy();
    expect(screen.getByText('Scanning for nearby wearables now...')).toBeTruthy();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('pairs and syncs a wearable from the pairing screen', async () => {
    const pairDevice = jest.fn(async () => null);
    const screen = renderWithProviders(<PairWearableScreen />, {
      progress: {
        status: 'idle',
        message: 'Select a wearable.',
      },
      scanResults: [
        {
          id: 'strap-1',
          name: 'Neo Strap',
          rssi: -44,
        },
      ],
      pairDevice,
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Pair'));
    });

    expect(pairDevice).toHaveBeenCalledWith({
      id: 'strap-1',
      name: 'Neo Strap',
      rssi: -44,
    });
  });
});
