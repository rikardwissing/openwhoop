import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Pressable, Text, View } from 'react-native';
import type { DeviceState, SyncProgress, WearableLiveEvent } from '@/types/device';

const mockRefreshHealthData = jest.fn();
const appStateListeners = new Set<(nextState: string) => void>();
const mockAppState = {
  currentState: 'active',
};
const mockHealthRepository = {
  invalidateCaches: jest.fn(),
  getDerivedRefreshState: jest.fn(async () => ({
    status: 'idle',
    pendingFromTime: null,
    pendingToTime: null,
    lastProcessedFromTime: null,
    lastProcessedToTime: null,
    lastError: null,
    isFirstSync: false,
  })),
  processPendingDerivedRefresh: jest.fn(async () => false),
  rescanActivities: jest.fn(async () => ({ removedUnconfirmedActivities: 0 })),
};
const mockUseSQLiteContext = jest.fn(() => ({}));
const mockFreshBackgroundDb = {
  closeAsync: jest.fn(async () => {}),
};
const mockOpenAppDatabaseAsync = jest.fn(async () => mockFreshBackgroundDb);
const mockLoadSeededDatabase = jest.fn(async () => {});
const mockServiceInstances: Array<ReturnType<typeof mockCreateWearableSyncService>> = [];

function createEmptyDeviceState(): DeviceState {
  return {
    id: null,
    name: null,
    lastSeenAt: null,
    lastSyncedAt: null,
    firmware: null,
    batteryPercent: null,
    chargingStatus: null,
    bodyStatus: null,
    liveHeartRate: null,
    liveHeartRateAt: null,
    syncError: null,
  };
}

type MockDeviceState = ReturnType<typeof createEmptyDeviceState>;
type MockLiveEventCallback = (event: WearableLiveEvent) => void;
type MockDeviceStateCallback = (state: MockDeviceState) => void;

function mockCreateWearableSyncService() {
  let currentState: MockDeviceState = {
    ...createEmptyDeviceState(),
    id: 'strap-1',
    name: 'Neo Strap',
  };
  let liveStateCallback: MockDeviceStateCallback | null = null;
  let liveEventCallback: MockLiveEventCallback | null = null;

  return {
    getDeviceState: jest.fn(async () => ({ ...currentState })),
    startLiveUpdates: jest.fn(async (onDeviceState: MockDeviceStateCallback, onLiveEvent?: MockLiveEventCallback) => {
      liveStateCallback = onDeviceState;
      liveEventCallback = onLiveEvent ?? null;
    }),
    stopLiveUpdates: jest.fn(async () => {
      liveStateCallback = null;
      liveEventCallback = null;
    }),
    scan: jest.fn(async () => []),
    selectDevice: jest.fn(async (device: { id: string; name: string }) => {
      currentState = {
        ...createEmptyDeviceState(),
        id: device.id,
        name: device.name,
      };
      liveStateCallback?.({ ...currentState });
    }),
    forgetDevice: jest.fn(async () => {
      currentState = createEmptyDeviceState();
      liveStateCallback?.({ ...currentState });
    }),
    syncSelected: jest.fn(async (..._args: unknown[]) => ({
      importedReadings: 0,
      completedAt: '2026-04-02 10:00:00',
    })),
    restartDevice: jest.fn(async () => {}),
    setAlarm: jest.fn(async () => {}),
    disableAlarm: jest.fn(async () => {}),
    dispose: jest.fn(async () => {}),
    emitLiveEvent(event: WearableLiveEvent) {
      liveEventCallback?.(event);
    },
  };
}

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: () => mockUseSQLiteContext(),
}));

jest.mock('@/db/appDatabase', () => ({
  openAppDatabaseAsync: () => mockOpenAppDatabaseAsync(),
}));

jest.mock('@/providers/AppDatabaseProvider', () => ({
  useAppDatabaseControls: () => ({
    loadSeededData: mockLoadSeededDatabase,
    clearAllLocalData: jest.fn(async () => {}),
  }),
}));

