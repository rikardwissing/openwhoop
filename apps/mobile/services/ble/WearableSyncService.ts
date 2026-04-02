import type { SQLiteDatabase } from 'expo-sqlite';
import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';

import { refreshDerivedData } from '@/data/sqlite/SQLiteHealthRepository';
import { CMD_FROM_STRAP_UUID, CMD_TO_STRAP_UUID, DATA_FROM_STRAP_UUID, EVENTS_FROM_STRAP_UUID, MEMFAULT_UUID, WEARABLE_SERVICE_UUID } from '@/services/ble/constants';
import { PacketAssembler, base64ToBytes, bytesToBase64, enterHighFrequencySyncPacket, exitHighFrequencySyncPacket, getNamePacket, helloHarvardPacket, historyEndPacket, historyStartPacket, parseNotification, setClockPacket, type SensorDataPacket, versionInfoPacket } from '@/services/ble/codec';
import type { DeviceState, SyncProgress, SyncResult, WearableScanResult } from '@/types/device';
import { formatSqliteDateTime } from '@/utils/dateTime';

const SELECTED_DEVICE_SQL = `
  INSERT INTO device_state (id, name, last_seen_at, last_synced_at, firmware, battery_percent, body_status, sync_error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    last_seen_at = excluded.last_seen_at,
    last_synced_at = COALESCE(excluded.last_synced_at, device_state.last_synced_at),
    firmware = COALESCE(excluded.firmware, device_state.firmware),
    battery_percent = COALESCE(excluded.battery_percent, device_state.battery_percent),
    body_status = COALESCE(excluded.body_status, device_state.body_status),
    sync_error = excluded.sync_error
`;

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function serializeSensorData(value: SensorDataPacket | null) {
  return value ? JSON.stringify(value) : null;
}

function rrToString(rr: number[]) {
  return rr.join(',');
}

export class WearableSyncService {
  private readonly manager = new BleManager();

  constructor(private readonly db: SQLiteDatabase) {}

  async dispose() {
    this.manager.destroy();
  }

  async getDeviceState(): Promise<DeviceState> {
    const row = await this.db.getFirstAsync<{
      id: string;
      name: string | null;
      last_seen_at: string | null;
      last_synced_at: string | null;
      firmware: string | null;
      battery_percent: number | null;
      body_status: string | null;
      sync_error: string | null;
    }>('SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, body_status, sync_error FROM device_state ORDER BY last_seen_at DESC LIMIT 1');

    if (!row) {
      return {
        id: null,
        name: null,
        lastSeenAt: null,
        lastSyncedAt: null,
        firmware: null,
        batteryPercent: null,
        bodyStatus: null,
        syncError: null,
      };
    }

    return {
      id: row.id,
      name: row.name,
      lastSeenAt: row.last_seen_at,
      lastSyncedAt: row.last_synced_at,
      firmware: row.firmware,
      batteryPercent: row.battery_percent,
      bodyStatus: row.body_status,
      syncError: row.sync_error,
    };
  }

