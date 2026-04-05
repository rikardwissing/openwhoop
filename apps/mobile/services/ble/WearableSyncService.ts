import type { SQLiteDatabase } from 'expo-sqlite';
import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';

import { markDerivedRefreshPending, refreshHeartAggregatesForRange } from '@/data/sqlite/SQLiteHealthRepository';
import { acquireBackgroundSyncLock, releaseBackgroundSyncLock } from '@/services/background/backgroundSyncState';
import { CMD_FROM_STRAP_UUID, CMD_TO_STRAP_UUID, DATA_FROM_STRAP_UUID, EVENTS_FROM_STRAP_UUID, EventNumber, MEMFAULT_UUID, WEARABLE_SERVICE_UUID } from '@/services/ble/constants';
import { resolveScanDeviceName } from '@/services/ble/deviceNaming';
import { createWearableBleManager, getRestoredWearableDevice } from '@/services/ble/bleManager';
import { PacketAssembler, base64ToBytes, bytesToBase64, disableAlarmPacket, enterHighFrequencySyncPacket, exitHighFrequencySyncPacket, getBatteryLevelPacket, getBodyLocationAndStatusPacket, getNamePacket, helloHarvardPacket, historyEndPacket, historyStartPacket, parseNotification, restartPacket, setAlarmPacket, setClockPacket, toggleRealtimeHrPacket, type ImuSamplePacket, type SensorDataPacket, versionInfoPacket } from '@/services/ble/codec';
import { HistorySyncWatchdog } from '@/services/ble/syncWatchdog';
import type { ChargingState, DeviceState, SyncProgress, SyncResult, SyncSource, WearState, WearableLiveEvent, WearableScanResult } from '@/types/device';
import { formatSqliteDateTime } from '@/utils/dateTime';
import { isPlausibleRecordedBpm } from '@/utils/heartRate';

const SELECTED_DEVICE_SQL = `
  INSERT INTO device_state (id, name, last_seen_at, last_synced_at, firmware, battery_percent, charging_status, body_status, sync_error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    last_seen_at = excluded.last_seen_at,
    last_synced_at = COALESCE(excluded.last_synced_at, device_state.last_synced_at),
    firmware = COALESCE(excluded.firmware, device_state.firmware),
    battery_percent = COALESCE(excluded.battery_percent, device_state.battery_percent),
    charging_status = COALESCE(excluded.charging_status, device_state.charging_status),
    body_status = COALESCE(excluded.body_status, device_state.body_status),
    sync_error = excluded.sync_error
`;

const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_SCAN_TIMEOUT_MS = 8_000;
const BATTERY_REQUEST_TIMEOUT_MS = 1_500;
const LIVE_UPDATES_RECONNECT_DELAY_MS = 3_000;
const HISTORY_WRITE_BATCH_SIZE = 250;

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function serializeSensorData(value: SensorDataPacket | null) {
  return value ? JSON.stringify(value) : null;
}

