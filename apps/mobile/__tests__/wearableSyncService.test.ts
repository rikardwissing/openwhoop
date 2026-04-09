jest.mock('react-native-ble-plx', () => ({
  BleManager: class {
    destroy() {}
  },
}));

jest.mock('@/data/sqlite/SQLiteHealthRepository', () => ({
  markDerivedRefreshPending: jest.fn(async () => {}),
  refreshHeartAggregatesForRange: jest.fn(async () => {}),
}));

import { markDerivedRefreshPending, refreshHeartAggregatesForRange } from '@/data/sqlite/SQLiteHealthRepository';
import { CMD_FROM_STRAP_UUID, CommandNumber, DATA_FROM_STRAP_UUID, EVENTS_FROM_STRAP_UUID, EventNumber, MetadataType, PacketType } from '@/services/ble/constants';
import { PacketAssembler, base64ToBytes, bytesToBase64, framePacket } from '@/services/ble/codec';
import { WearableSyncService } from '@/services/ble/WearableSyncService';
import type { WearableLiveEvent } from '@/types/device';
import { formatSqliteDateTime } from '@/utils/dateTime';

const mockMarkDerivedRefreshPending = jest.mocked(markDerivedRefreshPending);
const mockRefreshHeartAggregatesForRange = jest.mocked(refreshHeartAggregatesForRange);

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

function encodeAscii(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0));
}

function createVersionPayload(harvard = [1, 2, 3, 4], boylston = [5, 6, 7, 8]) {
  const payload = new Uint8Array(35);
  [...harvard, ...boylston].forEach((value, index) => {
    writeU32LE(payload, 3 + index * 4, value);
  });
  return payload;
}

function createHistoryPayload(unixSeconds: number, bpm = 64) {
  const payload = new Uint8Array(24);
  writeU32LE(payload, 4, unixSeconds);
  payload[14] = bpm;
  payload[15] = 0;
  return payload;
}

