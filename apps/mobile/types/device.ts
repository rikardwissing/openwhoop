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
  status: 'idle' | 'scanning' | 'connecting' | 'syncing' | 'refreshing' | 'complete' | 'error';
  message: string;
  importedReadings?: number;
}

export interface SyncResult {
  importedReadings: number;
  completedAt: string;
}
