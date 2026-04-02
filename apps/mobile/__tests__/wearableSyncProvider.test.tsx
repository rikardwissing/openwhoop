import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Pressable, Text, View } from 'react-native';
import type { DeviceState, WearableLiveEvent } from '@/types/device';

const mockRefreshHealthData = jest.fn();
const appStateListeners = new Set<(nextState: string) => void>();
const mockAppState = {
  currentState: 'active',
};
const mockHealthRepository = {
  invalidateCaches: jest.fn(),
  warmCaches: jest.fn(async () => {}),
};
const mockUseSQLiteContext = jest.fn(() => ({}));
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
    syncSelected: jest.fn(async () => ({
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
  })),
}));

jest.mock('@/services/background/backgroundSyncTask', () => ({
  ensureBackgroundSyncRegistered: jest.fn(async () => {}),
  enableBackgroundSyncAfterPairing: jest.fn(async () => {}),
  disableBackgroundSync: jest.fn(async () => {}),
}));

jest.mock('@/services/ble/WearableSyncService', () => ({
  WearableSyncService: jest.fn().mockImplementation(() => {
    const service = mockCreateWearableSyncService();
    mockServiceInstances.push(service);
    return service;
  }),
}));

import { WearableSyncProvider, useWearableSync } from '@/providers/WearableSyncProvider';
import { getBackgroundSyncState } from '@/services/background/backgroundSyncState';
import {
  disableBackgroundSync,
  enableBackgroundSyncAfterPairing,
  ensureBackgroundSyncRegistered,
} from '@/services/background/backgroundSyncTask';

const mockGetBackgroundSyncState = jest.mocked(getBackgroundSyncState);
const mockEnsureBackgroundSyncRegistered = jest.mocked(ensureBackgroundSyncRegistered);
const mockEnableBackgroundSyncAfterPairing = jest.mocked(enableBackgroundSyncAfterPairing);
const mockDisableBackgroundSync = jest.mocked(disableBackgroundSync);

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

function BackgroundSyncHarness() {
  const { pairDevice, forgetDevice } = useWearableSync();

  return (
    <View>
      <Pressable
        testID="pair-device"
        onPress={() => {
          void pairDevice({ id: 'strap-9', name: 'Background Strap', rssi: -40 });
        }}
      />
      <Pressable
        testID="forget-selected-device"
        onPress={() => {
          void forgetDevice();
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

function renderBackgroundHarness() {
  return render(
    <WearableSyncProvider>
      <BackgroundSyncHarness />
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
    mockHealthRepository.warmCaches.mockClear();
    mockUseSQLiteContext.mockClear();
    mockUseSQLiteContext.mockReturnValue({});
    mockGetBackgroundSyncState.mockClear();
    mockEnsureBackgroundSyncRegistered.mockClear();
    mockEnableBackgroundSyncAfterPairing.mockClear();
    mockDisableBackgroundSync.mockClear();
    mockServiceInstances.length = 0;
    mockAppState.currentState = 'active';
    appStateListeners.clear();
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

  it('registers background sync when a wearable is already selected on launch', async () => {
    renderProviderHarness();

    await waitFor(() => {
      expect(mockEnsureBackgroundSyncRegistered).toHaveBeenCalledWith('strap-1');
    });
  });

  it('enables background sync after pairing succeeds', async () => {
    const screen = renderBackgroundHarness();

    fireEvent.press(screen.getByTestId('pair-device'));

    await waitFor(() => {
      expect(mockEnableBackgroundSyncAfterPairing).toHaveBeenCalledWith('strap-9');
    });
  });

  it('disables background sync when forgetting the selected wearable', async () => {
    const screen = renderBackgroundHarness();

    fireEvent.press(screen.getByTestId('forget-selected-device'));

    await waitFor(() => {
      expect(mockDisableBackgroundSync).toHaveBeenCalledTimes(1);
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

});
