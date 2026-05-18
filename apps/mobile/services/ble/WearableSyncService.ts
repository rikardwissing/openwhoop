import type { SQLiteDatabase, SQLiteStatement } from 'expo-sqlite';

import {
  markOneOffSleepAlarmExecutedFromDatabase,
  markDerivedRefreshPending,
  refreshHeartAggregatesForRange,
  resolveNextWearableAlarmDateFromDatabase,
} from '@/data/sqlite/SQLiteHealthRepository';
import {
  acquireBackgroundSyncLock,
  recordBackgroundRunResult,
  recordBackgroundRunStart,
  recordSyncImportSummary,
  releaseBackgroundSyncLock,
} from '@/services/background/backgroundSyncState';
import {
  beginBackgroundExecutionAssertionAsync,
  endBackgroundExecutionAssertionAsync,
} from '@/services/background/backgroundExecutionAssertion';
import { EventNumber } from '@/services/ble/constants';
import { WearableConnectionManager, type LiveConnectionHandle } from '@/services/ble/WearableConnectionManager';
import { disableAlarmPacket, enterHighFrequencySyncPacket, exitHighFrequencySyncPacket, getBatteryLevelPacket, getBodyLocationAndStatusPacket, getNamePacket, helloHarvardPacket, historyEndPacket, historyStartPacket, restartPacket, setAlarmPacket, setClockPacket, toggleR7DataCollectionPacket, toggleRealtimeHrPacket, type FramedPacket, type ParsedNotification, type SensorDataPacket, versionInfoPacket } from '@/services/ble/codec';
import { HistorySyncWatchdog } from '@/services/ble/syncWatchdog';
import { recordAppIntentEvent } from '@/services/appIntentEvents';
import {
  notifyForWearableBatteryLevelAsync,
  notifyForWearableEventAsync,
} from '@/services/notifications/wearableEventNotifications';
import { updateTonightWidgetFromDatabase } from '@/services/widgets/tonightWidget';
import type {
  BackgroundSyncResult,
  ChargingState,
  DeviceState,
  SyncImportPerformanceSummary,
  SyncProgress,
  SyncSource,
  WearState,
  WearableLiveEvent,
  WearableScanResult,
} from '@/types/device';
import { formatSqliteDateTime } from '@/utils/dateTime';
import { MAX_PLAUSIBLE_RECORDED_BPM, MIN_PLAUSIBLE_RECORDED_BPM, isPlausibleRecordedBpm } from '@/utils/heartRate';

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

const BATTERY_REQUEST_TIMEOUT_MS = 1_500;
const BACKGROUND_SYNC_CLEANUP_RESERVE_MS = 20_000;
const HISTORY_WRITE_BATCH_SIZE = 250;
const HISTORY_WRITE_MAX_RETRIES = 4;
const HISTORY_WRITE_RETRY_DELAY_MS = 150;
const LIVE_RECONNECT_BACKGROUND_ASSERTION_MAX_MS = 25_000;
const HISTORY_INSERT_SQL = `
  INSERT INTO heart_rate (
    bpm,
    time,
    rr_intervals,
    ppg_green,
    ppg_red_ir,
    spo2_red,
    spo2_ir,
    skin_temp_raw,
    ambient_light,
    led_drive_1,
    led_drive_2,
    resp_rate_raw,
    signal_quality,
    skin_contact,
    accel_gravity_x,
    accel_gravity_y,
    accel_gravity_z
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(time) DO UPDATE SET
    bpm = CASE
      WHEN excluded.bpm BETWEEN ${MIN_PLAUSIBLE_RECORDED_BPM} AND ${MAX_PLAUSIBLE_RECORDED_BPM} THEN excluded.bpm
      WHEN heart_rate.bpm BETWEEN ${MIN_PLAUSIBLE_RECORDED_BPM} AND ${MAX_PLAUSIBLE_RECORDED_BPM} THEN heart_rate.bpm
      ELSE excluded.bpm
    END,
    rr_intervals = COALESCE(NULLIF(excluded.rr_intervals, ''), heart_rate.rr_intervals),
    ppg_green = COALESCE(excluded.ppg_green, heart_rate.ppg_green),
    ppg_red_ir = COALESCE(excluded.ppg_red_ir, heart_rate.ppg_red_ir),
    spo2_red = COALESCE(excluded.spo2_red, heart_rate.spo2_red),
    spo2_ir = COALESCE(excluded.spo2_ir, heart_rate.spo2_ir),
    skin_temp_raw = COALESCE(excluded.skin_temp_raw, heart_rate.skin_temp_raw),
    ambient_light = COALESCE(excluded.ambient_light, heart_rate.ambient_light),
    led_drive_1 = COALESCE(excluded.led_drive_1, heart_rate.led_drive_1),
    led_drive_2 = COALESCE(excluded.led_drive_2, heart_rate.led_drive_2),
    resp_rate_raw = COALESCE(excluded.resp_rate_raw, heart_rate.resp_rate_raw),
    signal_quality = COALESCE(excluded.signal_quality, heart_rate.signal_quality),
    skin_contact = COALESCE(excluded.skin_contact, heart_rate.skin_contact),
    accel_gravity_x = COALESCE(excluded.accel_gravity_x, heart_rate.accel_gravity_x),
    accel_gravity_y = COALESCE(excluded.accel_gravity_y, heart_rate.accel_gravity_y),
    accel_gravity_z = COALESCE(excluded.accel_gravity_z, heart_rate.accel_gravity_z)
`;

const SHOULD_LOG_SYNC_IMPORT_PERF =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  (typeof process === 'undefined' || process.env.NODE_ENV !== 'test');
const HISTORY_PACKET_DEBUG_SAMPLE_LIMIT = 8;

type PerformanceLogValue = string | number | boolean | null;

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logSyncImportPerfSummary(label: string, details: Record<string, PerformanceLogValue>) {
  if (!SHOULD_LOG_SYNC_IMPORT_PERF) {
    return;
  }

  const suffix = Object.entries(details)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.info(`[mobile-perf] ${label}${suffix ? ` ${suffix}` : ''}`);
}

