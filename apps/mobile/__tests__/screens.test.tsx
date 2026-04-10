import { useEffect, type ReactElement } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, ScrollView, StyleSheet, processColor } from 'react-native';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockSegments: string[] = ['(tabs)', 'settings'];

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    back: jest.fn(),
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
    lastSyncImportSummary: null,
  })),
}));

const mockClearAllLocalData = jest.fn(async () => {});
const mockUseOptionalAppDatabase = jest.fn<unknown | null, []>(() => null);
const mockUseOptionalAppDatabaseControls = jest.fn(() => ({
  loadSeededData: jest.fn(async () => {}),
  clearAllLocalData: mockClearAllLocalData,
}));
const mockInspectDatabaseMaintenance = jest.fn(async (_db?: unknown) => ({
  heartRateHasImuColumn: false,
  pageCount: 0,
  pageSizeBytes: 0,
  freelistCount: 0,
  sizeBytes: 0,
  freeBytes: 0,
  needsMaintenance: false,
}));
const mockRunDatabaseMaintenance = jest.fn(async (_db?: unknown) => ({
  ran: false,
  migratedLegacyHeartRate: false,
  vacuumed: false,
  sizeBytesBefore: 0,
  sizeBytesAfter: 0,
  freeBytesBefore: 0,
  freeBytesAfter: 0,
  reclaimedBytes: 0,
}));

jest.mock('@/providers/AppDatabaseProvider', () => ({
  useOptionalAppDatabase: () => mockUseOptionalAppDatabase(),
  useOptionalAppDatabaseControls: () => mockUseOptionalAppDatabaseControls(),
}));

jest.mock('@/db/maintenance', () => ({
  inspectDatabaseMaintenance: (db: unknown) => mockInspectDatabaseMaintenance(db),
  runDatabaseMaintenance: (db: unknown) => mockRunDatabaseMaintenance(db),
}));

import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { WearableProgressOverlay } from '@/components/ui/WearableProgressOverlay';
import { colors } from '@/constants/theme';
import { MockHealthRepository } from '@/data/mock/MockHealthRepository';
import { HealthDataProvider, useRefreshHealthData } from '@/providers/HealthDataProvider';
import {
  WearableSyncContextProvider,
  defaultWearableSyncContextValue,
} from '@/providers/WearableSyncProvider';
import { LiveEventsScreen } from '@/screens/LiveEventsScreen';
import { PairWearableScreen } from '@/screens/PairWearableScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { SleepScreen } from '@/screens/SleepScreen';
import { TrendsScreen } from '@/screens/TrendsScreen';
import { TodayScreen } from '@/screens/TodayScreen';
import { HistoryScreen } from '@/screens/HistoryScreen';
import { WellnessScreen } from '@/screens/WellnessScreen';
import type { HistoryRange } from '@/types/health';
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
  backgroundSyncState: typeof defaultWearableSyncContextValue.backgroundSyncState;
  liveEvents: WearableLiveEvent[];
  progress: SyncProgress;
  scanResults: WearableScanResult[];
  scan: () => Promise<void>;
  loadSeededData: () => Promise<void>;
  pairDevice: (device: WearableScanResult) => Promise<SyncResult | null>;
  selectDevice: (device: WearableScanResult) => Promise<void>;
  forgetDevice: () => Promise<void>;
  syncSelected: (options?: { showOverlay?: boolean }) => Promise<SyncResult | null>;
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
    backgroundSyncState: {
      ...defaultWearableSyncContextValue.backgroundSyncState,
      ...overrides.backgroundSyncState,
    },
  };
}

function renderWithProviders(children: ReactElement, wearableOverrides = {}) {
  return renderWithRepository(new MockHealthRepository({ delayMs: 0 }), children, wearableOverrides);
}

function renderWithRepository(repository: MockHealthRepository, children: ReactElement, wearableOverrides = {}) {
  return render(
    <HealthDataProvider repository={repository}>
      <WearableSyncContextProvider value={createWearableContextValue(wearableOverrides)}>
        {children}
      </WearableSyncContextProvider>
    </HealthDataProvider>,
  );
}

