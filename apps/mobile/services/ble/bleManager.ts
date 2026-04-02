import { BleManager, type BleRestoredState, type Device } from 'react-native-ble-plx';

const RESTORE_STATE_IDENTIFIER = 'btwearable-ble-manager';
const restoredDevices = new Map<string, Device>();

function cacheRestoredState(restoredState: BleRestoredState | null) {
  restoredDevices.clear();

  for (const device of restoredState?.connectedPeripherals ?? []) {
    restoredDevices.set(device.id, device);
  }
}

export function createWearableBleManager() {
  return new BleManager({
    restoreStateIdentifier: RESTORE_STATE_IDENTIFIER,
    restoreStateFunction: cacheRestoredState,
  });
}

export function getRestoredWearableDevice(deviceId: string) {
  return restoredDevices.get(deviceId) ?? null;
}
