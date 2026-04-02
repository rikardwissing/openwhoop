import { render, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
let mockSegments: string[] = ['(tabs)', 'index'];

jest.mock('expo-router', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
  useSegments: () => mockSegments,
}));

import { WearablePairingGate } from '@/components/navigation/WearablePairingGate';
import {
  WearableSyncContextProvider,
  defaultWearableSyncContextValue,
} from '@/providers/WearableSyncProvider';
import type { DeviceState, SyncProgress } from '@/types/device';

function renderGate(overrides: Partial<{
  isReady: boolean;
  deviceState: DeviceState;
  progress: SyncProgress;
}> = {}) {
  return render(
    <WearableSyncContextProvider
      value={{
        ...defaultWearableSyncContextValue,
        ...overrides,
        deviceState: {
          ...defaultWearableSyncContextValue.deviceState,
          ...overrides.deviceState,
        },
      }}>
      <WearablePairingGate />
    </WearableSyncContextProvider>,
  );
}

function pairedDeviceState(): DeviceState {
  return {
    ...defaultWearableSyncContextValue.deviceState,
    id: 'strap-1',
    name: 'Neo Strap',
  };
}

describe('WearablePairingGate', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSegments = ['(tabs)', 'index'];
  });

  it('redirects unpaired app state to the pairing route', async () => {
    renderGate({
      isReady: true,
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/pair-wearable');
    });
  });

  it('does not redirect paired app state away from the tabs', async () => {
    renderGate({
      isReady: true,
      deviceState: pairedDeviceState(),
    });

    await waitFor(() => {
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  it('returns from the pairing route after a device is selected', async () => {
    mockSegments = ['pair-wearable'];

    renderGate({
      isReady: true,
      deviceState: pairedDeviceState(),
    });

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
  });

  it('stays on the pairing route while the initial sync is still running', async () => {
    mockSegments = ['pair-wearable'];

    renderGate({
      isReady: true,
      deviceState: pairedDeviceState(),
      progress: {
        status: 'syncing',
        message: 'Syncing initial wearable data...',
      },
    });

    await waitFor(() => {
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  it('redirects to pairing when a selected device is forgotten', async () => {
    const screen = renderGate({
      isReady: true,
      deviceState: pairedDeviceState(),
    });

    mockReplace.mockClear();

    screen.rerender(
      <WearableSyncContextProvider
        value={{
          ...defaultWearableSyncContextValue,
          isReady: true,
          deviceState: {
            ...defaultWearableSyncContextValue.deviceState,
          },
        }}>
        <WearablePairingGate />
      </WearableSyncContextProvider>,
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/pair-wearable');
    });
  });
});