function createMetadataPayload(unixSeconds: number, data: number) {
  const payload = new Uint8Array(8);
  writeU32LE(payload, 0, unixSeconds);
  writeU32LE(payload, 4, data);
  return payload;
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
  historyFrames: Array<{ characteristic: string; frame: Uint8Array }> = [];
  historyAckFrames: Array<{ characteristic: string; frame: Uint8Array }> = [];
  sentCommands: number[] = [];
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

    this.sentCommands.push(packet.cmd);

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
      this.emitCommandResponse(CommandNumber.GetBodyLocationAndStatus, payload);
      return;
    }

    if (
      packet.cmd === CommandNumber.GetAdvertisingNameHarvard ||
      packet.cmd === CommandNumber.GetAdvertisingName
    ) {
      this.emitCommandResponse(packet.cmd, Uint8Array.from([...encodeAscii(this.name), 0x00]));
      return;
    }

    if (packet.cmd === CommandNumber.ReportVersionInfo) {
      this.emitCommandResponse(CommandNumber.ReportVersionInfo, createVersionPayload());
      return;
    }

    if (packet.cmd === CommandNumber.SendHistoricalData) {
      for (const entry of this.historyFrames) {
        this.emitFrame(entry.characteristic, entry.frame);
      }
      return;
    }

    if (packet.cmd === CommandNumber.HistoricalDataResult) {
      const frames = this.historyAckFrames;
      this.historyAckFrames = [];
      for (const entry of frames) {
        this.emitFrame(entry.characteristic, entry.frame);
      }
    }
  }

  emitEvent(event: EventNumber, payload: Uint8Array = new Uint8Array()) {
    const data = new Uint8Array(1 + 4 + payload.length);
    data[0] = 0x00;
    writeU32LE(data, 1, 1_710_000_000);
    data.set(payload, 5);
    this.emitFrame(EVENTS_FROM_STRAP_UUID, framePacket(PacketType.Event, 0, event, data));
  }

  emitCommandResponse(command: number, payload: Uint8Array) {
    this.emitFrame(CMD_FROM_STRAP_UUID, framePacket(PacketType.CommandResponse, 0, command, payload));
  }

  emitHistoryFrame(payload: Uint8Array) {
    this.emitFrame(DATA_FROM_STRAP_UUID, framePacket(PacketType.HistoricalData, 0, 0, payload));
  }

  emitRealtimeHeartRate(unixSeconds: number, bpm: number) {
    const payload = new Uint8Array(6);
    payload[0] = (unixSeconds >> 8) & 0xff;
    payload[1] = (unixSeconds >> 16) & 0xff;
    payload[2] = (unixSeconds >> 24) & 0xff;
    payload[3] = 0x00;
    payload[4] = 0x00;
    payload[5] = bpm;
    this.emitFrame(DATA_FROM_STRAP_UUID, framePacket(PacketType.RealtimeData, 0, unixSeconds & 0xff, payload));
  }

  emitMetadata(kind: MetadataType, payload: Uint8Array) {
    this.emitFrame(DATA_FROM_STRAP_UUID, framePacket(PacketType.Metadata, 0, kind, payload));
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

  constructor(
    initialBatteryPercent: number | null,
    initialChargingStatus: 'charging' | 'not_charging' | null = null,
  ) {
    this.row = {
      id: 'strap-1',
      name: 'Neo Strap',
      last_seen_at: '2026-04-02 08:00:00',
      last_synced_at: '2026-04-02 07:00:00',
      firmware: '1.2.3',
      battery_percent: initialBatteryPercent,
      charging_status: initialChargingStatus,
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

class BufferedHistoryDb extends MockDb {
  heartInsertCount = 0;
  exclusiveTransactionCount = 0;
  heartWriteTransactionCount = 0;
  failHeartWriteTransactionsRemaining = 0;

  async withExclusiveTransactionAsync<T>(
    callback: (tx: Pick<BufferedHistoryDb, 'getFirstAsync' | 'runAsync' | 'execAsync'>) => Promise<T>,
  ) {
    this.exclusiveTransactionCount += 1;
    let recordedHeartWrite = false;

    return callback({
      getFirstAsync: this.getFirstAsync.bind(this),
      execAsync: this.execAsync.bind(this),
      runAsync: async (sql: string, ...args: Array<string | number | null>) => {
        if (sql.includes('INSERT INTO heart_rate')) {
          if (!recordedHeartWrite) {
            recordedHeartWrite = true;
            this.heartWriteTransactionCount += 1;
          }

          if (this.failHeartWriteTransactionsRemaining > 0) {
            this.failHeartWriteTransactionsRemaining -= 1;
            throw new Error('database is locked');
          }
        }

        return this.runAsync(sql, ...args);
      },
    });
  }

  async getFirstAsync<T>(sql?: string) {
    if (sql?.includes('FROM background_sync_state')) {
      return null as T | null;
    }

    return super.getFirstAsync<T>();
  }

  async runAsync(sql: string, ...args: Array<string | number | null>) {
    if (sql.includes('INSERT INTO heart_rate')) {
      this.heartInsertCount += 1;
      return;
    }

    return super.runAsync(sql, ...args);
  }
}

class DelayedBufferedHistoryDb extends BufferedHistoryDb {
  private releaseNextHeartWritePromise: Promise<void> | null = null;
  private releaseNextHeartWriteResolve: (() => void) | null = null;

  blockNextHeartWrite() {
    this.releaseNextHeartWritePromise = new Promise<void>((resolve) => {
      this.releaseNextHeartWriteResolve = resolve;
    });
  }

  releaseNextHeartWrite() {
    this.releaseNextHeartWriteResolve?.();
    this.releaseNextHeartWriteResolve = null;
    this.releaseNextHeartWritePromise = null;
  }

  async runAsync(sql: string, ...args: Array<string | number | null>) {
    if (sql.includes('INSERT INTO heart_rate') && this.releaseNextHeartWritePromise) {
      const gate = this.releaseNextHeartWritePromise;
      this.releaseNextHeartWritePromise = null;
      await gate;
    }

    return super.runAsync(sql, ...args);
  }
}

describe('WearableSyncService battery refresh', () => {
  beforeEach(() => {
    mockMarkDerivedRefreshPending.mockClear();
    mockRefreshHeartAggregatesForRange.mockClear();
  });

  it('sends the reboot command to the wearable', async () => {
    const device = new MockDevice();
    const db = new MockDb(71);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    await expect(service.restartDevice()).resolves.toBeUndefined();
    expect(device.sentCommands).toEqual(
      expect.arrayContaining([CommandNumber.GetHelloHarvard, CommandNumber.RebootStrap, CommandNumber.GetBatteryLevel]),
    );
  });

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

  it('streams live heart rate while connected', async () => {
    const device = new MockDevice();
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);
    const updates: Array<Awaited<ReturnType<typeof service.getDeviceState>>> = [];

    await service.startLiveUpdates((nextState) => {
      updates.push(nextState);
    });

    device.emitRealtimeHeartRate(0x12345678, 72);

    await Promise.resolve();
    await Promise.resolve();

    await expect(service.getDeviceState()).resolves.toMatchObject({
      liveHeartRate: 72,
    });
    expect(device.sentCommands).toEqual(expect.arrayContaining([CommandNumber.ToggleRealtimeHr]));
    expect(updates.some((state) => state.liveHeartRate === 72)).toBe(true);

    await service.stopLiveUpdates();
    await expect(service.getDeviceState()).resolves.toMatchObject({
      liveHeartRate: null,
      liveHeartRateAt: null,
    });
  });

  it('ignores implausible realtime heart rate placeholders', async () => {
    const device = new MockDevice();
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);
    const updates: Array<Awaited<ReturnType<typeof service.getDeviceState>>> = [];

    await service.startLiveUpdates((nextState) => {
      updates.push(nextState);
    });

    device.emitRealtimeHeartRate(0x12345678, 1);

    await Promise.resolve();
    await Promise.resolve();

    await expect(service.getDeviceState()).resolves.toMatchObject({
      liveHeartRate: null,
    });
    expect(updates.some((state) => state.liveHeartRate === 1)).toBe(false);

    await service.stopLiveUpdates();
  });

  it('updates charging status to not_charging when charging stops', async () => {
    const device = new MockDevice();
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    await service.startLiveUpdates(() => {});

    device.emitEvent(EventNumber.ChargingOn);
    device.emitEvent(EventNumber.ChargingOff);

    await Promise.resolve();
    await Promise.resolve();

    await expect(service.getDeviceState()).resolves.toMatchObject({
      chargingStatus: 'not_charging',
    });

    await service.stopLiveUpdates();
  });

  it('keeps the last persisted charging state until a fresh event arrives', async () => {
    const device = new MockDevice();
    const db = new MockDb(71, 'charging');
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    const updates: Array<Awaited<ReturnType<typeof service.getDeviceState>>> = [];
    await service.startLiveUpdates((nextState) => {
      updates.push(nextState);
    });

    await expect(service.getDeviceState()).resolves.toMatchObject({
      chargingStatus: 'charging',
    });
    expect(updates[0]?.chargingStatus ?? null).toBe('charging');

    await service.stopLiveUpdates();
  });

  it('records meaningful command replies during live updates', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.bodyStatusRaw = 1;
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);
    const liveEvents: WearableLiveEvent[] = [];

    await service.startLiveUpdates(() => {}, (event) => {
      liveEvents.push(event);
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(liveEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Battery reply',
          detail: '85%',
          source: 'command',
        }),
        expect.objectContaining({
          title: 'Wear reply',
          detail: 'On body',
          source: 'command',
        }),
        expect.objectContaining({
          title: 'Name reply',
          detail: 'Neo Strap',
          source: 'command',
        }),
        expect.objectContaining({
          title: 'Firmware reply',
          detail: 'Harvard 1.2.3.4 · Boylston 5.6.7.8',
          source: 'command',
        }),
      ]),
    );

    await service.stopLiveUpdates();
  });

  it('records alarm events during live monitoring', async () => {
    const device = new MockDevice();
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);
    const liveEvents: WearableLiveEvent[] = [];

    await service.startLiveUpdates(() => {}, (event) => {
      liveEvents.push(event);
    });

    device.emitEvent(EventNumber.AppDrivenAlarmExecuted);

    await Promise.resolve();
    await Promise.resolve();

    expect(liveEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'App alarm executed',
          kind: 'app-alarm-executed',
          source: 'event',
        }),
      ]),
    );

    await service.stopLiveUpdates();
  });

  it('ignores history rows and metadata chatter when recording sync live events', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.historyFrames = [
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(PacketType.HistoricalData, 0, 0, createHistoryPayload(1_710_000_001)),
      },
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(PacketType.Metadata, 0, MetadataType.HistoryComplete, createMetadataPayload(1_710_000_001, 0)),
      },
    ];
    const db = new MockDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);
    const liveEvents: WearableLiveEvent[] = [];

    const result = await service.syncSelected(undefined, (event) => {
      liveEvents.push(event);
    });

    expect(result.importedReadings).toBe(1);
    expect(liveEvents.map((event) => event.title)).toEqual([
      'Name reply',
      'Firmware reply',
      'Battery reply',
    ]);
  });

  it('buffers history writes into batched transactions and flushes the final partial batch', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.historyFrames = [
      ...Array.from({ length: 251 }, (_, index) => ({
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.HistoricalData,
          0,
          0,
          createHistoryPayload(1_710_000_001 + index * 60),
        ),
      })),
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.Metadata,
          0,
          MetadataType.HistoryComplete,
          createMetadataPayload(1_710_000_001 + 251 * 60, 0),
        ),
      },
    ];
    const db = new BufferedHistoryDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    const result = await service.syncSelected();

    expect(result.importedReadings).toBe(251);
    expect(db.heartInsertCount).toBe(251);
    expect(db.heartWriteTransactionCount).toBe(2);
    expect(db.exclusiveTransactionCount).toBe(3);
    expect(mockRefreshHeartAggregatesForRange).toHaveBeenCalledWith(
      db,
      formatSqliteDateTime(new Date(1_710_000_001 * 1000)),
      formatSqliteDateTime(new Date((1_710_000_001 + 250 * 60) * 1000)),
    );
    expect(mockMarkDerivedRefreshPending).toHaveBeenCalledWith(
      db,
      formatSqliteDateTime(new Date(1_710_000_001 * 1000)),
      formatSqliteDateTime(new Date((1_710_000_001 + 250 * 60) * 1000)),
    );
  });

  it('skips empty history placeholder rows with implausible bpm values', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.historyFrames = [
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(PacketType.HistoricalData, 0, 0, createHistoryPayload(1_710_000_001, 1)),
      },
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.Metadata,
          0,
          MetadataType.HistoryComplete,
          createMetadataPayload(1_710_000_001, 0),
        ),
      },
    ];
    const db = new BufferedHistoryDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    const result = await service.syncSelected();

    expect(result.importedReadings).toBe(1);
    expect(db.heartInsertCount).toBe(0);
    expect(mockRefreshHeartAggregatesForRange).not.toHaveBeenCalled();
    expect(mockMarkDerivedRefreshPending).not.toHaveBeenCalled();
  });

  it('keeps large history replays split into bounded write transactions', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.historyFrames = [
      ...Array.from({ length: 501 }, (_, index) => ({
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.HistoricalData,
          0,
          0,
          createHistoryPayload(1_710_100_001 + index * 60),
        ),
      })),
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.Metadata,
          0,
          MetadataType.HistoryComplete,
          createMetadataPayload(1_710_100_001 + 501 * 60, 0),
        ),
      },
    ];
    const db = new BufferedHistoryDb(null);
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    const result = await service.syncSelected();

    expect(result.importedReadings).toBe(501);
    expect(db.heartInsertCount).toBe(501);
    expect(db.heartWriteTransactionCount).toBe(3);
  });

  it('retries transient locked database writes without dropping history rows', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.historyFrames = [
      ...Array.from({ length: 251 }, (_, index) => ({
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.HistoricalData,
          0,
          0,
          createHistoryPayload(1_710_200_001 + index * 60),
        ),
      })),
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.Metadata,
          0,
          MetadataType.HistoryComplete,
          createMetadataPayload(1_710_200_001 + 251 * 60, 0),
        ),
      },
    ];
    const db = new BufferedHistoryDb(null);
    db.failHeartWriteTransactionsRemaining = 1;
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    const result = await service.syncSelected();

    expect(result.importedReadings).toBe(251);
    expect(db.heartInsertCount).toBe(251);
    expect(db.heartWriteTransactionCount).toBe(3);
    await expect(service.getDeviceState()).resolves.toMatchObject({
      syncError: null,
    });
  });

  it('waits to acknowledge a history chunk until its rows are committed', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.historyFrames = [
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(PacketType.HistoricalData, 0, 0, createHistoryPayload(1_710_300_001)),
      },
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.Metadata,
          0,
          MetadataType.HistoryEnd,
          createMetadataPayload(1_710_300_001, 1_710_300_001),
        ),
      },
    ];
    device.historyAckFrames = [
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.Metadata,
          0,
          MetadataType.HistoryComplete,
          createMetadataPayload(1_710_300_001, 0),
        ),
      },
    ];
    const db = new DelayedBufferedHistoryDb(null);
    db.blockNextHeartWrite();
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    const syncPromise = service.syncSelected();

    for (let attempt = 0; attempt < 20 && db.heartWriteTransactionCount === 0; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    expect(db.heartWriteTransactionCount).toBe(1);

    expect(device.sentCommands).not.toContain(CommandNumber.HistoricalDataResult);

    db.releaseNextHeartWrite();
    const result = await syncPromise;

    expect(result.importedReadings).toBe(1);
    expect(device.sentCommands).toContain(CommandNumber.HistoricalDataResult);
  });

  it('does not acknowledge a history chunk when persisting it fails', async () => {
    const device = new MockDevice();
    device.batteryTenthsPercent = 845;
    device.historyFrames = [
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(PacketType.HistoricalData, 0, 0, createHistoryPayload(1_710_400_001)),
      },
      {
        characteristic: DATA_FROM_STRAP_UUID,
        frame: framePacket(
          PacketType.Metadata,
          0,
          MetadataType.HistoryEnd,
          createMetadataPayload(1_710_400_001, 1_710_400_001),
        ),
      },
    ];
    const db = new BufferedHistoryDb(null);
    db.failHeartWriteTransactionsRemaining = Number.MAX_SAFE_INTEGER;
    const manager = new MockBleManager(device);
    const service = new WearableSyncService(db as never, manager as never);

    await expect(service.syncSelected()).rejects.toThrow('database is locked');
    expect(device.sentCommands).not.toContain(CommandNumber.HistoricalDataResult);
  });
});