jest.mock('@/providers/HealthDataProvider', () => ({
  useHealthRepository: () => mockHealthRepository,
  useRefreshHealthData: () => mockRefreshHealthData,
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

jest.mock('@/services/ble/WearableSyncService', () => ({
  WearableSyncService: jest.fn().mockImplementation(() => {
    const service = mockCreateWearableSyncService();
    mockServiceInstances.push(service);
    return service;
  }),
}));

import {
  WearableSyncProvider,
  useWearableLiveEvents,
  useWearableSync,
  useWearableSyncActions,
  useWearableSyncProgress,
  useWearableSyncState,
} from '@/providers/WearableSyncProvider';
import { getBackgroundSyncState } from '@/services/background/backgroundSyncState';

const mockGetBackgroundSyncState = jest.mocked(getBackgroundSyncState);

function buildLiveEvent(index: number): WearableLiveEvent {
  return {
    id: `event-${index}`,
    observedAt: '2026-04-02 10:00:00',
    deviceUnixMs: null,
    source: index % 2 === 0 ? 'event' : 'command',
    kind: `kind-${index}`,
    title: `Event ${index}`,
    detail: index % 3 === 0 ? `Detail ${index}` : null,
  };
}

function EventHarness() {
  const { liveEvents, selectDevice, forgetDevice } = useWearableSync();

  return (
    <View>
      <Text testID="count">{String(liveEvents.length)}</Text>
      <Text testID="first-title">{liveEvents[0]?.title ?? '--'}</Text>
      <Text testID="last-title">{liveEvents[liveEvents.length - 1]?.title ?? '--'}</Text>
      <Pressable
        testID="select-device"
        onPress={() => {
          void selectDevice({ id: 'strap-2', name: 'Night Strap', rssi: -52 });
        }}
      />
      <Pressable
        testID="forget-device"
        onPress={() => {
          void forgetDevice();
        }}
      />
    </View>
  );
}

function ProgressHarness() {
  const { progress } = useWearableSync();

  return (
    <View>
      <Text testID="progress-status">{progress.status}</Text>
      <Text testID="progress-show-overlay">{String(progress.showOverlay)}</Text>
    </View>
  );
}

let deviceOnlyRenderCount = 0;
let liveEventsOnlyRenderCount = 0;
let progressOnlyRenderCount = 0;

function DeviceOnlyHarness() {
  deviceOnlyRenderCount += 1;
  const { deviceState } = useWearableSyncState();

  return <Text testID="device-only-name">{deviceState.name ?? '--'}</Text>;
}

function LiveEventsOnlyHarness() {
  liveEventsOnlyRenderCount += 1;
  const { liveEvents } = useWearableLiveEvents();

  return <Text testID="live-events-only-count">{String(liveEvents.length)}</Text>;
}

function ProgressOnlyHarness() {
  progressOnlyRenderCount += 1;
  const { progress } = useWearableSyncProgress();

  return <Text testID="progress-only-status">{progress.status}</Text>;
}

function SyncActionHarness() {
  const { syncSelected } = useWearableSyncActions();

  return (
    <Pressable
      testID="isolated-run-sync"
      onPress={() => {
        void syncSelected({ showOverlay: false });
      }}
    />
  );
}

function SeededDataHarness() {
  const { progress } = useWearableSyncProgress();
  const { loadSeededData } = useWearableSyncActions();

  return (
    <View>
      <Text testID="seeded-progress-status">{progress.status}</Text>
      <Text testID="seeded-progress-message">{progress.message}</Text>
      <Pressable
        testID="enable-seeded-data"
        onPress={() => {
          void loadSeededData();
        }}
      />
    </View>
  );
}

function renderProviderHarness() {
  return render(
    <WearableSyncProvider>
      <EventHarness />
    </WearableSyncProvider>,
  );
}

function renderProgressHarness() {
  return render(
    <WearableSyncProvider>
      <ProgressHarness />
    </WearableSyncProvider>,
  );
}

function renderSeededDataHarness() {
  return render(
    <WearableSyncProvider>
      <SeededDataHarness />
    </WearableSyncProvider>,
  );
}

function latestService() {
  const service = mockServiceInstances.at(-1);
  if (!service) {
    throw new Error('Mock wearable sync service was not created.');
  }
  return service;
}

function emitAppStateChange(nextState: string) {
  mockAppState.currentState = nextState;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: nextState,
  });
  for (const listener of appStateListeners) {
    listener(nextState);
  }
}

async function flushAsyncState() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTimersAndFlush(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('WearableSyncProvider live events', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockRefreshHealthData.mockClear();
    mockHealthRepository.invalidateCaches.mockClear();
    mockHealthRepository.getDerivedRefreshState.mockClear();
    mockHealthRepository.processPendingDerivedRefresh.mockClear();
    mockUseSQLiteContext.mockClear();
    mockUseSQLiteContext.mockReturnValue({});
    mockOpenAppDatabaseAsync.mockClear();
    mockFreshBackgroundDb.closeAsync.mockClear();
    mockLoadSeededDatabase.mockClear();
    mockGetBackgroundSyncState.mockClear();
    mockServiceInstances.length = 0;
    mockAppState.currentState = 'active';
    appStateListeners.clear();
    deviceOnlyRenderCount = 0;
    liveEventsOnlyRenderCount = 0;
    progressOnlyRenderCount = 0;
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((eventType, listener) => {
      if (eventType === 'change') {
        appStateListeners.add(listener as (nextState: string) => void);
      }

      return {
        remove: () => {
          appStateListeners.delete(listener as (nextState: string) => void);
        },
      };
    });
    jest.useRealTimers();
  });

  it('keeps the latest 200 live events in newest-first order', async () => {
    const screen = renderProviderHarness();
    const service = latestService();

    await waitFor(() => {
      expect(service.startLiveUpdates).toHaveBeenCalledTimes(1);
    });

    act(() => {
      for (let index = 1; index <= 205; index += 1) {
        service.emitLiveEvent(buildLiveEvent(index));
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('count').props.children).toBe('200');
    });

    expect(screen.getByTestId('first-title').props.children).toBe('Event 205');
    expect(screen.getByTestId('last-title').props.children).toBe('Event 6');
  });

  it('resets the session log when selecting a new device or forgetting the current one', async () => {
    const screen = renderProviderHarness();
    const service = latestService();

    await waitFor(() => {
      expect(service.startLiveUpdates).toHaveBeenCalledTimes(1);
    });

    act(() => {
      service.emitLiveEvent(buildLiveEvent(1));
    });

    await waitFor(() => {
      expect(screen.getByTestId('count').props.children).toBe('1');
    });

    fireEvent.press(screen.getByTestId('select-device'));

    await waitFor(() => {
      expect(service.selectDevice).toHaveBeenCalledWith({
        id: 'strap-2',
        name: 'Night Strap',
        rssi: -52,
      });
      expect(screen.getByTestId('count').props.children).toBe('0');
    });

    await waitFor(() => {
      expect(service.startLiveUpdates).toHaveBeenCalledTimes(2);
    });

    act(() => {
      service.emitLiveEvent(buildLiveEvent(2));
    });

    await waitFor(() => {
      expect(screen.getByTestId('count').props.children).toBe('1');
    });

    fireEvent.press(screen.getByTestId('forget-device'));

    await waitFor(() => {
      expect(service.forgetDevice).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('count').props.children).toBe('0');
    });
  });

  it('starts with a clear local state until seeded data is explicitly requested', async () => {
    const screen = renderSeededDataHarness();

    expect(screen.getByTestId('seeded-progress-message').props.children).toBe(
      'Select a wearable and run a manual sync.',
    );
    expect(mockLoadSeededDatabase).not.toHaveBeenCalled();
  });

  it('loads bundled seeded data only when the explicit action is invoked', async () => {
    const screen = renderSeededDataHarness();

    fireEvent.press(screen.getByTestId('enable-seeded-data'));

    await waitFor(() => {
      expect(mockLoadSeededDatabase).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('seeded-progress-status').props.children).toBe('refreshing');
    });
  });

  it('automatically syncs while the app stays active', async () => {
    jest.useFakeTimers();

    renderProviderHarness();
    const service = latestService();

    await flushAsyncState();

    await advanceTimersAndFlush(5_000);

    expect(service.syncSelected).toHaveBeenCalledTimes(1);
  });

  it('keeps foreground auto-sync progress discreet without showing the overlay', async () => {
    jest.useFakeTimers();

    const screen = renderProgressHarness();
    const service = latestService();
    service.syncSelected.mockImplementationOnce(async (...args: unknown[]) => {
      const onProgress = args[0] as ((progress: SyncProgress) => void) | undefined;

      if (!onProgress) {
        throw new Error('Expected syncSelected progress callback during auto-sync test.');
      }

      onProgress({
        status: 'connecting',
        message: 'Connecting in foreground auto-sync...',
      });
      return {
        importedReadings: 3,
        completedAt: '2026-04-02 10:05:00',
      };
    });

    await flushAsyncState();
    await advanceTimersAndFlush(5_000);

    await waitFor(() => {
      expect(screen.getByTestId('progress-status').props.children).toBe('connecting');
      expect(screen.getByTestId('progress-show-overlay').props.children).toBe('false');
    });
  });

  it('waits for the app to become active again before auto-syncing', async () => {
    jest.useFakeTimers();

    renderProviderHarness();
    const service = latestService();

    await flushAsyncState();

    act(() => {
      emitAppStateChange('background');
    });

    await flushAsyncState();
    await advanceTimersAndFlush(30_000);

    expect(service.syncSelected).not.toHaveBeenCalled();

    act(() => {
      emitAppStateChange('active');
    });

    await flushAsyncState();
    await advanceTimersAndFlush(5_000);

    expect(service.syncSelected).toHaveBeenCalledTimes(1);
  });

  it('does not rerender device-only consumers when live events change', async () => {
    const screen = render(
      <WearableSyncProvider>
        <DeviceOnlyHarness />
        <LiveEventsOnlyHarness />
      </WearableSyncProvider>,
    );
    const service = latestService();

    await waitFor(() => {
      expect(service.startLiveUpdates).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('device-only-name').props.children).toBe('Neo Strap');
    });

    const deviceBaseline = deviceOnlyRenderCount;
    const liveBaseline = liveEventsOnlyRenderCount;

    act(() => {
      service.emitLiveEvent(buildLiveEvent(1));
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-events-only-count').props.children).toBe('1');
    });

    expect(liveEventsOnlyRenderCount).toBeGreaterThan(liveBaseline);
    expect(deviceOnlyRenderCount).toBe(deviceBaseline);
  });

  it('does not rerender live-event-only consumers when sync progress changes', async () => {
    const screen = render(
      <WearableSyncProvider>
        <LiveEventsOnlyHarness />
        <ProgressOnlyHarness />
        <SyncActionHarness />
      </WearableSyncProvider>,
    );
    const service = latestService();
    service.syncSelected.mockImplementationOnce(async (...args: unknown[]) => {
      const onProgress = args[0] as ((progress: SyncProgress) => void) | undefined;

      onProgress?.({
        status: 'connecting',
        message: 'Connecting in isolated render test...',
      });

      return {
        importedReadings: 2,
        completedAt: '2026-04-02 10:05:00',
      };
    });

    await flushAsyncState();

    const liveBaseline = liveEventsOnlyRenderCount;
    const progressBaseline = progressOnlyRenderCount;

    fireEvent.press(screen.getByTestId('isolated-run-sync'));

    await waitFor(() => {
      expect(screen.getByTestId('progress-only-status').props.children).toBe('connecting');
    });

    expect(progressOnlyRenderCount).toBeGreaterThan(progressBaseline);
    expect(liveEventsOnlyRenderCount).toBe(liveBaseline);
  });

});