function incrementLogCounter<K extends string | number>(counts: Map<K, number>, key: K) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function formatLogCounter<K extends string | number>(counts: Map<K, number>) {
  return [...counts.entries()]
    .sort(([leftKey], [rightKey]) => String(leftKey).localeCompare(String(rightKey), undefined, { numeric: true }))
    .map(([key, count]) => `${key}:${count}`)
    .join(',');
}

function toSyncImportPerfLogDetails(summary: SyncImportPerformanceSummary): Record<string, PerformanceLogValue> {
  return {
    source: summary.source,
    status: summary.status,
    total_ms: summary.totalMs,
    connect_ms: summary.connectMs,
    history_request_to_complete_ms: summary.historyRequestToCompleteMs,
    history_receive_ms: summary.historyReceiveMs,
    db_flush_ms_total: summary.dbFlushMsTotal,
    db_flush_ms_avg: summary.dbFlushMsAvg,
    db_flush_ms_max: summary.dbFlushMsMax,
    ack_wait_ms_total: summary.ackWaitMsTotal,
    ack_wait_ms_avg: summary.ackWaitMsAvg,
    ack_wait_ms_max: summary.ackWaitMsMax,
    imported_rows: summary.importedRows,
    persisted_rows: summary.persistedRows,
    flush_count: summary.flushCount,
    flush_rows_total: summary.flushRowsTotal,
    history_end_count: summary.historyEndCount,
    ack_sent_count: summary.ackSentCount,
    max_pending_rows: summary.maxPendingRows,
    rows_per_sec_receive: summary.rowsPerSecReceive,
    rows_per_sec_persist: summary.rowsPerSecPersist,
    suspected_bottleneck: summary.suspectedBottleneck,
    error: summary.error,
  };
}

interface SerializedSensorColumns {
  ppgGreen: number | null;
  ppgRedIr: number | null;
  spo2Red: number | null;
  spo2Ir: number | null;
  skinTempRaw: number | null;
  ambientLight: number | null;
  ledDrive1: number | null;
  ledDrive2: number | null;
  respRateRaw: number | null;
  signalQuality: number | null;
  skinContact: number | null;
  accelGravityX: number | null;
  accelGravityY: number | null;
  accelGravityZ: number | null;
}

function serializeSensorColumns(value: SensorDataPacket | null): SerializedSensorColumns {
  if (!value) {
    return {
      ppgGreen: null,
      ppgRedIr: null,
      spo2Red: null,
      spo2Ir: null,
      skinTempRaw: null,
      ambientLight: null,
      ledDrive1: null,
      ledDrive2: null,
      respRateRaw: null,
      signalQuality: null,
      skinContact: null,
      accelGravityX: null,
      accelGravityY: null,
      accelGravityZ: null,
    };
  }

  return {
    ppgGreen: value.ppg_green,
    ppgRedIr: value.ppg_red_ir,
    spo2Red: value.spo2_red,
    spo2Ir: value.spo2_ir,
    skinTempRaw: value.skin_temp_raw,
    ambientLight: value.ambient_light,
    ledDrive1: value.led_drive_1,
    ledDrive2: value.led_drive_2,
    respRateRaw: value.resp_rate_raw,
    signalQuality: value.signal_quality,
    skinContact: value.skin_contact,
    accelGravityX: value.accel_gravity[0] ?? null,
    accelGravityY: value.accel_gravity[1] ?? null,
    accelGravityZ: value.accel_gravity[2] ?? null,
  };
}

function shouldPersistHistoryReading(reading: {
  bpm: number;
  rr: number[];
  sensorData: SensorDataPacket | null;
}) {
  return isPlausibleRecordedBpm(reading.bpm) || reading.rr.length > 0 || reading.sensorData !== null;
}

function rrToString(rr: number[]) {
  return rr.join(',');
}

function toError(error: unknown, fallbackMessage: string) {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function isRetryableSqliteWriteError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('database is locked') ||
    message.includes('database locked') ||
    message.includes('database is busy') ||
    message.includes('database busy')
  );
}

async function retryHistoryWrite<T>(task: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await task();
    } catch (error) {
      attempt += 1;
      if (!isRetryableSqliteWriteError(error) || attempt > HISTORY_WRITE_MAX_RETRIES) {
        throw error;
      }

      await delay(HISTORY_WRITE_RETRY_DELAY_MS * attempt);
    }
  }
}

type TransactionWriter = Pick<SQLiteDatabase, 'runAsync' | 'execAsync'> & {
  prepareAsync?: SQLiteDatabase['prepareAsync'];
};

type PreparedTransactionStatement = Pick<SQLiteStatement, 'executeAsync' | 'finalizeAsync'>;

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

async function writeHistoryRows(
  tx: TransactionWriter,
  rows: PendingHistoryRow[],
) {
  if (typeof tx.prepareAsync !== 'function') {
    for (const row of rows) {
      await tx.runAsync(
        HISTORY_INSERT_SQL,
        row.bpm,
        row.time,
        row.rrIntervals,
        row.ppgGreen,
        row.ppgRedIr,
        row.spo2Red,
        row.spo2Ir,
        row.skinTempRaw,
        row.ambientLight,
        row.ledDrive1,
        row.ledDrive2,
        row.respRateRaw,
        row.signalQuality,
        row.skinContact,
        row.accelGravityX,
        row.accelGravityY,
        row.accelGravityZ,
      );
    }
    return;
  }

  let statement: PreparedTransactionStatement | null = null;

  try {
    statement = await tx.prepareAsync(HISTORY_INSERT_SQL);

    for (const row of rows) {
      await statement.executeAsync(
        row.bpm,
        row.time,
        row.rrIntervals,
        row.ppgGreen,
        row.ppgRedIr,
        row.spo2Red,
        row.spo2Ir,
        row.skinTempRaw,
        row.ambientLight,
        row.ledDrive1,
        row.ledDrive2,
        row.respRateRaw,
        row.signalQuality,
        row.skinContact,
        row.accelGravityX,
        row.accelGravityY,
        row.accelGravityZ,
      );
    }
  } finally {
    await statement?.finalizeAsync();
  }
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
  ppgGreen: number | null;
  ppgRedIr: number | null;
  spo2Red: number | null;
  spo2Ir: number | null;
  skinTempRaw: number | null;
  ambientLight: number | null;
  ledDrive1: number | null;
  ledDrive2: number | null;
  respRateRaw: number | null;
  signalQuality: number | null;
  skinContact: number | null;
  accelGravityX: number | null;
  accelGravityY: number | null;
  accelGravityZ: number | null;
}