class TrackingMockHealthRepository extends MockHealthRepository {
  readonly dashboardHeartTimelineCalls: HistoryRange[] = [];

  async getDashboardHeartTimeline(range: HistoryRange) {
    this.dashboardHeartTimelineCalls.push(range);
    return super.getDashboardHeartTimeline(range);
  }
}

class RescanTrackingMockHealthRepository extends MockHealthRepository {
  rescanActivitiesCalls = 0;

  async rescanActivities() {
    this.rescanActivitiesCalls += 1;
    return {
      removedUnconfirmedActivities: 3,
    };
  }
}

function getChartInstance(screen: ReturnType<typeof renderWithProviders>, component: any, testID: string) {
  const chart = screen.UNSAFE_getAllByType(component).find((node) => node.props.testID === testID);
  expect(chart).toBeTruthy();
  return chart;
}

function applyChartSelection(
  screen: ReturnType<typeof renderWithProviders>,
  component: any,
  testID: string,
  selection: unknown,
) {
  const chart = getChartInstance(screen, component, testID);

  act(() => {
    chart?.props.onSelectionChange?.(selection);
  });
}

function expectTrendChartMode(
  screen: ReturnType<typeof renderWithProviders>,
  testID: string,
  mode: 'line' | 'bar',
) {
  const chart = getChartInstance(screen, TrendChart, testID);
  expect(chart?.props.mode ?? 'line').toBe(mode);
}

function getRefreshControl(screen: ReturnType<typeof renderWithProviders>) {
  const scrollView = screen.UNSAFE_getAllByType(ScrollView).find((node) => node.props.refreshControl);
  expect(scrollView?.props.refreshControl).toBeTruthy();
  return scrollView?.props.refreshControl;
}

function normalizeSvgColor(value: unknown) {
  return typeof value === 'object' && value !== null && 'payload' in value
    ? (value as { payload: number }).payload
    : value;
}

