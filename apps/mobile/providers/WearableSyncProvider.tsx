import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSQLiteContext } from 'expo-sqlite';

import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { WearableSyncService } from '@/services/ble/WearableSyncService';
import type { DeviceState, SyncProgress, SyncResult, WearableScanResult } from '@/types/device';

interface WearableSyncContextValue {
  deviceState: DeviceState;
  progress: SyncProgress;
  scanResults: WearableScanResult[];
  scan: () => Promise<void>;
  selectDevice: (device: WearableScanResult) => Promise<void>;
  forgetDevice: () => Promise<void>;
  syncSelected: () => Promise<SyncResult | null>;
  setAlarm: (unixSeconds: number) => Promise<void>;
  disableAlarm: () => Promise<void>;
}

export const emptyDeviceState: DeviceState = {
  id: null,
  name: null,
  lastSeenAt: null,
  lastSyncedAt: null,
  firmware: null,
  batteryPercent: null,
  bodyStatus: null,
  syncError: null,
};

export const defaultWearableSyncContextValue: WearableSyncContextValue = {
  deviceState: emptyDeviceState,
  progress: {
    status: 'idle',
    message: 'Select a wearable and run a manual sync.',
  },
  scanResults: [],
  scan: async () => {},
  selectDevice: async () => {},
  forgetDevice: async () => {},
  syncSelected: async () => null,
  setAlarm: async () => {},
  disableAlarm: async () => {},
};

const WearableSyncContext = createContext<WearableSyncContextValue | null>(null);

export function WearableSyncContextProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WearableSyncContextValue;
}) {
  return (
    <WearableSyncContext.Provider value={value}>
      {children}
    </WearableSyncContext.Provider>
  );
}

export function WearableSyncProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const healthRepository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const [service] = useState(() => new WearableSyncService(db));
  const [deviceState, setDeviceState] = useState<DeviceState>(emptyDeviceState);
  const [progress, setProgress] = useState<SyncProgress>(defaultWearableSyncContextValue.progress);
  const [scanResults, setScanResults] = useState<WearableScanResult[]>([]);

  useEffect(() => {
    let cancelled = false;

    service
      .getDeviceState()
      .then((state) => {
        if (!cancelled) {
          setDeviceState(state);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      void service.dispose();
    };
  }, [service]);

  const value = useMemo<WearableSyncContextValue>(
    () => ({
      deviceState,
      progress,
      scanResults,
      scan: async () => {
        setProgress({
          status: 'scanning',
          message: 'Scanning for nearby wearables...',
        });

        try {
          const results = await service.scan();
          setScanResults(results);
          setProgress({
            status: 'idle',
            message: results.length > 0 ? 'Select a wearable from the scan results.' : 'No wearable was found nearby.',
          });
        } catch (error) {
          setProgress({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to scan for wearables.',
          });
        }
      },
      selectDevice: async (device) => {
        await service.selectDevice(device);
        setDeviceState(await service.getDeviceState());
        setProgress({
          status: 'idle',
          message: `Selected ${device.name}.`,
        });
      },
      forgetDevice: async () => {
        await service.forgetDevice();
        setDeviceState(emptyDeviceState);
        setScanResults([]);
        setProgress({
          status: 'idle',
          message: 'Removed the selected wearable.',
        });
      },
      syncSelected: async () => {
        try {
          const result = await service.syncSelected((next) => {
            setProgress(next);
          });
          setDeviceState(await service.getDeviceState());
          healthRepository.invalidateCaches('all');
          refreshHealthData();
          void healthRepository.warmCaches().catch(() => {});
          return result;
        } catch {
          setDeviceState(await service.getDeviceState());
          return null;
        }
      },
      setAlarm: async (unixSeconds) => {
        try {
          await service.setAlarm(unixSeconds, (next) => {
            setProgress(next);
          });
          setDeviceState(await service.getDeviceState());
        } catch (error) {
          setDeviceState(await service.getDeviceState());
          setProgress({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to update the wearable alarm.',
          });
          throw error;
        }
      },
      disableAlarm: async () => {
        try {
          await service.disableAlarm((next) => {
            setProgress(next);
          });
          setDeviceState(await service.getDeviceState());
        } catch (error) {
          setDeviceState(await service.getDeviceState());
          setProgress({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to disable the wearable alarm.',
          });
          throw error;
        }
      },
    }),
    [deviceState, healthRepository, progress, refreshHealthData, scanResults, service],
  );

  return (
    <WearableSyncContext.Provider value={value}>
      {children}
    </WearableSyncContext.Provider>
  );
}

export function useWearableSync() {
  const value = useContext(WearableSyncContext);

  if (!value) {
    throw new Error('Wearable sync context is not available.');
  }

  return value;
}