interface PendingHistoryAck {
  cursor: number;
  targetPersistedCount: number;
  enqueuedAtMs: number;
}

export interface SyncExecutionOutcome {
  status: 'success' | 'skipped';
  importedReadings: number;
  completedAt: string;
  reason?: string;
}

export interface SyncRunOptions {
  abortSignal?: AbortSignal;
  allowDiscoveryScan?: boolean;
  allowRescan?: boolean;
  maxDurationMs?: number;
  requireExistingConnection?: boolean;
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
  private liveUpdatesHandle: LiveConnectionHandle | null = null;
  private liveDeviceEventSideEffectsSuspendCount = 0;
  private nextLiveEventId = 0;
  private liveHeartRate: { bpm: number | null; observedAt: number | null } = { bpm: null, observedAt: null };

  constructor(
    private readonly db: SQLiteDatabase,
    private readonly connectionManager: WearableConnectionManager = new WearableConnectionManager(),
  ) {}

  async dispose() {
    await this.connectionManager.dispose();
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
    return this.connectionManager.scan();
  }

  async selectDevice(device: WearableScanResult) {
    await this.stopLiveUpdates();
    await this.connectionManager.disconnect();
    this.clearLiveHeartRate();
    await this.db.execAsync('DELETE FROM device_state;');
    await this.persistDeviceState({
      id: device.id,
      name: device.name,
    });
  }