describe('screen rendering', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockClearAllLocalData.mockClear();
    mockInspectDatabaseMaintenance.mockClear();
    mockRunDatabaseMaintenance.mockClear();
    mockUseOptionalAppDatabase.mockReturnValue(null);
    mockUseOptionalAppDatabaseControls.mockReturnValue({
      loadSeededData: jest.fn(async () => {}),
      clearAllLocalData: mockClearAllLocalData,
    });
    mockSegments = ['(tabs)', 'settings'];
  });

  it('renders the today screen dashboard', async () => {
    const screen = renderWithProviders(<TodayScreen />);

    expect(await screen.findByText('Good afternoon')).toBeTruthy();
    expect(await screen.findByText('Tonight')).toBeTruthy();
    expect(await screen.findByText('Heart Rate')).toBeTruthy();
    expect(await screen.findByText('Last 12h')).toBeTruthy();
    expect(await screen.findByTestId('today-heart-chart-latest-button')).toBeTruthy();
    expect(await screen.findByTestId('today-strain-chart')).toBeTruthy();
    expect(await screen.findByTestId('today-heart-chart-marker-sleep-latest')).toBeTruthy();
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

    expect(await screen.findByText('68 bpm')).toBeTruthy();
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('renders the dashboard heart snapshot immediately while upgrading to the 7d timeline', async () => {
    const repository = new TrackingMockHealthRepository({ delayMs: 50 });
    const screen = renderWithRepository(repository, <TodayScreen />);

    await screen.findByTestId('today-heart-chart-axis');

    expect(screen.queryByText('Loading 7 day heart history...')).toBeNull();
    expect(screen.queryByTestId('today-heart-chart-loading-shell')).toBeNull();
    expect(screen.getByTestId('today-heart-chart-axis')).toBeTruthy();
    expect(screen.getByTestId('today-heart-chart-refresh-indicator')).toBeTruthy();

    await waitFor(() => {
      expect(repository.dashboardHeartTimelineCalls).toEqual(['7d']);
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId('today-heart-chart-refresh-indicator')).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it('keeps the current 7d heart snapshot visible during same-day heart refreshes', async () => {
    const repository = new TrackingMockHealthRepository({ delayMs: 50 });
    let triggerHeartRefresh: (() => void) | null = null;

    function RefreshableTodayScreen() {
      const refreshHealthData = useRefreshHealthData();

      useEffect(() => {
        triggerHeartRefresh = () => {
          refreshHealthData('heart');
        };

        return () => {
          triggerHeartRefresh = null;
        };
      }, [refreshHealthData]);

      return <TodayScreen />;
    }

    const screen = renderWithRepository(repository, <RefreshableTodayScreen />);

    await screen.findByTestId('today-heart-chart-axis');

    await waitFor(() => {
      expect(repository.dashboardHeartTimelineCalls).toEqual(['7d']);
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId('today-heart-chart-refresh-indicator')).toBeNull();
      },
      { timeout: 2000 },
    );

    act(() => {
      triggerHeartRefresh?.();
    });

    expect(screen.queryByText('Loading 7 day heart history...')).toBeNull();
    expect(screen.getByTestId('today-heart-chart-axis')).toBeTruthy();
    expect(screen.getByTestId('today-heart-chart-refresh-indicator')).toBeTruthy();

    await waitFor(() => {
      expect(repository.dashboardHeartTimelineCalls).toEqual(['7d', '7d']);
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId('today-heart-chart-refresh-indicator')).toBeNull();
      },
      { timeout: 2000 },
    );
  }, 10000);

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

  it('opens deeper tab screens from dashboard card affordances', async () => {
    const screen = renderWithProviders(<TodayScreen />);

    await screen.findByTestId('today-heart-chart');

    expect(screen.queryByTestId('today-open-heart-button')).toBeNull();

    fireEvent.press(screen.getByTestId('today-open-sleep-button'));
    expect(mockPush).toHaveBeenCalledWith('/sleep');

    fireEvent.press(screen.getByTestId('today-open-activity-button'));
    expect(mockPush).toHaveBeenCalledWith('/wellness');
  });

  it('renders the trends screen', async () => {
    const screen = renderWithProviders(<TrendsScreen />);

    expect(await screen.findByText('Patterns over time')).toBeTruthy();
    expect(await screen.findByText('Top Signals')).toBeTruthy();
    expect(await screen.findByTestId('trends-recovery-chart')).toBeTruthy();
    expect(await screen.findByTestId('trends-hrv-chart')).toBeTruthy();
    expect(await screen.findByTestId('trends-sleepConsistency-chart')).toBeTruthy();
    expect(await screen.findByTestId('trends-stress-chart')).toBeTruthy();
  });

  it('opens the right drill-in screen from curated trend cards', async () => {
    const screen = renderWithProviders(<TrendsScreen />);

    await screen.findByTestId('trends-hrv-chart');

    fireEvent.press(screen.getByTestId('trends-open-hrv-button'));
    expect(mockPush).toHaveBeenCalledWith('/sleep');

    expect(screen.queryByTestId('trends-open-restingHr-button')).toBeNull();

    fireEvent.press(screen.getByTestId('trends-open-skinTemperatureDeviation-button'));
    expect(mockPush).toHaveBeenCalledWith('/wellness');
  });

  it('does not mirror the selected trends value outside the chart', async () => {
    const screen = renderWithProviders(<TrendsScreen />);

    await screen.findByTestId('trends-hrv-chart');

    applyChartSelection(screen, TrendChart, 'trends-hrv-chart', {
      index: 0,
      point: { label: 'Apr 10', value: 71 },
    });

    expect(screen.queryByText('Selected overnight HRV')).toBeNull();
  });

  it('uses line charts for continuous or cumulative series and bars for daily buckets', async () => {
    const todayScreen = renderWithProviders(<TodayScreen />);
    await todayScreen.findByTestId('today-heart-chart');
    expect(todayScreen.getByTestId('today-heart-chart-axis')).toBeTruthy();
    expectTrendChartMode(todayScreen, 'today-strain-chart', 'line');
    todayScreen.unmount();

    const trendsScreen = renderWithProviders(<TrendsScreen />);
    await trendsScreen.findByTestId('trends-hrv-chart');
    expectTrendChartMode(trendsScreen, 'trends-recovery-chart', 'bar');
    expectTrendChartMode(trendsScreen, 'trends-hrv-chart', 'bar');
    trendsScreen.unmount();

    const sleepScreen = renderWithProviders(<SleepScreen />);
    await sleepScreen.findByTestId('sleep-score-trend-chart');
    expectTrendChartMode(sleepScreen, 'sleep-score-trend-chart', 'bar');
    expectTrendChartMode(sleepScreen, 'sleep-duration-trend-chart', 'bar');
    sleepScreen.unmount();

    const wellnessScreen = renderWithProviders(<WellnessScreen />);
    await wellnessScreen.findByTestId('wellness-stress-chart');
    expectTrendChartMode(wellnessScreen, 'wellness-stress-chart', 'bar');
  });

  it('renders the history screen and moves between days', async () => {
    const screen = renderWithProviders(<HistoryScreen />);

    await screen.findByTestId('history-heart-chart');
    expect(screen.getByTestId('history-selected-day-label').props.children).toBe('Thursday, April 23');

    fireEvent.press(screen.getByTestId('history-day-backward-button'));

    await waitFor(() => {
      expect(screen.getByTestId('history-selected-day-label').props.children).toBe('Wednesday, April 22');
    });

    fireEvent.press(screen.getByTestId('history-day-forward-button'));

    await waitFor(() => {
      expect(screen.getByTestId('history-selected-day-label').props.children).toBe('Thursday, April 23');
    });
  });

  it('distinguishes suggested heart-graph activities and lets you confirm them from the history screen', async () => {
    const screen = renderWithProviders(<HistoryScreen />);

    await screen.findByTestId('history-heart-chart');
    await screen.findByTestId('history-heart-chart-marker-activity-tempo-run');

    fireEvent.press(screen.getByTestId('history-heart-chart-marker-activity-tempo-run'));

    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-activity-detail-panel')).toBeTruthy();
      expect(screen.queryByText('Suggested')).toBeNull();
      expect(screen.queryByText('Status')).toBeNull();
      expect(screen.queryByText('Confidence')).toBeNull();
      expect(screen.getByTestId('history-heart-chart-activity-confirm')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-activity-relabel')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-activity-dismiss')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-activity-confirm'));

    await waitFor(
      () => {
        expect(screen.queryByTestId('history-heart-chart-activity-confirm')).toBeNull();
        expect(screen.queryByText('Confirmed')).toBeNull();
        expect(screen.getByTestId('history-heart-chart-activity-detail-panel')).toBeTruthy();
        expect(screen.getByTestId('history-heart-chart-return-button')).toBeTruthy();
        expect(screen.queryByTestId('history-heart-chart-add-activity-button')).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it('adds a manual activity from the history heart graph', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });
    const createManualActivitySpy = jest.spyOn(repository, 'createManualActivity');
    const screen = renderWithRepository(repository, <HistoryScreen />);

    await screen.findByTestId('history-heart-chart');
    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-add-activity-button')).toBeTruthy();
      expect(screen.getByText('Add New Activity')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-add-activity-button'));

    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-draft-type-activity')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-type-workout')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-save')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-cancel')).toBeTruthy();
    });

    expect(screen.queryByTestId('history-heart-chart-create-activity-modal')).toBeNull();

    fireEvent.press(screen.getByTestId('history-heart-chart-draft-type-workout'));

    fireEvent.press(screen.getByTestId('history-heart-chart-draft-save'));

    await waitFor(() => {
      expect(createManualActivitySpy).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await createManualActivitySpy.mock.results[0]?.value;
    });

    const [activity, start, end] = createManualActivitySpy.mock.calls[0] ?? [];

    expect(activity).toBe('Workout');
    expect(start).toBeInstanceOf(Date);
    expect(end).toBeInstanceOf(Date);
    expect((start as Date).getTime()).toBeLessThan((end as Date).getTime());

    await waitFor(() => {
      expect(screen.queryByTestId('history-heart-chart-draft-save')).toBeNull();
      expect(screen.queryByTestId('history-heart-chart-add-activity-button')).toBeNull();
      expect(screen.getByTestId('history-heart-chart-return-button')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-title').props.children).toBe('Workout');
      expect(screen.getByTestId('history-heart-chart-activity-edit')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-activity-remove')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-activity-edit'));

    await waitFor(() => {
      expect(screen.queryByTestId('history-heart-chart-return-button')).toBeNull();
      expect(screen.queryByTestId('history-heart-chart-marker-manual-1')).toBeNull();
      expect(screen.getByTestId('history-heart-chart-draft-type-activity')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-type-workout')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-save')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-cancel')).toBeTruthy();
      expect(screen.queryByTestId('history-heart-chart-activity-edit')).toBeNull();
    });
  });

  it('adds and edits a manual sleep from the history heart graph', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });
    const createManualSleepSpy = jest.spyOn(repository, 'createManualSleep');
    const updateSleepSpy = jest.spyOn(repository, 'updateSleep');
    const screen = renderWithRepository(repository, <HistoryScreen />);

    await screen.findByTestId('history-heart-chart');
    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-add-activity-button')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-add-activity-button'));

    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-draft-type-activity')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-type-sleep')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-save')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-draft-type-sleep'));
    fireEvent.press(screen.getByTestId('history-heart-chart-draft-save'));

    await waitFor(() => {
      expect(createManualSleepSpy).toHaveBeenCalledTimes(1);
    });

    const createdSleepId = await createManualSleepSpy.mock.results[0]?.value;
    const [start, end] = createManualSleepSpy.mock.calls[0] ?? [];

    expect(createdSleepId).toMatch(/^sleep-/);
    expect(start).toBeInstanceOf(Date);
    expect(end).toBeInstanceOf(Date);
    expect((start as Date).getTime()).toBeLessThan((end as Date).getTime());

    await waitFor(() => {
      expect(screen.queryByTestId('history-heart-chart-draft-save')).toBeNull();
      expect(screen.getByTestId('history-heart-chart-title').props.children).toBe('Sleep');
      expect(screen.getByTestId('history-heart-chart-sleep-edit')).toBeTruthy();
      expect(screen.queryByTestId('history-heart-chart-add-activity-button')).toBeNull();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-sleep-edit'));

    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-draft-type-sleep')).toBeTruthy();
      expect(screen.queryByTestId('history-heart-chart-draft-type-activity')).toBeNull();
      expect(screen.getByTestId('history-heart-chart-draft-save')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-draft-save'));

    await waitFor(() => {
      expect(updateSleepSpy).toHaveBeenCalledTimes(1);
    });

    expect(updateSleepSpy.mock.calls[0]?.[0]).toBe(createdSleepId);
  });

  it('restores the idle add activity action when changing days after focusing a saved history activity', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });
    const createManualActivitySpy = jest.spyOn(repository, 'createManualActivity');
    const screen = renderWithRepository(repository, <HistoryScreen />);

    await screen.findByTestId('history-heart-chart');
    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-add-activity-button')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-add-activity-button'));

    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-draft-type-workout')).toBeTruthy();
      expect(screen.getByTestId('history-heart-chart-draft-save')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('history-heart-chart-draft-type-workout'));
    fireEvent.press(screen.getByTestId('history-heart-chart-draft-save'));

    await waitFor(() => {
      expect(createManualActivitySpy).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await createManualActivitySpy.mock.results[0]?.value;
    });

    await waitFor(() => {
      expect(screen.getByTestId('history-heart-chart-return-button')).toBeTruthy();
      expect(screen.queryByTestId('history-heart-chart-add-activity-button')).toBeNull();
    });

    const initialDayLabel = String(screen.getByTestId('history-selected-day-label').props.children);
    const newerButton = screen.getByTestId('history-day-forward-button');
    const olderButton = screen.getByTestId('history-day-backward-button');
    const dayNavigationButton = newerButton.props.disabled ? olderButton : newerButton;

    fireEvent.press(dayNavigationButton);

    await waitFor(() => {
      expect(String(screen.getByTestId('history-selected-day-label').props.children)).not.toBe(initialDayLabel);
      expect(screen.getByTestId('history-heart-chart-add-activity-button')).toBeTruthy();
      expect(screen.queryByTestId('history-heart-chart-return-button')).toBeNull();
    });
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

  it('colors low sleep-score bars as alert values instead of the base chart accent', async () => {
    const repository = new MockHealthRepository({ delayMs: 0 });
    const sleepHistory = await repository.getSleepHistory('14d');

    jest.spyOn(repository, 'getSleepHistory').mockResolvedValue({
      ...sleepHistory,
      scoreTrend: [
        { label: 'Apr 10', value: 50 },
        { label: 'Apr 11', value: 84 },
        { label: 'Apr 12', value: 67 },
      ],
    });

    const screen = renderWithRepository(repository, <SleepScreen />);

    await screen.findByTestId('sleep-score-trend-chart');

    expect(normalizeSvgColor(screen.getByTestId('sleep-score-trend-chart-bar-0').props.fill)).toEqual(
      processColor(colors.alert),
    );
    expect(normalizeSvgColor(screen.getByTestId('sleep-score-trend-chart-bar-1').props.fill)).toEqual(
      processColor(colors.success),
    );
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

  it('keeps the sleep-stage summary static while scrubbing in the chart', async () => {
    const screen = renderWithProviders(<SleepScreen />);
    await screen.findByTestId('sleep-last-night-stage-chart');

    expect(await screen.findByText('Efficiency 91%')).toBeTruthy();
    expect(screen.getByText('Swipe across the bar to inspect each stage slice.')).toBeTruthy();

    applyChartSelection(screen, SleepStageChart, 'sleep-last-night-stage-chart', {
      endMinute: 32,
      index: 0,
      segment: { stage: 'light', minutes: 32 },
      startMinute: 0,
    });

    expect(screen.queryByText('Light sleep')).toBeNull();
    expect(screen.getByText('Swipe across the bar to inspect each stage slice.')).toBeTruthy();

    applyChartSelection(screen, SleepStageChart, 'sleep-last-night-stage-chart', null);

    expect(screen.getByText('Efficiency 91%')).toBeTruthy();
  });

  it('renders the wellness screen', async () => {
    const screen = renderWithProviders(<WellnessScreen />);

    expect(await screen.findByText('Stress')).toBeTruthy();
    expect(await screen.findByText('Recent Activity')).toBeTruthy();
  });

  it('reviews activity suggestions from the wellness screen', async () => {
    const screen = renderWithProviders(<WellnessScreen />);

    expect(await screen.findByText('Tempo Run')).toBeTruthy();
    expect(screen.getByTestId('wellness-activity-status-label-activity-tempo-run').props.children).toBe('Needs review');

    fireEvent.press(screen.getByTestId('wellness-activity-confirm-activity-tempo-run'));

    await waitFor(
      () => {
        expect(screen.queryByTestId('wellness-activity-confirm-activity-tempo-run')).toBeNull();
        expect(screen.getByTestId('wellness-activity-status-label-activity-tempo-run').props.children).toBe('Confirmed');
      },
      { timeout: 3000 },
    );

    fireEvent.press(screen.getByTestId('wellness-activity-relabel-activity-mobility-reset'));

    expect(await screen.findByTestId('wellness-relabel-modal')).toBeTruthy();

    fireEvent.press(screen.getByTestId('wellness-relabel-option-walk'));

    await waitFor(
      () => {
        expect(screen.queryByText('Mobility Reset')).toBeNull();
        expect(screen.getByText('Walk')).toBeTruthy();
        expect(screen.getByTestId('wellness-activity-status-label-activity-mobility-reset').props.children).toBe('Relabelled');
      },
      { timeout: 3000 },
    );

    fireEvent.press(screen.getByTestId('wellness-activity-dismiss-activity-evening-walk'));

    await waitFor(
      () => {
        expect(screen.queryByText('Evening Walk')).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it('adds manual activities from the wellness screen', async () => {
    const screen = renderWithProviders(<WellnessScreen />);

    expect(await screen.findByText('Recent Activity')).toBeTruthy();

    fireEvent.press(screen.getByTestId('wellness-add-manual-button'));

    expect(await screen.findByTestId('wellness-manual-modal')).toBeTruthy();

    fireEvent.press(screen.getByTestId('wellness-manual-type-nap'));
    fireEvent.changeText(screen.getByTestId('wellness-manual-start-input'), '2026-04-23 14:00');
    fireEvent.changeText(screen.getByTestId('wellness-manual-end-input'), '2026-04-23 14:35');
    fireEvent.press(screen.getByTestId('wellness-manual-save-button'));

    await waitFor(
      () => {
        expect(screen.queryByTestId('wellness-manual-modal')).toBeNull();
        expect(screen.getByText('Nap')).toBeTruthy();
        expect(screen.getByTestId('wellness-activity-status-label-manual-1').props.children).toBe('Manual');
      },
      { timeout: 3000 },
    );
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
    expect(screen.getByText('Database Maintenance')).toBeTruthy();
    expect(screen.getByText('Rescan Activities')).toBeTruthy();
    expect(screen.getByText('Run Database Maintenance')).toBeTruthy();
    expect(screen.getByText('Local Data')).toBeTruthy();
    expect(screen.getByText('Remove all data')).toBeTruthy();
    expect(screen.getByText('Battery')).toBeTruthy();
    expect(screen.getAllByText('Status').length).toBeGreaterThan(0);
    expect(screen.getByText('Charge')).toBeTruthy();
    expect(screen.getByText('Wear')).toBeTruthy();
    expect(screen.getByText('Latest Sync Profile')).toBeTruthy();
    expect(screen.getByText('No sync profile has been recorded on this phone yet.')).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
    expect(screen.queryByText('Scan nearby')).toBeNull();
    expect(screen.queryByText('Scan Results')).toBeNull();
  });

  it('renders the latest sync profile summary on settings', () => {
    const screen = renderWithProviders(<SettingsScreen />, {
      backgroundSyncState: {
        lastSyncImportSummary: {
          source: 'foreground',
          status: 'success',
          capturedAt: '2026-04-09 11:15:00',
          totalMs: 12_345,
          connectMs: 1_200,
          historyRequestToCompleteMs: 10_800,
          historyReceiveMs: 9_400,
          dbFlushMsTotal: 1_800,
          dbFlushMsAvg: 300,
          dbFlushMsMax: 450,
          ackWaitMsTotal: 120,
          ackWaitMsAvg: 40,
          ackWaitMsMax: 75,
          importedRows: 10_000,
          persistedRows: 9_850,
          flushCount: 6,
          flushRowsTotal: 9_850,
          historyEndCount: 3,
          ackSentCount: 3,
          maxPendingRows: 500,
          rowsPerSecReceive: 1_064,
          rowsPerSecPersist: 5_472,
          suspectedBottleneck: 'ble',
          error: null,
        },
      },
    });

    expect(screen.getByText('Foreground')).toBeTruthy();
    expect(screen.getByText('BLE')).toBeTruthy();
    expect(screen.getByText('12.3 s')).toBeTruthy();
    expect(screen.getByText('10,000')).toBeTruthy();
    expect(screen.getByText(/Recorded 2026-04-09 11:15:00/)).toBeTruthy();
    expect(screen.getByText(/Receive throughput 1,064\/s/)).toBeTruthy();
  });

  it('runs database maintenance from settings when explicitly requested', async () => {
    const db = {
      getAllAsync: jest.fn(async () => []),
    };
    mockUseOptionalAppDatabase.mockReturnValue(db);
    mockInspectDatabaseMaintenance.mockImplementationOnce(async () => ({
      heartRateHasImuColumn: true,
      pageCount: 100,
      pageSizeBytes: 4096,
      freelistCount: 50,
      sizeBytes: 409600,
      freeBytes: 204800,
      needsMaintenance: true,
    }));
    mockRunDatabaseMaintenance.mockImplementationOnce(async () => ({
      ran: true,
      migratedLegacyHeartRate: true,
      vacuumed: true,
      sizeBytesBefore: 409600,
      sizeBytesAfter: 204800,
      freeBytesBefore: 204800,
      freeBytesAfter: 0,
      reclaimedBytes: 204800,
    }));

    const screen = renderWithProviders(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Run Database Maintenance'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockInspectDatabaseMaintenance).toHaveBeenCalledWith(db);
      expect(mockRunDatabaseMaintenance).toHaveBeenCalledWith(db);
      expect(screen.getByText(/removed the legacy IMU schema and reclaimed 200.0 KB/)).toBeTruthy();
    });
  });

  it('rescans activities from settings when explicitly requested', async () => {
    const repository = new RescanTrackingMockHealthRepository({ delayMs: 0 });
    const screen = renderWithRepository(repository, <SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Rescan Activities'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(repository.rescanActivitiesCalls).toBe(1);
      expect(screen.getByText(/Removed 3 unconfirmed detected activities and rescanned local activity history/)).toBeTruthy();
    });
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

  it('removes all local data from settings after confirming the destructive action', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const destructiveAction = buttons?.find((button) => button.style === 'destructive');
      destructiveAction?.onPress?.();
    });
    const screen = renderWithProviders(<SettingsScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('Remove all data'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockClearAllLocalData).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    alertSpy.mockRestore();
  });

  it('forgets the selected wearable before removing all local data', async () => {
    const forgetDevice = jest.fn(async () => {});
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const destructiveAction = buttons?.find((button) => button.style === 'destructive');
      destructiveAction?.onPress?.();
    });
    const screen = renderWithProviders(<SettingsScreen />, {
      deviceState: {
        id: 'strap-1',
        name: 'Neo Strap',
      },
      forgetDevice,
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Remove all data'));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(forgetDevice).toHaveBeenCalledTimes(1);
      expect(mockClearAllLocalData).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    alertSpy.mockRestore();
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

  it('lets the pairing screen continue with seeded data when no wearable is selected', async () => {
    const loadSeededData = jest.fn(async () => {});
    const screen = renderWithProviders(<PairWearableScreen />, {
      loadSeededData,
      progress: {
        status: 'idle',
        message: 'Select a wearable.',
      },
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Use seeded data'));
    });

    expect(loadSeededData).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('does not navigate away from pairing directly while seeded-data loading is still in progress', async () => {
    let resolveSeededDataLoad: (() => void) | null = null;
    const loadSeededData = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSeededDataLoad = resolve;
        }),
    );
    const screen = renderWithProviders(<PairWearableScreen />, {
      loadSeededData,
      progress: {
        status: 'idle',
        message: 'Select a wearable.',
      },
    });

    fireEvent.press(screen.getByText('Use seeded data'));

  expect(loadSeededData).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();

    await act(async () => {
      resolveSeededDataLoad?.();
      await Promise.resolve();
    });

    expect(mockReplace).not.toHaveBeenCalled();
  });
});
