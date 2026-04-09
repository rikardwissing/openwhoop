export type SyncStatus =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'updating'
  | 'syncing'
  | 'refreshing'
  | 'complete'
  | 'error';

export type SyncSource = 'foreground' | 'background';
export type BackgroundSyncResult = 'success' | 'skipped' | 'error';
export type NotificationPermissionState = 'unknown' | 'granted' | 'provisional' | 'denied';
export type SyncImportBottleneck = 'ble' | 'db' | 'mixed' | 'unknown';

export interface WearableScanResult {
  id: string;
  name: string;
  rssi: number | null;
}

export type ChargingState = 'charging' | 'not_charging';
export type WearState = 'on-body' | 'off-body';
export type WearableLiveEventSource = 'event' | 'command';

export interface DeviceState {
  id: string | null;
  name: string | null;
  lastSeenAt: string | null;
  lastSyncedAt: string | null;
  firmware: string | null;
  batteryPercent: number | null;
  chargingStatus: ChargingState | null;
  bodyStatus: WearState | null;
  liveHeartRate: number | null;
  liveHeartRateAt: number | null;
  syncError: string | null;
}

export interface WearableLiveEvent {
  id: string;
  observedAt: string;
  deviceUnixMs?: number | null;
  source: WearableLiveEventSource;
  kind: string;
  title: string;
  detail: string | null;
}

export interface SyncProgress {
  status: SyncStatus;
  message: string;
  importedReadings?: number;
  showOverlay?: boolean;
}

export interface SyncResult {
  importedReadings: number;
  completedAt: string;
}

export interface SyncImportPerformanceSummary {
  source: SyncSource;
  status: BackgroundSyncResult;
  capturedAt: string;
  totalMs: number;
  connectMs: number | null;
  historyRequestToCompleteMs: number | null;
  historyReceiveMs: number | null;
  dbFlushMsTotal: number;
  dbFlushMsAvg: number | null;
  dbFlushMsMax: number;
  ackWaitMsTotal: number;
  ackWaitMsAvg: number | null;
  ackWaitMsMax: number;
  importedRows: number;
  persistedRows: number;
  flushCount: number;
  flushRowsTotal: number;
  historyEndCount: number;
  ackSentCount: number;
  maxPendingRows: number;
  rowsPerSecReceive: number | null;
  rowsPerSecPersist: number | null;
  suspectedBottleneck: SyncImportBottleneck;
  error: string | null;
}

export interface BackgroundSyncState {
  pairedDeviceId: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastSource: SyncSource | null;
  lastResult: BackgroundSyncResult | null;
  lastError: string | null;
  lastImportedReadings: number | null;
  notificationPermission: NotificationPermissionState;
  notificationBaselineAt: string | null;
  lastSyncImportSummary: SyncImportPerformanceSummary | null;
}

export function describeBatteryStatus(batteryPercent: number | null) {
  if (batteryPercent === null) {
    return 'Unknown';
  }

  if (batteryPercent >= 80) {
    return 'High';
  }

  if (batteryPercent >= 40) {
    return 'Okay';
  }

  if (batteryPercent >= 20) {
    return 'Low';
  }

  return 'Critical';
}

export function describeChargingState(chargingStatus: ChargingState | null) {
  if (chargingStatus === 'charging') {
    return 'Charging';
  }

  if (chargingStatus === 'not_charging') {
    return 'Not charging';
  }

  return 'Unknown';
}

export function describeWearState(bodyStatus: WearState | null) {
  if (bodyStatus === 'on-body') {
    return 'On body';
  }

  if (bodyStatus === 'off-body') {
    return 'Off body';
  }

  return 'Unknown';
}

export function hasFreshLiveHeartRate(deviceState: DeviceState, maxAgeMs = 15_000) {
  if (deviceState.liveHeartRate === null || deviceState.liveHeartRateAt === null) {
    return false;
  }

  return Date.now() - deviceState.liveHeartRateAt <= maxAgeMs;
}

export function isBlockingSyncStatus(status: SyncStatus) {
  return status === 'connecting' || status === 'updating' || status === 'syncing' || status === 'refreshing';
}