  async forgetDevice() {
    await this.stopLiveUpdates();
    await this.connectionManager.disconnect();
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

  private async updateTonightWidgetPowerFromDatabase() {
    await updateTonightWidgetFromDatabase(this.db).catch(() => {});
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

  private toLiveEvent(parsed: ParsedNotification): WearableLiveEvent | null {
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
      case EventNumber.ExtendedBatteryInformation:
        return this.createLiveEvent('event', 'extended-battery-event', 'Extended battery event', null, parsed.event.unix);
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
      case EventNumber.DoubleTap:
        return this.createLiveEvent('event', 'double-tap', 'Device double tapped', null, parsed.event.unix);
      case EventNumber.StrapDrivenAlarmSet:
        return this.createLiveEvent('event', 'strap-alarm-set', 'Strap alarm set', null, parsed.event.unix);
      case EventNumber.StrapDrivenAlarmExecuted:
        return this.createLiveEvent('event', 'strap-alarm-executed', 'Strap alarm executed', null, parsed.event.unix);
      case EventNumber.AppDrivenAlarmExecuted:
        return this.createLiveEvent('event', 'app-alarm-executed', 'App alarm executed', null, parsed.event.unix);
      case EventNumber.StrapDrivenAlarmDisabled:
        return this.createLiveEvent('event', 'strap-alarm-disabled', 'Strap alarm disabled', null, parsed.event.unix);
      case EventNumber.HighFreqSyncPrompt:
        return this.createLiveEvent('event', 'high-frequency-sync-prompt', 'High-frequency sync prompt', null, parsed.event.unix);
    }

    return null;
  }

  private recordLiveEvent(parsed: ParsedNotification, onLiveEvent?: LiveEventRecorder) {
    if (!onLiveEvent) {
      return;
    }

    const event = this.toLiveEvent(parsed);
    if (event) {
      onLiveEvent(event);
    }
  }

  private async notifyForWearableNotification(
    parsed: ParsedNotification,
    deviceId: string,
    deviceName: string | null,
  ) {
    if (parsed.type === 'battery') {
      await notifyForWearableBatteryLevelAsync(this.db, deviceId, deviceName, parsed.battery.percent);
      return;
    }

    if (parsed.type !== 'event') {
      return;
    }

    if (
      parsed.event.event === EventNumber.AppDrivenAlarmExecuted ||
      parsed.event.event === EventNumber.StrapDrivenAlarmExecuted
    ) {
      await markOneOffSleepAlarmExecutedFromDatabase(this.db, new Date(parsed.event.unix));
      await recordAppIntentEvent(this.db, {
        kind: 'wearable_alarm',
        entityId: `${parsed.event.event}:${parsed.event.unix}`,
        occurredAt: new Date(parsed.event.unix),
        payload: {
          deviceId,
          deviceName,
          eventNumber: parsed.event.event,
          source:
            parsed.event.event === EventNumber.AppDrivenAlarmExecuted
              ? 'app-driven'
              : 'strap-driven',
        },
      });
    }

    await notifyForWearableEventAsync(this.db, deviceId, deviceName, parsed.event);

    if ('percent' in parsed.event) {
      await notifyForWearableBatteryLevelAsync(this.db, deviceId, deviceName, parsed.event.percent);
    }
  }

  async startLiveUpdates(onDeviceState: (state: DeviceState) => void, onLiveEvent?: LiveEventRecorder) {
    await this.stopLiveUpdates();

    const selected = await this.getDeviceState();
    if (!selected.id) {
      return;
    }

    let closed = false;
    let resolvedDeviceId = selected.id;
    let resolvedDeviceName = selected.name;
    let reconnectAssertionId: number | null = null;
    let reconnectAssertionPending = false;
    let reconnectAssertionTimer: ReturnType<typeof setTimeout> | null = null;

    const endLiveReconnectAssertion = async () => {
      if (reconnectAssertionTimer) {
        clearTimeout(reconnectAssertionTimer);
        reconnectAssertionTimer = null;
      }

      const assertionId = reconnectAssertionId;
      reconnectAssertionId = null;
      reconnectAssertionPending = false;
      await endBackgroundExecutionAssertionAsync(assertionId);
    };

    const beginLiveReconnectAssertion = async () => {
      if (reconnectAssertionId !== null || reconnectAssertionPending) {
        return;
      }

      reconnectAssertionPending = true;
      const assertionId = await beginBackgroundExecutionAssertionAsync('LiveBleReconnect');
      if (closed) {
        reconnectAssertionPending = false;
        await endBackgroundExecutionAssertionAsync(assertionId);
        return;
      }

      reconnectAssertionId = assertionId;
      reconnectAssertionPending = false;

      if (assertionId !== null) {
        reconnectAssertionTimer = setTimeout(() => {
          const expiredAssertionId = reconnectAssertionId;
          reconnectAssertionId = null;
          reconnectAssertionTimer = null;
          void endBackgroundExecutionAssertionAsync(expiredAssertionId);
        }, LIVE_RECONNECT_BACKGROUND_ASSERTION_MAX_MS);
      }
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
      if (update.batteryPercent !== undefined || update.chargingStatus !== undefined) {
        await this.updateTonightWidgetPowerFromDatabase();
      }
      onDeviceState(await this.getDeviceState());
    };

    const handleNotification = async (parsed: ParsedNotification) => {
      const suppressEventSideEffects =
        parsed.type === 'event' && this.liveDeviceEventSideEffectsSuspendCount > 0;

      if (!suppressEventSideEffects) {
        this.recordLiveEvent(parsed, onLiveEvent);
        void this.notifyForWearableNotification(parsed, resolvedDeviceId, resolvedDeviceName).catch(() => {});
      }

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

      if (suppressEventSideEffects) {
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

    const sendLiveSetupCommands = async () => {
      await this.sendCommand(helloHarvardPacket());
      await this.sendCommand(toggleRealtimeHrPacket(true));
      await this.sendCommand(getBatteryLevelPacket());
      await this.sendCommand(getBodyLocationAndStatusPacket());
      await this.sendCommand(getNamePacket());
      await this.sendCommand(versionInfoPacket());
    };

    const unsubscribePackets = this.connectionManager.addPacketConsumer(({ parsed }) => {
      if (closed) {
        return;
      }

      void handleNotification(parsed).catch(() => {});
    });

    const cleanup = async () => {
      closed = true;
      unsubscribePackets();
      await endLiveReconnectAssertion();
      await this.sendCommand(toggleRealtimeHrPacket(false)).catch(() => {});
      const handle = this.liveUpdatesHandle;
      this.liveUpdatesHandle = null;
      await handle?.stop();
      if (this.liveUpdatesCleanup === cleanup) {
        this.liveUpdatesCleanup = null;
      }
      this.clearLiveHeartRate();
    };

    this.liveUpdatesCleanup = cleanup;
    this.liveUpdatesHandle = await this.connectionManager.startLiveConnection(selected, {
      onConnected: async (lease) => {
        if (closed) {
          return;
        }

        await endLiveReconnectAssertion();
        resolvedDeviceId = lease.resolvedDeviceId;
        resolvedDeviceName = lease.resolvedDeviceName;
        await this.persistDeviceState({
          id: resolvedDeviceId,
          name: resolvedDeviceName,
        });
        onDeviceState(await this.getDeviceState());
        await sendLiveSetupCommands();
      },
      onDisconnected: async () => {
        if (closed) {
          return;
        }

        await beginLiveReconnectAssertion();
        this.clearLiveHeartRate();
        onDeviceState(await this.getDeviceState());
      },
    });
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
      async () => {
        await this.sendCommand(helloHarvardPacket());
        await this.sendCommand(setClockPacket(Math.floor(Date.now() / 1000)));
        await this.sendCommand(setAlarmPacket(unixSeconds));
      },
      onLiveEvent,
    );

    onProgress?.({
      status: 'complete',
      message: `Alarm set for ${formatSqliteDateTime(alarmAt)}.`,
    });
  }

  private async rearmEnabledSleepAlarm() {
    const alarmAt = await resolveNextWearableAlarmDateFromDatabase(this.db);
    if (!alarmAt) {
      await this.sendCommand(disableAlarmPacket());
      return null;
    }

    const alarmUnixSeconds = Math.floor(alarmAt.getTime() / 1000);
    await this.sendCommand(setAlarmPacket(alarmUnixSeconds));

    return {
      alarmAt,
      alarmUnixSeconds,
    };
  }

  async disableAlarm(onProgress?: (progress: SyncProgress) => void, onLiveEvent?: LiveEventRecorder) {
    await this.runDeviceCommand(
      onProgress,
      'Disabling alarm on the wearable...',
      async () => {
        await this.sendCommand(helloHarvardPacket());
        await this.sendCommand(disableAlarmPacket());
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
      async () => {
        await this.sendCommand(helloHarvardPacket());
        await this.sendCommand(restartPacket());
      },
      onLiveEvent,
    );

    onProgress?.({
      status: 'complete',
      message: 'Restart command sent. The wearable may disappear briefly while it boots back up.',
    });
  }

  async syncInBackground(options?: SyncRunOptions): Promise<SyncExecutionOutcome> {
    return this.runSync('background', undefined, undefined, options);
  }

  async syncOnLiveConnection(options?: SyncRunOptions): Promise<SyncExecutionOutcome> {
    return this.runSync('background', undefined, undefined, {
      ...options,
      allowDiscoveryScan: false,
      allowRescan: false,
      requireExistingConnection: true,
    });
  }

  private async runSync(
    source: SyncRunSource,
    onProgress?: (progress: SyncProgress) => void,
    onLiveEvent?: LiveEventRecorder,
    options?: SyncRunOptions,
  ): Promise<SyncExecutionOutcome> {
    const selected = await this.getDeviceState();
    if (!selected.id) {
      throw new Error('Select a wearable before syncing.');
    }

    const startedAt = formatSqliteDateTime(new Date());
    await recordBackgroundRunStart(this.db, {
      deviceId: selected.id,
      source,
      startedAt,
    }).catch(() => {});

    const lockOwner = `${source}:${Date.now()}`;
    const lockAcquired = await acquireBackgroundSyncLock(this.db, lockOwner);
    if (!lockAcquired) {
      const completedAt = formatSqliteDateTime(new Date());
      await recordBackgroundRunResult(this.db, {
        deviceId: selected.id,
        source,
        result: 'skipped',
        finishedAt: completedAt,
        importedReadings: 0,
        error: 'sync-lock-active',
      }).catch(() => {});
      onProgress?.({
        status: 'complete',
        message: source === 'foreground'
          ? 'A sync is already running. Wait for it to finish before starting another one.'
          : 'Skipped sync because another sync is already running.',
        importedReadings: 0,
      });
      return {
        status: 'skipped',
        importedReadings: 0,
        completedAt,
        reason: 'sync-lock-active',
      };
    }

    onProgress?.({ status: 'connecting', message: `Connecting to ${selected.name ?? 'wearable'}...` });

    let connectionLease: Awaited<ReturnType<WearableConnectionManager['acquireConnection']>> | null = null;
    let firmware: string | null = null;
    let batteryPercent: number | null = null;
    let importedReadings = 0;
    let lastHistoryCursor = 0;
    let earliestImportedTime: string | null = null;
    let latestImportedTime: string | null = null;
    let resolvedDeviceId = selected.id;
    let resolvedDeviceName = selected.name;
    let pendingHistoryRows: PendingHistoryRow[] = [];
    let pendingHistoryAcks: PendingHistoryAck[] = [];
    let historyFlushQueued = false;
    let historyAckQueued = false;
    let writeQueue = Promise.resolve();
    let commandQueue = Promise.resolve();
    let writeFailure: Error | null = null;
    let failSync: ((error: Error) => void) | null = null;
    let queuedPersistableHistoryRowCount = 0;
    let persistedHistoryRowCount = 0;
    const syncStartedAtMs = Date.now();
    let connectStartedAtMs: number | null = null;
    let connectCompletedAtMs: number | null = null;
    let historyRequestedAtMs: number | null = null;
    let historyFirstPacketAtMs: number | null = null;
    let historyLastPacketAtMs: number | null = null;
    let historyCompletedAtMs: number | null = null;
    let historyEndCount = 0;
    let ackSentCount = 0;
    let flushCount = 0;
    let flushRowsTotal = 0;
    let flushMsTotal = 0;
    let flushMsMax = 0;
    let ackWaitMsTotal = 0;
    let ackWaitMsMax = 0;
    let maxPendingHistoryRows = 0;
    let historyPacketsWithImu = 0;
    let historyPacketsWithSensor = 0;
    let historyPacketsWithoutSensorOrImu = 0;
    let maxImuSamplesPerHistoryPacket = 0;
    let firstImuReadingTime: string | null = null;
    let firstSensorReadingTime: string | null = null;
    let loggedHistoryPacketSamples = 0;
    const historyPacketShapeCounts = new Map<string, number>();
    const timeBudgetDeadlineMs =
      options?.maxDurationMs && options.maxDurationMs > 0
        ? syncStartedAtMs + options.maxDurationMs
        : null;
    let stoppedForTimeBudget = false;
    let stopReason: 'expiration' | 'time-budget' | null = null;
    let historyIntakeClosed = false;
    let importedRowsFinalized = false;
    let unsubscribeSyncPackets: (() => void) | null = null;
    let resolveBatteryResponse: ((value: number | null) => void) | null = null;
    this.liveDeviceEventSideEffectsSuspendCount += 1;

    const closeHistorySubscriptions = () => {
      unsubscribeSyncPackets?.();
      unsubscribeSyncPackets = null;
      resolveBatteryResponse?.(null);
      resolveBatteryResponse = null;
    };

    const summarizeSyncPerf = (
      status: BackgroundSyncResult,
      errorMessage?: string | null,
    ): SyncImportPerformanceSummary => {
      const connectMs =
        connectStartedAtMs !== null && connectCompletedAtMs !== null
          ? connectCompletedAtMs - connectStartedAtMs
          : null;
      const historyReceiveMs =
        historyFirstPacketAtMs !== null && historyLastPacketAtMs !== null
          ? Math.max(historyLastPacketAtMs - historyFirstPacketAtMs, 0)
          : null;
      const requestToCompleteMs =
        historyRequestedAtMs !== null && historyCompletedAtMs !== null
          ? Math.max(historyCompletedAtMs - historyRequestedAtMs, 0)
          : null;
      const averageFlushMs = flushCount > 0 ? Math.round(flushMsTotal / flushCount) : null;
      const averageAckWaitMs = ackSentCount > 0 ? Math.round(ackWaitMsTotal / ackSentCount) : null;
      const receiveRowsPerSecond =
        historyReceiveMs && historyReceiveMs > 0
          ? Math.round((importedReadings * 1000) / historyReceiveMs)
          : null;
      const persistedRowsPerSecond =
        flushMsTotal > 0
          ? Math.round((persistedHistoryRowCount * 1000) / flushMsTotal)
          : null;

      let suspectedBottleneck: 'ble' | 'db' | 'mixed' | 'unknown' = 'unknown';
      if (importedReadings === 0) {
        suspectedBottleneck = 'unknown';
      } else if (ackWaitMsTotal > 1000 || maxPendingHistoryRows > HISTORY_WRITE_BATCH_SIZE * 3) {
        suspectedBottleneck = 'db';
      } else if (historyReceiveMs !== null && flushMsTotal < Math.max(historyReceiveMs * 0.2, 250)) {
        suspectedBottleneck = 'ble';
      } else if (flushCount > 0) {
        suspectedBottleneck = 'mixed';
      }

      const summary: SyncImportPerformanceSummary = {
        source,
        status,
        capturedAt: formatSqliteDateTime(new Date()),
        totalMs: Date.now() - syncStartedAtMs,
        connectMs,
        historyRequestToCompleteMs: requestToCompleteMs,
        historyReceiveMs,
        dbFlushMsTotal: flushMsTotal,
        dbFlushMsAvg: averageFlushMs,
        dbFlushMsMax: flushMsMax,
        ackWaitMsTotal: ackWaitMsTotal,
        ackWaitMsAvg: averageAckWaitMs,
        ackWaitMsMax: ackWaitMsMax,
        importedRows: importedReadings,
        persistedRows: persistedHistoryRowCount,
        flushCount,
        flushRowsTotal,
        historyEndCount,
        ackSentCount,
        maxPendingRows: maxPendingHistoryRows,
        rowsPerSecReceive: receiveRowsPerSecond,
        rowsPerSecPersist: persistedRowsPerSecond,
        suspectedBottleneck,
        error: errorMessage ?? null,
      };

      if (importedReadings > 0) {
        logSyncImportPerfSummary('sync.history.summary', {
          firmware,
          history_packets: importedReadings,
          imu_packets: historyPacketsWithImu,
          sensor_packets: historyPacketsWithSensor,
          empty_packets: historyPacketsWithoutSensorOrImu,
          imu_packet_pct: Math.round((historyPacketsWithImu / importedReadings) * 1000) / 10,
          packet_shapes: formatLogCounter(historyPacketShapeCounts) || null,
          max_imu_samples: maxImuSamplesPerHistoryPacket || null,
          first_imu_time: firstImuReadingTime,
          first_sensor_time: firstSensorReadingTime,
        });
      }

      logSyncImportPerfSummary('sync.import.summary', toSyncImportPerfLogDetails(summary));
      return summary;
    };

    const recordWriteFailure = (error: unknown) => {
      const resolved = toError(error, 'Failed to persist wearable history.');
      if (!writeFailure) {
        writeFailure = resolved;
      }
      return writeFailure;
    };

    const queueWrite = (task: () => Promise<void>) => {
      writeQueue = writeQueue
        .catch(() => {})
        .then(async () => {
          if (writeFailure) {
            throw writeFailure;
          }

          try {
            await task();
          } catch (error) {
            throw recordWriteFailure(error);
          }
        });
      return writeQueue;
    };

    const queueCommand = (task: () => Promise<void>) => {
      commandQueue = commandQueue.then(task);
      return commandQueue;
    };

    const flushPendingHistoryRows = async (limit = HISTORY_WRITE_BATCH_SIZE) => {
      if (pendingHistoryRows.length === 0) {
        return;
      }

      const rows = pendingHistoryRows.slice(0, Math.min(limit, pendingHistoryRows.length));
      const flushStartedAt = Date.now();

      await retryHistoryWrite(async () => {
        await withExclusiveTransaction(this.db, async (tx) => {
          await writeHistoryRows(tx, rows);
        });
      });

      pendingHistoryRows.splice(0, rows.length);
      persistedHistoryRowCount += rows.length;
      const flushDurationMs = Date.now() - flushStartedAt;
      flushCount += 1;
      flushRowsTotal += rows.length;
      flushMsTotal += flushDurationMs;
      flushMsMax = Math.max(flushMsMax, flushDurationMs);
    };

    const drainPendingHistoryRows = async () => {
      while (pendingHistoryRows.length > 0) {
        await flushPendingHistoryRows();
      }
    };

    const finalizeImportedRows = async () => {
      if (importedRowsFinalized) {
        return;
      }

      await queueWrite(async () => {
        await drainPendingHistoryRows();
      });
      await writeQueue;
      importedRowsFinalized = true;

      if (earliestImportedTime && latestImportedTime) {
        try {
          await refreshHeartAggregatesForRange(this.db, earliestImportedTime, latestImportedTime);
        } catch (error) {
          console.warn(
            '[wearable-sync] Failed to refresh heart aggregates after imported rows',
            error instanceof Error ? error.message : String(error),
          );
        }

        await markDerivedRefreshPending(this.db, earliestImportedTime, latestImportedTime).catch((error) => {
          console.warn(
            '[wearable-sync] Failed to mark derived refresh after imported rows',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    };

    const queuePendingHistoryFlush = () => {
      if (historyFlushQueued || writeFailure) {
        return;
      }

      historyFlushQueued = true;
      void queueWrite(async () => {
        await flushPendingHistoryRows();
      })
        .catch((error) => {
          failSync?.(recordWriteFailure(error));
        })
        .finally(() => {
          historyFlushQueued = false;

          if (!writeFailure && pendingHistoryRows.length >= HISTORY_WRITE_BATCH_SIZE) {
            queuePendingHistoryFlush();
          }
        }
      );
    };

    const queuePendingHistoryAckProcessing = () => {
      if (historyAckQueued || writeFailure) {
        return;
      }

      historyAckQueued = true;
      void queueWrite(async () => {
        while (pendingHistoryAcks.length > 0) {
          const nextAck = pendingHistoryAcks[0];

          while (persistedHistoryRowCount < nextAck.targetPersistedCount) {
            if (pendingHistoryRows.length === 0) {
              throw new Error('History ACK is waiting for rows that were not available to flush.');
            }

            await flushPendingHistoryRows();
          }

          await queueCommand(() =>
            this.sendCommand(
              historyEndPacket(nextAck.cursor),
            ),
          );
          const ackWaitMs = Date.now() - nextAck.enqueuedAtMs;
          ackSentCount += 1;
          ackWaitMsTotal += ackWaitMs;
          ackWaitMsMax = Math.max(ackWaitMsMax, ackWaitMs);
          pendingHistoryAcks.shift();
        }
      })
        .catch((error) => {
          failSync?.(recordWriteFailure(error));
        })
        .finally(() => {
          historyAckQueued = false;

          if (!writeFailure && pendingHistoryAcks.length > 0) {
            queuePendingHistoryAckProcessing();
          }
        }
      );
    };

    const requestBatteryPercentFromSyncStream = async () => {
      if (!connectionLease) {
        return null;
      }

      resolveBatteryResponse?.(null);

      let timeout: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      let finish: (value: number | null) => void = () => {};
      const response = new Promise<number | null>((resolve) => {
        finish = (value) => {
          if (finished) {
            return;
          }

          finished = true;
          if (timeout !== null) {
            clearTimeout(timeout);
          }
          if (resolveBatteryResponse === finish) {
            resolveBatteryResponse = null;
          }
          resolve(value);
        };
        resolveBatteryResponse = finish;
        timeout = setTimeout(() => {
          finish(null);
        }, BATTERY_REQUEST_TIMEOUT_MS);
      });

      await this.sendCommand(getBatteryLevelPacket()).catch(() => {
        finish(null);
      });

      return response;
    };

    try {
      connectStartedAtMs = Date.now();
      connectionLease = await this.connectionManager.acquireConnection(
        selected,
        onProgress,
        {
          allowDiscoveryScan: options?.allowDiscoveryScan ?? source === 'foreground',
          allowRescan: options?.allowRescan ?? source === 'foreground',
          requireExistingConnection: options?.requireExistingConnection ?? false,
        },
      );
      resolvedDeviceId = connectionLease.resolvedDeviceId;
      resolvedDeviceName = connectionLease.resolvedDeviceName;
      connectCompletedAtMs = Date.now();

      const completion = new Promise<void>((resolve, reject) => {
        let settled = false;
        const watchdog = new HistorySyncWatchdog();
        const budgetDelayMs =
          timeBudgetDeadlineMs === null
            ? null
            : Math.max(0, timeBudgetDeadlineMs - Date.now() - BACKGROUND_SYNC_CLEANUP_RESERVE_MS);
        let budgetTimer: ReturnType<typeof setTimeout> | null = null;
        let abortListener: (() => void) | null = null;

        const clearTimers = () => {
          clearInterval(watchdogTimer);
          if (budgetTimer !== null) {
            clearTimeout(budgetTimer);
          }
          if (abortListener !== null) {
            options?.abortSignal?.removeEventListener('abort', abortListener);
            abortListener = null;
          }
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
        failSync = fail;

        const finishForStopRequest = (reason: 'expiration' | 'time-budget') => {
          if (settled) {
            return;
          }

          stoppedForTimeBudget = true;
          stopReason = reason;
          historyIntakeClosed = true;
          closeHistorySubscriptions();
          onProgress?.({
            status: 'syncing',
            message:
              reason === 'expiration'
                ? `Background sync window expired. Finishing ${importedReadings} readings already received...`
                : `Background sync window is closing. Finishing ${importedReadings} readings already received...`,
            importedReadings,
          });
          succeed();
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
        budgetTimer =
          budgetDelayMs === null
            ? null
            : setTimeout(() => {
                finishForStopRequest('time-budget');
              }, budgetDelayMs);

        abortListener = () => {
          finishForStopRequest('expiration');
        };
        if (options?.abortSignal?.aborted) {
          finishForStopRequest('expiration');
        } else {
          options?.abortSignal?.addEventListener('abort', abortListener, { once: true });
        }

        const handleSyncPacket = (frame: FramedPacket, parsed: ParsedNotification) => {
          if (historyIntakeClosed) {
            return;
          }

          watchdog.markPacketActivity();
          if (parsed.type !== 'event') {
            this.recordLiveEvent(parsed, onLiveEvent);
            void this.notifyForWearableNotification(parsed, resolvedDeviceId, resolvedDeviceName).catch(() => {});
          }

          if (parsed.type === 'battery') {
            batteryPercent = parsed.battery.percent;
            resolveBatteryResponse?.(parsed.battery.percent);
          }

          if (writeFailure) {
            fail(writeFailure);
            return;
          }

          if (parsed.type === 'history') {
            if (historyFirstPacketAtMs === null) {
              historyFirstPacketAtMs = Date.now();
            }
            historyLastPacketAtMs = Date.now();
            importedReadings += 1;
            lastHistoryCursor = parsed.reading.unix;
            watchdog.markProgress();

            const readingTime = formatSqliteDateTime(new Date(parsed.reading.unix));
            const imuSampleCount = parsed.reading.imuSampleCount;
            const hasImuData = imuSampleCount > 0;
            const hasSensorData = parsed.reading.sensorData !== null;

            incrementLogCounter(historyPacketShapeCounts, `${frame.seq}:${frame.data.length}`);

            if (hasImuData) {
              historyPacketsWithImu += 1;
              maxImuSamplesPerHistoryPacket = Math.max(maxImuSamplesPerHistoryPacket, imuSampleCount);
              firstImuReadingTime ??= readingTime;
            } else if (hasSensorData) {
              historyPacketsWithSensor += 1;
              firstSensorReadingTime ??= readingTime;
            } else {
              historyPacketsWithoutSensorOrImu += 1;
            }

            if (loggedHistoryPacketSamples < HISTORY_PACKET_DEBUG_SAMPLE_LIMIT) {
              loggedHistoryPacketSamples += 1;
              logSyncImportPerfSummary('sync.history.packet', {
                index: importedReadings,
                seq: frame.seq,
                payload_len: frame.data.length,
                has_imu: hasImuData,
                imu_samples: imuSampleCount || null,
                has_sensor: hasSensorData,
                bpm: parsed.reading.bpm,
                time: readingTime,
              });
            }

            if (!shouldPersistHistoryReading(parsed.reading)) {
              return;
            }

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
              ...serializeSensorColumns(parsed.reading.sensorData),
            });
            queuedPersistableHistoryRowCount += 1;
            maxPendingHistoryRows = Math.max(maxPendingHistoryRows, pendingHistoryRows.length);

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
              historyEndCount += 1;
              pendingHistoryAcks.push({
                cursor: parsed.metadata.data,
                targetPersistedCount: queuedPersistableHistoryRowCount,
                enqueuedAtMs: Date.now(),
              });
              queuePendingHistoryAckProcessing();
            }

            if (parsed.metadata.kind === 3) {
              historyCompletedAtMs = Date.now();
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
        };

        unsubscribeSyncPackets = this.connectionManager.addPacketConsumer(({ frame, parsed }) => {
          try {
            handleSyncPacket(frame, parsed);
          } catch (error) {
            fail(toError(error, 'Failed to process wearable packet.'));
          }
        });
      });

      await this.sendCommand(helloHarvardPacket());
      await this.sendCommand(setClockPacket(Math.floor(Date.now() / 1000)));
      if (!stoppedForTimeBudget) {
        await this.rearmEnabledSleepAlarm().catch(() => null);
      }
      await this.sendCommand(getNamePacket());
      await this.sendCommand(versionInfoPacket());
      await this.sendCommand(toggleR7DataCollectionPacket(false));
      batteryPercent = await requestBatteryPercentFromSyncStream();
      await this.sendCommand(enterHighFrequencySyncPacket());

      onProgress?.({ status: 'syncing', message: 'Requesting wearable history...' });
      historyRequestedAtMs = Date.now();
      if (!stoppedForTimeBudget) {
        await this.sendCommand(historyStartPacket());
      }
      await completion;
      historyIntakeClosed = true;
      closeHistorySubscriptions();

      await finalizeImportedRows();

      const completedAt = formatSqliteDateTime(new Date());
      await this.persistDeviceState({
        id: resolvedDeviceId,
        name: resolvedDeviceName,
        lastSyncedAt: completedAt,
        firmware,
        batteryPercent,
      });

      await recordBackgroundRunResult(this.db, {
        deviceId: resolvedDeviceId,
        source,
        result: 'success',
        finishedAt: completedAt,
        importedReadings,
        error: null,
      }).catch(() => {});
      onProgress?.({
        status: 'complete',
        message: stoppedForTimeBudget
          ? `Background sync paused safely after importing ${importedReadings} readings.`
          : `Sync complete. Imported ${importedReadings} readings.`,
        importedReadings,
      });
      await recordSyncImportSummary(this.db, summarizeSyncPerf('success')).catch(() => {});
      return {
        status: 'success',
        importedReadings,
        completedAt,
        reason: stopReason ?? undefined,
      };
    } catch (error) {
      const message = formatBleError(error);
      await finalizeImportedRows().catch((finalizeError) => {
        console.warn(
          '[wearable-sync] Failed to finalize imported rows after sync error',
          finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
        );
      });
      await this.persistDeviceState({
        id: resolvedDeviceId,
        name: resolvedDeviceName,
        lastSyncedAt: selected.lastSyncedAt,
        firmware,
        syncError: message,
      });
      await recordBackgroundRunResult(this.db, {
        deviceId: resolvedDeviceId,
        source,
        result: 'error',
        finishedAt: formatSqliteDateTime(new Date()),
        importedReadings,
        error: message,
      }).catch(() => {});
      onProgress?.({ status: 'error', message });
      await recordSyncImportSummary(this.db, summarizeSyncPerf('error', message)).catch(() => {});
      throw error;
    } finally {
      failSync = null;
      await finalizeImportedRows().catch(() => {});
      await commandQueue.catch(() => {});

      closeHistorySubscriptions();
      this.liveDeviceEventSideEffectsSuspendCount = Math.max(
        0,
        this.liveDeviceEventSideEffectsSuspendCount - 1,
      );

      try {
        await this.sendCommand(exitHighFrequencySyncPacket());
      } catch {}

      if (connectionLease && (options?.requireExistingConnection || this.liveUpdatesHandle)) {
        await this.sendCommand(helloHarvardPacket()).catch(() => {});
        await this.sendCommand(toggleRealtimeHrPacket(true)).catch(() => {});
        await this.sendCommand(getBatteryLevelPacket()).catch(() => {});
        await this.sendCommand(getBodyLocationAndStatusPacket()).catch(() => {});
      }

      await connectionLease?.release({ disconnectIfIdle: !options?.requireExistingConnection });

      await releaseBackgroundSyncLock(this.db, lockOwner).catch((error) => {
        console.warn(
          '[wearable-sync] Failed to release background sync lock',
          JSON.stringify({
            owner: lockOwner,
            source,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }
  }

  private async sendCommand(bytes: Uint8Array) {
    await this.connectionManager.sendCommand(bytes);
  }

  private async requestBatteryPercent(onLiveEvent?: LiveEventRecorder): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      let settled = false;
      let unsubscribePackets: (() => void) | null = null;

      const finish = (batteryPercent: number | null) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        unsubscribePackets?.();
        resolve(batteryPercent);
      };

      const timeout = setTimeout(() => {
        finish(null);
      }, BATTERY_REQUEST_TIMEOUT_MS);

      unsubscribePackets = this.connectionManager.addPacketConsumer(({ parsed }) => {
        if (!this.liveUpdatesHandle) {
          this.recordLiveEvent(parsed, onLiveEvent);
        }
        if (parsed.type === 'battery') {
          finish(parsed.battery.percent);
        }
      });

      void this.sendCommand(getBatteryLevelPacket()).catch(() => {
        finish(null);
      });
    });
  }

  private async refreshBatteryPercent(deviceId: string, deviceName: string | null, onLiveEvent?: LiveEventRecorder): Promise<number | null> {
    const batteryPercent = await this.requestBatteryPercent(onLiveEvent);

    if (batteryPercent === null) {
      return null;
    }

    void notifyForWearableBatteryLevelAsync(this.db, deviceId, deviceName, batteryPercent).catch(() => {});

    await this.db.runAsync(
      'UPDATE device_state SET battery_percent = ?, last_seen_at = ? WHERE id = ?',
      batteryPercent,
      formatSqliteDateTime(new Date()),
      deviceId,
    );
    await this.updateTonightWidgetPowerFromDatabase();

    return batteryPercent;
  }

  private async runDeviceCommand(
    onProgress: ((progress: SyncProgress) => void) | undefined,
    workingMessage: string,
    task: () => Promise<void>,
    onLiveEvent?: LiveEventRecorder,
  ) {
    const selected = await this.getDeviceState();
    if (!selected.id) {
      throw new Error('Select a wearable before sending a device command.');
    }

    onProgress?.({ status: 'connecting', message: `Connecting to ${selected.name ?? 'wearable'}...` });

    let resolvedDeviceId = selected.id;
    let resolvedDeviceName = selected.name;
    let lease: Awaited<ReturnType<WearableConnectionManager['acquireConnection']>> | null = null;

    try {
      lease = await this.connectionManager.acquireConnection(selected, onProgress, {
        allowDiscoveryScan: true,
        allowRescan: true,
      });
      resolvedDeviceId = lease.resolvedDeviceId;
      resolvedDeviceName = lease.resolvedDeviceName;
      onProgress?.({ status: 'updating', message: workingMessage });
      await task();
      const batteryPercent = await this.refreshBatteryPercent(resolvedDeviceId, resolvedDeviceName, onLiveEvent);

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
      await lease?.release({ disconnectIfIdle: true });
    }
  }
}
