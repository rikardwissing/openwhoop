jest.mock('react-native-ble-plx', () => ({
  BleManager: class {
    destroy() {}
  },
}));

import { CMD_FROM_STRAP_UUID, CommandNumber, EVENTS_FROM_STRAP_UUID, EventNumber, PacketType } from '@/services/ble/constants';
import { PacketAssembler, base64ToBytes, bytesToBase64, framePacket } from '@/services/ble/codec';
import { WearableSyncService } from '@/services/ble/WearableSyncService';

function writeU16LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

type DeviceMonitor = (error: Error | null, value: { value: string } | null) => void;

class MockDevice {
  id = 'strap-1';
  name = 'Neo Strap';
  localName = 'Neo Strap';
  rssi = -45;
  batteryTenthsPercent: number | null = null;
  bodyStatusRaw: 0 | 1 | null = null;
  failBatteryRequest = false;
  private readonly monitors = new Map<string, Set<DeviceMonitor>>();

  async discoverAllServicesAndCharacteristics() {
    return this;
  }

  async cancelConnection() {}

  monitorCharacteristicForService(_service: string, characteristic: string, listener: DeviceMonitor) {
    const listeners = this.monitors.get(characteristic) ?? new Set<DeviceMonitor>();
    listeners.add(listener);
    this.monitors.set(characteristic, listeners);

    return {
      remove: () => {
        listeners.delete(listener);
      },
    };
  }

  async writeCharacteristicWithoutResponseForService(_service: string, _characteristic: string, value: string) {
    const assembler = new PacketAssembler();
    const [packet] = assembler.push(base64ToBytes(value));

    if (!packet) {
      return;
    }

    if (packet.cmd === CommandNumber.GetBatteryLevel) {
      if (this.failBatteryRequest) {
        throw new Error('Battery request failed.');
      }

      if (this.batteryTenthsPercent === null) {
        return;
      }

      const payload = new Uint8Array(4);
      writeU16LE(payload, 2, this.batteryTenthsPercent);
      this.emitFrame(CMD_FROM_STRAP_UUID, framePacket(PacketType.CommandResponse, 0, CommandNumber.GetBatteryLevel, payload));
      return;
    }

    if (packet.cmd === CommandNumber.GetBodyLocationAndStatus && this.bodyStatusRaw !== null) {
      const payload = Uint8Array.from([0x00, 0x00, this.bodyStatusRaw]);
      this.emitFrame(
        CMD_FROM_STRAP_UUID,
        framePacket(PacketType.CommandResponse, 0, CommandNumber.GetBodyLocationAndStatus, payload),
      );
    }
  }

  emitEvent(event: EventNumber, payload: Uint8Array = new Uint8Array()) {
    const data = new Uint8Array(1 + 4 + payload.length);
    data[0] = 0x00;
    writeU32LE(data, 1, 1_710_000_000);
    data.set(payload, 5);
    this.emitFrame(EVENTS_FROM_STRAP_UUID, framePacket(PacketType.Event, 0, event, data));
  }

  private emitFrame(characteristic: string, frame: Uint8Array) {
    const response = { value: bytesToBase64(frame) };
    for (const listener of this.monitors.get(characteristic) ?? []) {
      listener(null, response);
    }
  }
}

class MockBleManager {
  constructor(private readonly device: MockDevice) {}

  async state() {
    return 'PoweredOn';
  }

  onStateChange() {
    return { remove: () => {} };
  }

  stopDeviceScan() {}

  async devices(ids: string[]) {
    return ids.includes(this.device.id) ? [this.device] : [];
  }

  async connectedDevices() {
    return [];
  }

  async cancelDeviceConnection() {}

  async connectToDevice() {
    return this.device;
  }

  startDeviceScan() {}

  destroy() {}
}

