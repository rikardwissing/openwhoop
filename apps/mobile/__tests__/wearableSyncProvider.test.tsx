import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View } from 'react-native';
import type { DeviceState, WearableLiveEvent } from '@/types/device';

const mockRefreshHealthData = jest.fn();
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

jest.mock('@/services/ble/WearableSyncService', () => ({
  WearableSyncService: jest.fn().mockImplementation(() => {
    const service = mockCreateWearableSyncService();
    mockServiceInstances.push(service);
    return service;
  }),
}));

import { WearableSyncProvider, useWearableSync } from '@/providers/WearableSyncProvider';

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

function renderProviderHarness() {
  return render(
    <WearableSyncProvider>
      <EventHarness />
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

describe('WearableSyncProvider live events', () => {
  beforeEach(() => {
    mockRefreshHealthData.mockClear();
    mockHealthRepository.invalidateCaches.mockClear();
    mockHealthRepository.warmCaches.mockClear();
    mockUseSQLiteContext.mockClear();
    mockUseSQLiteContext.mockReturnValue({});
    mockServiceInstances.length = 0;
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
});
