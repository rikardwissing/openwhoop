export type SyncStatus =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'updating'
  | 'syncing'
  | 'refreshing'
  | 'complete'
  | 'error';

export interface WearableScanResult {
  id: string;
  name: string;
  rssi: number | null;
}

export interface DeviceState {
  id: string | null;
  name: string | null;
  lastSeenAt: string | null;
  lastSyncedAt: string | null;
  firmware: string | null;
  batteryPercent: number | null;
  bodyStatus: string | null;
  syncError: string | null;
}

export interface SyncProgress {
  status: SyncStatus;
  message: string;
  importedReadings?: number;
}

export interface SyncResult {
  importedReadings: number;
  completedAt: string;
}

export function isBlockingSyncStatus(status: SyncStatus) {
  return status === 'connecting' || status === 'updating' || status === 'syncing' || status === 'refreshing';
}