  async scan(): Promise<WearableScanResult[]> {
    await this.ensurePoweredOn();

    const found = new Map<string, WearableScanResult>();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.manager.stopDeviceScan();
        resolve(
          [...found.values()].sort((left, right) => (right.rssi ?? -999) - (left.rssi ?? -999)),
        );
      }, 5000);

      this.manager.startDeviceScan([WEARABLE_SERVICE_UUID], null, (error, device) => {
        if (error) {
          clearTimeout(timeout);
          this.manager.stopDeviceScan();
          reject(error);
          return;
        }

        if (!device) {
          return;
        }

        found.set(device.id, {
          id: device.id,
          name: device.name ?? device.localName ?? 'Unnamed wearable',
          rssi: device.rssi ?? null,
        });
      });
    });
  }

  async selectDevice(device: WearableScanResult) {
    await this.db.execAsync('DELETE FROM device_state;');
    const now = formatSqliteDateTime(new Date());
    await this.db.runAsync(
      SELECTED_DEVICE_SQL,
      device.id,
      device.name,
      now,
      null,
      null,
      null,
      null,
      null,
    );
  }

  async forgetDevice() {
    await this.db.execAsync('DELETE FROM device_state;');
  }

  async syncSelected(onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    const selected = await this.getDeviceState();
    if (!selected.id) {
      throw new Error('Select a wearable before syncing.');
    }

    await this.ensurePoweredOn();
    onProgress?.({ status: 'connecting', message: `Connecting to ${selected.name ?? 'wearable'}...` });

    let device: Device | null = null;
    let firmware: string | null = null;
    let importedReadings = 0;
    let lastHistoryCursor = 0;
    let writeQueue = Promise.resolve();
    const dataAssembler = new PacketAssembler();
    const responseAssembler = new PacketAssembler();
    const subscriptions: Subscription[] = [];

    const queueWrite = (task: () => Promise<void>) => {
      writeQueue = writeQueue.then(task);
      return writeQueue;
    };

    try {
      device = await this.manager.connectToDevice(selected.id, { timeout: 10000 });
      device = await device.discoverAllServicesAndCharacteristics();

      const completion = new Promise<void>((resolve, reject) => {
        const monitor = (characteristic: string, assembler: PacketAssembler) =>
          device!.monitorCharacteristicForService(WEARABLE_SERVICE_UUID, characteristic, (error, value) => {
            if (error) {
              reject(error);
              return;
            }

            if (!value?.value) {
              return;
            }

            const frames = assembler.push(base64ToBytes(value.value));
            for (const frame of frames) {
              const parsed = parseNotification(frame);

              if (parsed.type === 'history') {
                importedReadings += 1;
                lastHistoryCursor = parsed.reading.unix;
                queueWrite(async () => {
                  await this.db.runAsync(
                    `
                      INSERT INTO heart_rate (bpm, time, rr_intervals, imu_data, sensor_data, synced)
                      VALUES (?, ?, ?, NULL, ?, 0)
                      ON CONFLICT(time) DO UPDATE SET
                        bpm = excluded.bpm,
                        rr_intervals = excluded.rr_intervals,
                        sensor_data = excluded.sensor_data
                    `,
                    parsed.reading.bpm,
                    formatSqliteDateTime(new Date(parsed.reading.unix)),
                    rrToString(parsed.reading.rr),
                    serializeSensorData(parsed.reading.sensorData),
                  );
                });

                if (importedReadings % 250 === 0) {
                  onProgress?.({
                    status: 'syncing',
                    message: `Imported ${importedReadings} readings...`,
                    importedReadings,
                  });
                }
              }

              if (parsed.type === 'metadata') {
                if (parsed.metadata.kind === 2) {
                  void device!
                    .writeCharacteristicWithoutResponseForService(
                      WEARABLE_SERVICE_UUID,
                      CMD_TO_STRAP_UUID,
                      bytesToBase64(historyEndPacket(parsed.metadata.data)),
                    )
                    .catch(reject);
                }

                if (parsed.metadata.kind === 3) {
                  resolve();
                }
              }

              if (parsed.type === 'version') {
                firmware = parsed.version.harvard;
              }
            }
          });

        subscriptions.push(monitor(DATA_FROM_STRAP_UUID, dataAssembler));
        subscriptions.push(monitor(CMD_FROM_STRAP_UUID, responseAssembler));
        subscriptions.push(monitor(EVENTS_FROM_STRAP_UUID, responseAssembler));
        subscriptions.push(monitor(MEMFAULT_UUID, responseAssembler));
      });

      await this.sendCommand(device, helloHarvardPacket());
      await this.sendCommand(device, setClockPacket(Math.floor(Date.now() / 1000)));
      await this.sendCommand(device, getNamePacket());
      await this.sendCommand(device, versionInfoPacket());
      await this.sendCommand(device, enterHighFrequencySyncPacket());

      onProgress?.({ status: 'syncing', message: 'Requesting wearable history...' });
      await this.sendCommand(device, historyStartPacket());

      await Promise.race([
        completion,
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('History sync timed out.'));
          }, 45000);
        }),
      ]);

      await writeQueue;
      onProgress?.({ status: 'refreshing', message: 'Refreshing local metrics...', importedReadings });
      await refreshDerivedData(this.db);

      const completedAt = formatSqliteDateTime(new Date());
      await this.db.runAsync(
        SELECTED_DEVICE_SQL,
        selected.id,
        selected.name,
        formatSqliteDateTime(new Date()),
        completedAt,
        firmware,
        null,
        null,
        null,
      );

      onProgress?.({ status: 'complete', message: `Sync complete. Imported ${importedReadings} readings.`, importedReadings });
      return {
        importedReadings,
        completedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed.';
      await this.db.runAsync(
        SELECTED_DEVICE_SQL,
        selected.id,
        selected.name,
        formatSqliteDateTime(new Date()),
        selected.lastSyncedAt,
        firmware,
        null,
        null,
        message,
      );
      onProgress?.({ status: 'error', message });
      throw error;
    } finally {
      for (const subscription of subscriptions) {
        subscription.remove();
      }

      if (device) {
        try {
          await this.sendCommand(device, exitHighFrequencySyncPacket());
        } catch {}

        try {
          await device.cancelConnection();
        } catch {}
      }
    }
  }

  private async sendCommand(device: Device, bytes: Uint8Array) {
    await device.writeCharacteristicWithoutResponseForService(
      WEARABLE_SERVICE_UUID,
      CMD_TO_STRAP_UUID,
      bytesToBase64(bytes),
    );
    await delay(120);
  }

  private async ensurePoweredOn() {
    const current = await this.manager.state();
    if (current === 'PoweredOn') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.remove();
        reject(new Error('Bluetooth did not power on in time.'));
      }, 8000);

      const subscription = this.manager.onStateChange((state) => {
        if (state === 'PoweredOn') {
          clearTimeout(timer);
          subscription.remove();
          resolve();
        }
      }, true);
    });
  }
}