function serializeImuData(value: ImuSamplePacket[] | null) {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

function shouldPersistHistoryReading(reading: {
  bpm: number;
  rr: number[];
  sensorData: SensorDataPacket | null;
  imuData: ImuSamplePacket[] | null;
}) {
  return isPlausibleRecordedBpm(reading.bpm) || reading.rr.length > 0 || reading.sensorData !== null || reading.imuData !== null;
}

function rrToString(rr: number[]) {
  return rr.join(',');
}

type TransactionWriter = Pick<SQLiteDatabase, 'runAsync' | 'execAsync'>;

async function withExclusiveTransaction(
  db: SQLiteDatabase,
  callback: (tx: TransactionWriter) => Promise<void>,
) {
  if (typeof db.withExclusiveTransactionAsync === 'function') {
    await db.withExclusiveTransactionAsync(async (tx) => {
      await callback(tx);
    });
    return;
  }

  await callback(db);
}

interface DeviceStateUpdate {
  id: string;
  name: string | null;
  lastSyncedAt?: string | null;
  firmware?: string | null;
  batteryPercent?: number | null;
  chargingStatus?: ChargingState | null;
  bodyStatus?: WearState | null;
  syncError?: string | null;
}

type LiveEventRecorder = (event: WearableLiveEvent) => void;
type SyncRunSource = SyncSource;

interface PendingHistoryRow {
  bpm: number;
  time: string;
  rrIntervals: string;
  imuData: string | null;
  sensorData: string | null;
}

export interface SyncExecutionOutcome {
  status: 'success' | 'skipped';
  importedReadings: number;
  completedAt: string;
  reason?: string;
}

function formatBleError(error: unknown) {
  if (!(error instanceof Error)) {
    return 'Sync failed.';
  }

  const details: string[] = [];
  const candidate = error as Error & {
    errorCode?: number | null;
    iosErrorCode?: number | null;
    androidErrorCode?: number | null;
    attErrorCode?: number | null;
    reason?: string | null;
  };

  if (candidate.errorCode != null) {
    details.push(`ble=${candidate.errorCode}`);
  }

  if (candidate.iosErrorCode != null) {
    details.push(`ios=${candidate.iosErrorCode}`);
  }

  if (candidate.attErrorCode != null) {
    details.push(`att=${candidate.attErrorCode}`);
  }

  if (candidate.androidErrorCode != null) {
    details.push(`android=${candidate.androidErrorCode}`);
  }

  const reason = candidate.reason?.trim();
  if (reason && reason !== error.message) {
    details.push(reason);
  }

  return details.length > 0 ? `${error.message} (${details.join(', ')})` : error.message;
}

function wearDetail(bodyStatus: WearState) {
  return bodyStatus === 'on-body' ? 'On body' : 'Off body';
}

export class WearableSyncService {
  private liveUpdatesCleanup: (() => Promise<void>) | null = null;
  private nextLiveEventId = 0;
  private liveHeartRate: { bpm: number | null; observedAt: number | null } = { bpm: null, observedAt: null };

  constructor(
    private readonly db: SQLiteDatabase,
    private readonly manager: BleManager = createWearableBleManager(),
  ) {}

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
      charging_status: ChargingState | null;
      body_status: WearState | null;
      sync_error: string | null;
    }>('SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, charging_status, body_status, sync_error FROM device_state ORDER BY last_seen_at DESC LIMIT 1');

    if (!row) {
      return {
        id: null,
        name: null,
        lastSeenAt: null,
        lastSyncedAt: null,
        firmware: null,
        batteryPercent: null,
        chargingStatus: null,
        bodyStatus: null,
        liveHeartRate: this.liveHeartRate.bpm,
        liveHeartRateAt: this.liveHeartRate.observedAt,
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
      chargingStatus: row.charging_status,
      bodyStatus: row.body_status,
      liveHeartRate: this.liveHeartRate.bpm,
      liveHeartRateAt: this.liveHeartRate.observedAt,
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
          name: resolveScanDeviceName(device),
          rssi: device.rssi ?? null,
        });
      });
    });
  }

  async selectDevice(device: WearableScanResult) {
    await this.stopLiveUpdates();
    this.clearLiveHeartRate();
    await this.db.execAsync('DELETE FROM device_state;');
    await this.persistDeviceState({
      id: device.id,
      name: device.name,
    });
  }

  async forgetDevice() {
    await this.stopLiveUpdates();
    this.clearLiveHeartRate();
    await this.db.execAsync('DELETE FROM device_state;');
  }

  private async persistDeviceState(update: DeviceStateUpdate) {
    await this.db.runAsync(
      SELECTED_DEVICE_SQL,
      update.id,
      update.name,
      formatSqliteDateTime(new Date()),
      update.lastSyncedAt ?? null,
      update.firmware ?? null,
      update.batteryPercent ?? null,
      update.chargingStatus ?? null,
      update.bodyStatus ?? null,
      update.syncError ?? null,
    );
  }

  private clearLiveHeartRate() {
    this.liveHeartRate = { bpm: null, observedAt: null };
  }

  private updateLiveHeartRate(bpm: number) {
    this.liveHeartRate = {
      bpm,
      observedAt: Date.now(),
    };
  }

  private createLiveEvent(
    source: WearableLiveEvent['source'],
    kind: string,
    title: string,
    detail: string | null,
    deviceUnixMs: number | null = null,
  ): WearableLiveEvent {
    this.nextLiveEventId += 1;

    return {
      id: `live-event-${this.nextLiveEventId}`,
      observedAt: formatSqliteDateTime(new Date()),
      deviceUnixMs,
      source,
      kind,
      title,
      detail,
    };
  }

  private toLiveEvent(parsed: ReturnType<typeof parseNotification>): WearableLiveEvent | null {
    if (parsed.type === 'battery') {
      return this.createLiveEvent('command', 'battery-reply', 'Battery reply', `${parsed.battery.percent}%`);
    }

    if (parsed.type === 'bodyStatus') {
      return this.createLiveEvent('command', 'wear-reply', 'Wear reply', wearDetail(parsed.body.bodyStatus));
    }

    if (parsed.type === 'version') {
      return this.createLiveEvent(
        'command',
        'firmware-reply',
        'Firmware reply',
        `Harvard ${parsed.version.harvard} · Boylston ${parsed.version.boylston}`,
      );
    }

    if (parsed.type === 'deviceName') {
      return this.createLiveEvent('command', 'name-reply', 'Name reply', parsed.device.name);
    }

    if (parsed.type !== 'event') {
      return null;
    }

    switch (parsed.event.event) {
      case EventNumber.BatteryLevel:
        return this.createLiveEvent('event', 'battery-event', 'Battery event', `${parsed.event.percent}%`, parsed.event.unix);
      case EventNumber.External5vOn:
        return this.createLiveEvent('event', 'external-power-on', 'External power connected', null, parsed.event.unix);
      case EventNumber.External5vOff:
        return this.createLiveEvent('event', 'external-power-off', 'External power disconnected', null, parsed.event.unix);
      case EventNumber.ChargingOn:
        return this.createLiveEvent('event', 'charging-on', 'Charging started', null, parsed.event.unix);
      case EventNumber.ChargingOff:
        return this.createLiveEvent('event', 'charging-off', 'Charging stopped', null, parsed.event.unix);
      case EventNumber.WristOn:
      case EventNumber.WristOff:
        return this.createLiveEvent('event', 'wear-changed', 'Wear changed', wearDetail(parsed.event.bodyStatus), parsed.event.unix);
      case EventNumber.StrapDrivenAlarmSet:
        return this.createLiveEvent('event', 'strap-alarm-set', 'Strap alarm set', null, parsed.event.unix);
      case EventNumber.StrapDrivenAlarmExecuted:
        return this.createLiveEvent('event', 'strap-alarm-executed', 'Strap alarm executed', null, parsed.event.unix);
      case EventNumber.AppDrivenAlarmExecuted:
        return this.createLiveEvent('event', 'app-alarm-executed', 'App alarm executed', null, parsed.event.unix);
      case EventNumber.StrapDrivenAlarmDisabled:
        return this.createLiveEvent('event', 'strap-alarm-disabled', 'Strap alarm disabled', null, parsed.event.unix);
    }

    return null;
  }

  private recordLiveEvent(parsed: ReturnType<typeof parseNotification>, onLiveEvent?: LiveEventRecorder) {
    if (!onLiveEvent) {
      return;
    }

    const event = this.toLiveEvent(parsed);
    if (event) {
      onLiveEvent(event);
    }
  }

  async startLiveUpdates(onDeviceState: (state: DeviceState) => void, onLiveEvent?: LiveEventRecorder) {
    await this.stopLiveUpdates();

    const selected = await this.getDeviceState();
    if (!selected.id) {
      return;
    }

    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let subscriptions: Subscription[] = [];
    let device: Device | null = null;
    let resolvedDeviceId = selected.id;
    let resolvedDeviceName = selected.name;

    const clearReconnect = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const teardownConnection = async () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
      subscriptions = [];

      if (device) {
        try {
          await this.sendCommand(device, toggleRealtimeHrPacket(false));
        } catch {}
        try {
          await device.cancelConnection();
        } catch {}
        device = null;
      }

      this.clearLiveHeartRate();
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) {
        return;
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectAndMonitor();
      }, LIVE_UPDATES_RECONNECT_DELAY_MS);
    };

    const pushState = async (update: Partial<Pick<DeviceStateUpdate, 'batteryPercent' | 'chargingStatus' | 'bodyStatus'>>) => {
      if (closed) {
        return;
      }

      await this.persistDeviceState({
        id: resolvedDeviceId,
        name: resolvedDeviceName,
        batteryPercent: update.batteryPercent,
        chargingStatus: update.chargingStatus,
        bodyStatus: update.bodyStatus,
      });
      onDeviceState(await this.getDeviceState());
    };

    const handleNotification = async (parsed: ReturnType<typeof parseNotification>) => {
      this.recordLiveEvent(parsed, onLiveEvent);

      if (parsed.type === 'battery') {
        await pushState({ batteryPercent: parsed.battery.percent });
        return;
      }

      if (parsed.type === 'realtimeHr') {
        if (isPlausibleRecordedBpm(parsed.heartRate.bpm)) {
          this.updateLiveHeartRate(parsed.heartRate.bpm);
          onDeviceState(await this.getDeviceState());
        }
        return;
      }

      if (parsed.type === 'bodyStatus') {
        await pushState({ bodyStatus: parsed.body.bodyStatus });
        return;
      }

      if (parsed.type !== 'event') {
        return;
      }

      if ('percent' in parsed.event) {
        await pushState({ batteryPercent: parsed.event.percent });
        return;
      }

      if ('chargingStatus' in parsed.event) {
        await pushState({ chargingStatus: parsed.event.chargingStatus });
        return;
      }

      if ('bodyStatus' in parsed.event) {
        await pushState({ bodyStatus: parsed.event.bodyStatus });
      }
    };

    const connectAndMonitor = async () => {
      if (closed) {
        return;
      }

      try {
        await teardownConnection();
        const latestSelected = await this.getDeviceState();
        if (!latestSelected.id) {
          return;
        }

        ({ device, resolvedDeviceId, resolvedDeviceName } = await this.connectSelectedWearable(latestSelected));
        await this.persistDeviceState({
          id: resolvedDeviceId,
          name: resolvedDeviceName,
        });
        onDeviceState(await this.getDeviceState());

        const commandAssembler = new PacketAssembler();
        const eventAssembler = new PacketAssembler();
        const dataAssembler = new PacketAssembler();
        const monitor = (characteristic: string, assembler: PacketAssembler) =>
          device!.monitorCharacteristicForService(WEARABLE_SERVICE_UUID, characteristic, (error, value) => {
            if (closed) {
              return;
            }

            if (error) {
              scheduleReconnect();
              return;
            }

            if (!value?.value) {
              return;
            }

            const frames = assembler.push(base64ToBytes(value.value));
            for (const frame of frames) {
              void handleNotification(parseNotification(frame)).catch(() => {});
            }
          });

        subscriptions.push(monitor(CMD_FROM_STRAP_UUID, commandAssembler));
        subscriptions.push(monitor(EVENTS_FROM_STRAP_UUID, eventAssembler));
        subscriptions.push(monitor(DATA_FROM_STRAP_UUID, dataAssembler));

        await this.sendCommand(device, helloHarvardPacket());
        await this.sendCommand(device, toggleRealtimeHrPacket(true));
        await this.sendCommand(device, getBatteryLevelPacket());
        await this.sendCommand(device, getBodyLocationAndStatusPacket());
        await this.sendCommand(device, getNamePacket());
        await this.sendCommand(device, versionInfoPacket());
      } catch {
        await teardownConnection();
        scheduleReconnect();
      }
    };

    const cleanup = async () => {
      closed = true;
      clearReconnect();
      await teardownConnection();
      if (this.liveUpdatesCleanup === cleanup) {
        this.liveUpdatesCleanup = null;
      }
    };

    this.liveUpdatesCleanup = cleanup;
    await connectAndMonitor();
  }

  async stopLiveUpdates() {
    const cleanup = this.liveUpdatesCleanup;
    if (!cleanup) {
      return;
    }

    this.liveUpdatesCleanup = null;
    await cleanup();
  }

  async setAlarm(
    unixSeconds: number,
    onProgress?: (progress: SyncProgress) => void,
    onLiveEvent?: LiveEventRecorder,
  ) {
    const alarmAt = new Date(unixSeconds * 1000);
    await this.runDeviceCommand(
      onProgress,
      `Setting alarm for ${formatSqliteDateTime(alarmAt)}...`,
      async (device) => {
        await this.sendCommand(device, helloHarvardPacket());
        await this.sendCommand(device, setClockPacket(Math.floor(Date.now() / 1000)));
        await this.sendCommand(device, setAlarmPacket(unixSeconds));
      },
      onLiveEvent,
    );

    onProgress?.({
      status: 'complete',
      message: `Alarm set for ${formatSqliteDateTime(alarmAt)}.`,
    });
  }

  async disableAlarm(onProgress?: (progress: SyncProgress) => void, onLiveEvent?: LiveEventRecorder) {
    await this.runDeviceCommand(
      onProgress,
      'Disabling alarm on the wearable...',
      async (device) => {
        await this.sendCommand(device, helloHarvardPacket());
        await this.sendCommand(device, disableAlarmPacket());
      },
      onLiveEvent,
    );

    onProgress?.({
      status: 'complete',
      message: 'Alarm disabled.',
    });
  }

  async restartDevice(onProgress?: (progress: SyncProgress) => void, onLiveEvent?: LiveEventRecorder) {
    await this.runDeviceCommand(
      onProgress,
      'Restarting the wearable...',
      async (device) => {
        await this.sendCommand(device, helloHarvardPacket());
        await this.sendCommand(device, restartPacket());
      },
      onLiveEvent,
    );

    onProgress?.({
      status: 'complete',
      message: 'Restart command sent. The wearable may disappear briefly while it boots back up.',
    });
  }

  async syncSelected(
    onProgress?: (progress: SyncProgress) => void,
    onLiveEvent?: LiveEventRecorder,
  ): Promise<SyncResult> {
    const outcome = await this.runSync('foreground', onProgress, onLiveEvent);
    return {
      importedReadings: outcome.importedReadings,
      completedAt: outcome.completedAt,
    };
  }

  async syncInBackground(): Promise<SyncExecutionOutcome> {
    return this.runSync('background');
  }

  private async runSync(
    source: SyncRunSource,
    onProgress?: (progress: SyncProgress) => void,
    onLiveEvent?: LiveEventRecorder,
  ): Promise<SyncExecutionOutcome> {
    if (source === 'foreground') {
      await this.stopLiveUpdates();
    }

    const selected = await this.getDeviceState();
    if (!selected.id) {
      throw new Error('Select a wearable before syncing.');
    }

    const lockOwner = `${source}:${Date.now()}`;
    const lockAcquired = await acquireBackgroundSyncLock(this.db, lockOwner);
    if (!lockAcquired) {
      const completedAt = formatSqliteDateTime(new Date());
      onProgress?.({
        status: 'complete',
        message: source === 'foreground'
          ? 'A sync is already running. Wait for it to finish before starting another one.'
          : 'Skipped background sync because another sync is already running.',
        importedReadings: 0,
      });
      return {
        status: 'skipped',
        importedReadings: 0,
        completedAt,
        reason: 'sync-lock-active',
      };
    }

    await this.ensurePoweredOn();
    onProgress?.({ status: 'connecting', message: `Connecting to ${selected.name ?? 'wearable'}...` });

    let device: Device | null = null;
    let firmware: string | null = null;
    let batteryPercent: number | null = null;
    let importedReadings = 0;
    let lastHistoryCursor = 0;
    let earliestImportedTime: string | null = null;
    let latestImportedTime: string | null = null;
    let resolvedDeviceId = selected.id;
    let resolvedDeviceName = selected.name;
    let pendingHistoryRows: PendingHistoryRow[] = [];
    let historyFlushQueued = false;
    let writeQueue = Promise.resolve();
    let commandQueue = Promise.resolve();
    const dataAssembler = new PacketAssembler();
    const responseAssembler = new PacketAssembler();
    const subscriptions: Subscription[] = [];

    const queueWrite = (task: () => Promise<void>) => {
      writeQueue = writeQueue.then(task);
      return writeQueue;
    };

    const queueCommand = (task: () => Promise<void>) => {
      commandQueue = commandQueue.then(task);
      return commandQueue;
    };

    const flushPendingHistoryRows = async () => {
      if (pendingHistoryRows.length === 0) {
        return;
      }

      const rows = pendingHistoryRows;
      pendingHistoryRows = [];

      await withExclusiveTransaction(this.db, async (tx) => {
        for (const row of rows) {
          await tx.runAsync(
            `
              INSERT INTO heart_rate (bpm, time, rr_intervals, imu_data, sensor_data, synced)
              VALUES (?, ?, ?, ?, ?, 0)
              ON CONFLICT(time) DO UPDATE SET
                bpm = excluded.bpm,
                rr_intervals = excluded.rr_intervals,
                imu_data = excluded.imu_data,
                sensor_data = excluded.sensor_data
            `,
            row.bpm,
            row.time,
            row.rrIntervals,
            row.imuData,
            row.sensorData,
          );
        }
      });
    };

    const queuePendingHistoryFlush = () => {
      if (historyFlushQueued) {
        return;
      }

      historyFlushQueued = true;
      void queueWrite(async () => {
        try {
          await flushPendingHistoryRows();
        } finally {
          historyFlushQueued = false;

          if (pendingHistoryRows.length >= HISTORY_WRITE_BATCH_SIZE) {
            queuePendingHistoryFlush();
          }
        }
      }).catch(() => {});
    };

    try {
      ({
        device,
        resolvedDeviceId,
        resolvedDeviceName,
      } = await this.connectSelectedWearable(
        selected,
        onProgress,
        {
          allowDiscoveryScan: source === 'foreground',
          allowRescan: source === 'foreground',
        },
      ));

      const completion = new Promise<void>((resolve, reject) => {
        let settled = false;
        const watchdog = new HistorySyncWatchdog();

        const clearTimers = () => {
          clearInterval(watchdogTimer);
        };

        const succeed = () => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimers();
          resolve();
        };

        const fail = (error: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimers();
          reject(error);
        };

        const watchdogTimer = setInterval(() => {
          const timeoutError = watchdog.getTimeoutError({
            importedReadings,
            lastHistoryCursor,
          });
          if (timeoutError) {
            fail(timeoutError);
          }
        }, 1000);

        const monitor = (characteristic: string, assembler: PacketAssembler) =>
          device!.monitorCharacteristicForService(WEARABLE_SERVICE_UUID, characteristic, (error, value) => {
            if (error) {
              fail(error);
              return;
            }

            if (!value?.value) {
              return;
            }

            watchdog.markPacketActivity();
            const frames = assembler.push(base64ToBytes(value.value));
            for (const frame of frames) {
              const parsed = parseNotification(frame);
              this.recordLiveEvent(parsed, onLiveEvent);

              if (parsed.type === 'history') {
                importedReadings += 1;
                lastHistoryCursor = parsed.reading.unix;
                watchdog.markProgress();

                if (!shouldPersistHistoryReading(parsed.reading)) {
                  continue;
                }

                const readingTime = formatSqliteDateTime(new Date(parsed.reading.unix));
                earliestImportedTime =
                  earliestImportedTime === null || readingTime < earliestImportedTime
                    ? readingTime
                    : earliestImportedTime;
                latestImportedTime =
                  latestImportedTime === null || readingTime > latestImportedTime
                    ? readingTime
                    : latestImportedTime;
                pendingHistoryRows.push({
                  bpm: parsed.reading.bpm,
                  time: readingTime,
                  rrIntervals: rrToString(parsed.reading.rr),
                  imuData: serializeImuData(parsed.reading.imuData),
                  sensorData: serializeSensorData(parsed.reading.sensorData),
                });

                if (pendingHistoryRows.length >= HISTORY_WRITE_BATCH_SIZE) {
                  queuePendingHistoryFlush();
                }

                if (importedReadings % 250 === 0) {
                  onProgress?.({
                    status: 'syncing',
                    message: `Imported ${importedReadings} readings...`,
                    importedReadings,
                  });
                }
              }

              if (parsed.type === 'metadata') {
                watchdog.markProgress();
                if (parsed.metadata.kind === 2) {
                  void queueCommand(() =>
                    this.sendCommand(
                      device!,
                      historyEndPacket(parsed.metadata.data),
                    ),
                  ).catch((commandError) => {
                    fail(
                      commandError instanceof Error ? commandError : new Error('Failed to acknowledge sync chunk.'),
                    );
                  });
                }

                if (parsed.metadata.kind === 3) {
                  queuePendingHistoryFlush();
                  succeed();
                }
              }

              if (parsed.type === 'version') {
                firmware = parsed.version.harvard;
              }

              if (parsed.type === 'deviceName') {
                resolvedDeviceName = parsed.device.name;
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
      batteryPercent = await this.refreshBatteryPercent(device, resolvedDeviceId);
      await this.sendCommand(device, enterHighFrequencySyncPacket());

      onProgress?.({ status: 'syncing', message: 'Requesting wearable history...' });
      await this.sendCommand(device, historyStartPacket());
      await completion;

      await queueWrite(async () => {
        await flushPendingHistoryRows();
      });
      await writeQueue;
      if (earliestImportedTime && latestImportedTime) {
        try {
          await refreshHeartAggregatesForRange(this.db, earliestImportedTime, latestImportedTime);
        } catch {}
        await markDerivedRefreshPending(this.db, earliestImportedTime, latestImportedTime);
      }

      const completedAt = formatSqliteDateTime(new Date());
      await this.persistDeviceState({
        id: resolvedDeviceId,
        name: resolvedDeviceName,
        lastSyncedAt: completedAt,
        firmware,
        batteryPercent,
      });

      onProgress?.({ status: 'complete', message: `Sync complete. Imported ${importedReadings} readings.`, importedReadings });
      return {
        status: 'success',
        importedReadings,
        completedAt,
      };
    } catch (error) {
      const message = formatBleError(error);
      await this.persistDeviceState({
        id: resolvedDeviceId,
        name: resolvedDeviceName,
        lastSyncedAt: selected.lastSyncedAt,
        firmware,
        syncError: message,
      });
      onProgress?.({ status: 'error', message });
      throw error;
    } finally {
      await queueWrite(async () => {
        await flushPendingHistoryRows();
      }).catch(() => {});
      await commandQueue.catch(() => {});

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

      await releaseBackgroundSyncLock(this.db, lockOwner).catch(() => {});
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

  private async requestBatteryPercent(device: Device, onLiveEvent?: LiveEventRecorder): Promise<number | null> {
    const assembler = new PacketAssembler();

    return new Promise<number | null>((resolve) => {
      let settled = false;
      let subscription: Subscription | null = null;

      const finish = (batteryPercent: number | null) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        subscription?.remove();
        resolve(batteryPercent);
      };

      const timeout = setTimeout(() => {
        finish(null);
      }, BATTERY_REQUEST_TIMEOUT_MS);

      subscription = device.monitorCharacteristicForService(
        WEARABLE_SERVICE_UUID,
        CMD_FROM_STRAP_UUID,
        (error, value) => {
          if (error) {
            finish(null);
            return;
          }

          if (!value?.value) {
            return;
          }

          const frames = assembler.push(base64ToBytes(value.value));
          for (const frame of frames) {
            const parsed = parseNotification(frame);
            this.recordLiveEvent(parsed, onLiveEvent);
            if (parsed.type === 'battery') {
              finish(parsed.battery.percent);
              return;
            }
          }
        },
      );

      void this.sendCommand(device, getBatteryLevelPacket()).catch(() => {
        finish(null);
      });
    });
  }

  private async refreshBatteryPercent(device: Device, deviceId: string, onLiveEvent?: LiveEventRecorder): Promise<number | null> {
    const batteryPercent = await this.requestBatteryPercent(device, onLiveEvent);

    if (batteryPercent === null) {
      return null;
    }

    await this.db.runAsync(
      'UPDATE device_state SET battery_percent = ?, last_seen_at = ? WHERE id = ?',
      batteryPercent,
      formatSqliteDateTime(new Date()),
      deviceId,
    );

    return batteryPercent;
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

  private async runDeviceCommand(
    onProgress: ((progress: SyncProgress) => void) | undefined,
    workingMessage: string,
    task: (device: Device) => Promise<void>,
    onLiveEvent?: LiveEventRecorder,
  ) {
    await this.stopLiveUpdates();
    const selected = await this.getDeviceState();
    if (!selected.id) {
      throw new Error('Select a wearable before sending a device command.');
    }

    await this.ensurePoweredOn();
    onProgress?.({ status: 'connecting', message: `Connecting to ${selected.name ?? 'wearable'}...` });

    let device: Device | null = null;
    let resolvedDeviceId = selected.id;
    let resolvedDeviceName = selected.name;

    try {
      ({ device, resolvedDeviceId, resolvedDeviceName } = await this.connectSelectedWearable(selected, onProgress));
      onProgress?.({ status: 'updating', message: workingMessage });
      await task(device);
      const batteryPercent = await this.refreshBatteryPercent(device, resolvedDeviceId, onLiveEvent);

      await this.persistDeviceState({
        id: resolvedDeviceId,
        name: resolvedDeviceName,
        lastSyncedAt: selected.lastSyncedAt,
        batteryPercent,
      });
    } catch (error) {
      const message = formatBleError(error);
      await this.persistDeviceState({
        id: resolvedDeviceId,
        name: resolvedDeviceName,
        lastSyncedAt: selected.lastSyncedAt,
        syncError: message,
      });
      onProgress?.({ status: 'error', message });
      throw error;
    } finally {
      if (device) {
        try {
          await device.cancelConnection();
        } catch {}
      }
    }
  }

  private async connectWithRetry(deviceId: string, deviceName: string) {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.manager.cancelDeviceConnection(deviceId).catch(() => {});
        return await this.manager.connectToDevice(deviceId, { timeout: CONNECT_TIMEOUT_MS });
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await delay(400);
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'Unknown Bluetooth error.';
    throw new Error(`Unable to connect to ${deviceName}. ${message}`);
  }

  private async findKnownConnectionCandidate(
    selected: DeviceState,
  ) {
    const selectedId = selected.id;
    if (!selectedId) {
      throw new Error('No wearable selected.');
    }

    this.manager.stopDeviceScan();

    const restored = getRestoredWearableDevice(selectedId);
    if (restored && this.matchesSelectedDevice(restored, selected)) {
      return restored;
    }

    const knownById = await this.manager.devices([selectedId]).catch(() => []);
    if (knownById[0]) {
      return knownById[0];
    }

    const connected = await this.manager.connectedDevices([WEARABLE_SERVICE_UUID]).catch(() => []);
    const connectedMatch = connected.find((device) => this.matchesSelectedDevice(device, selected));
    if (connectedMatch) {
      return connectedMatch;
    }

    return null;
  }

  private async findConnectionCandidate(
    selected: DeviceState,
    options: {
      allowDiscoveryScan: boolean;
    },
    onProgress?: (progress: SyncProgress) => void,
  ) {
    const known = await this.findKnownConnectionCandidate(selected);
    if (known) {
      return known;
    }

    if (!options.allowDiscoveryScan) {
      return null;
    }

    onProgress?.({
      status: 'connecting',
      message: `Re-discovering ${selected.name ?? 'wearable'} before connecting...`,
    });

    const scanned = await this.scanForMatchingDevice(selected);
    if (scanned) {
      return scanned;
    }

    throw new Error(
      `Could not find ${selected.name ?? 'the selected wearable'} nearby. Scan again and keep the wearable awake.`,
    );
  }

  private async scanForMatchingDevice(selected: DeviceState) {
    return new Promise<Device | null>((resolve, reject) => {
      let fallbackMatch: Device | null = null;

      const finish = (device: Device | null) => {
        clearTimeout(timeout);
        this.manager.stopDeviceScan();
        resolve(device);
      };

      const timeout = setTimeout(() => {
        finish(fallbackMatch);
      }, CONNECT_SCAN_TIMEOUT_MS);

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

        if (device.id === selected.id) {
          finish(device);
          return;
        }

        if (this.matchesSelectedDevice(device, selected)) {
          if (!fallbackMatch || (device.rssi ?? -999) > (fallbackMatch.rssi ?? -999)) {
            fallbackMatch = device;
          }
        }
      });
    });
  }

  private matchesSelectedDevice(device: Device, selected: DeviceState) {
    if (selected.id && device.id === selected.id) {
      return true;
    }

    const candidateName = resolveScanDeviceName(device);
    return Boolean(selected.name && candidateName === selected.name);
  }

  private async connectSelectedWearable(
    selected: DeviceState,
    onProgress?: (progress: SyncProgress) => void,
    options?: {
      allowDiscoveryScan?: boolean;
      allowRescan?: boolean;
    },
  ) {
    const allowDiscoveryScan = options?.allowDiscoveryScan ?? true;
    const allowRescan = options?.allowRescan ?? true;
    let candidate = await this.findConnectionCandidate(selected, { allowDiscoveryScan }, onProgress);
    let resolvedDeviceId = candidate?.id ?? selected.id!;
    let resolvedDeviceName = (candidate ? resolveScanDeviceName(candidate) : null) ?? selected.name;
    let device: Device;

    try {
      device = await this.connectWithRetry(resolvedDeviceId, resolvedDeviceName ?? 'wearable');
    } catch (error) {
      if (!allowRescan) {
        throw error;
      }

      onProgress?.({
        status: 'connecting',
        message: `Direct connect failed. Re-scanning for ${resolvedDeviceName ?? 'wearable'}...`,
      });

      const rescanned = await this.scanForMatchingDevice({
        ...selected,
        id: resolvedDeviceId,
        name: resolvedDeviceName,
      });

      if (!rescanned) {
        throw error;
      }

      candidate = rescanned;
      resolvedDeviceId = rescanned.id;
      resolvedDeviceName = resolveScanDeviceName(rescanned) ?? resolvedDeviceName;
      device = await this.connectWithRetry(rescanned.id, resolvedDeviceName ?? 'wearable');
    }

    device = await device.discoverAllServicesAndCharacteristics();
    resolvedDeviceName = resolveScanDeviceName(device) ?? resolvedDeviceName;

    return {
      device,
      resolvedDeviceId,
      resolvedDeviceName,
    };
  }
}