class MockDb {
  row: {
    id: string;
    name: string | null;
    last_seen_at: string | null;
    last_synced_at: string | null;
    firmware: string | null;
    battery_percent: number | null;
    charging_status: 'charging' | 'not_charging' | null;
    body_status: 'on-body' | 'off-body' | null;
    sync_error: string | null;
  } | null;

  constructor(initialBatteryPercent: number | null) {
    this.row = {
      id: 'strap-1',
      name: 'Neo Strap',
      last_seen_at: '2026-04-02 08:00:00',
      last_synced_at: '2026-04-02 07:00:00',
      firmware: '1.2.3',
      battery_percent: initialBatteryPercent,
      charging_status: null,
      body_status: null,
      sync_error: null,
    };
  }

  async getFirstAsync<T>() {
    return (this.row ? { ...this.row } : null) as T | null;
  }

  async execAsync(sql: string) {
    if (sql.includes('DELETE FROM device_state')) {
      this.row = null;
    }
  }

  async runAsync(sql: string, ...args: Array<string | number | null>) {
    if (!this.row) {
      return;
    }

    if (sql.startsWith('UPDATE device_state SET battery_percent')) {
      this.row.battery_percent = args[0] as number;
      this.row.last_seen_at = args[1] as string;
      return;
    }

    if (!sql.includes('INSERT INTO device_state')) {
      return;
    }

    this.row = {
      id: args[0] as string,
      name: (args[1] as string | null) ?? this.row.name,
      last_seen_at: args[2] as string,
      last_synced_at: (args[3] as string | null) ?? this.row.last_synced_at,
      firmware: (args[4] as string | null) ?? this.row.firmware,
      battery_percent: (args[5] as number | null) ?? this.row.battery_percent,
      charging_status: (args[6] as 'charging' | 'not_charging' | null) ?? this.row.charging_status,
      body_status: (args[7] as 'on-body' | 'off-body' | null) ?? this.row.body_status,
      sync_error: (args[8] as string | null) ?? null,
    };
  }
}

describe('WearableSyncService battery refresh', () => {
  it('updates stored battery percent after setting an alarm', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    await service.setAlarm(1_710_000_123);

    await expect(service.getDeviceState()).resolves.toMatchObject({
      batteryPercent: 85,
    });
  });

  it('does not fail alarm actions when the battery request fails', async () => {
    const device = new MockDevice();
    device.failBatteryRequest = true;
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    await expect(service.disableAlarm()).resolves.toBeUndefined();
    await expect(service.getDeviceState()).resolves.toMatchObject({
      batteryPercent: null,
      syncError: null,
    });
  });

  it('preserves the previous battery percent when no new battery response arrives', async () => {
    const device = new MockDevice();
    const db = new MockDb(71);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    await service.setAlarm(1_710_000_123);

    await expect(service.getDeviceState()).resolves.toMatchObject({
      batteryPercent: 71,
    });
  });

  it('listens to live battery, charging, and wear events while connected', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.bodyStatusRaw = 1;
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);
    const updates: Array<Awaited<ReturnType<typeof service.getDeviceState>>> = [];

    await service.startLiveUpdates((nextState) => {
      updates.push(nextState);
    });

    const batteryEventPayload = new Uint8Array(24);
    writeU16LE(batteryEventPayload, 2, 20);
    batteryEventPayload[4] = 0x01;
    writeU16LE(batteryEventPayload, 5, 320);

    device.emitEvent(EventNumber.ChargingOn);
    device.emitEvent(EventNumber.WristOff);
    device.emitEvent(EventNumber.BatteryLevel, batteryEventPayload);

    await Promise.resolve();
    await Promise.resolve();

    await expect(service.getDeviceState()).resolves.toMatchObject({
      batteryPercent: 32,
      chargingStatus: 'charging',
      bodyStatus: 'off-body',
    });
    expect(updates.some((state) => state.batteryPercent === 85)).toBe(true);
    expect(updates.some((state) => state.bodyStatus === 'on-body')).toBe(true);

    await service.stopLiveUpdates();
  });
});
