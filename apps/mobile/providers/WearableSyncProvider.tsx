import { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { AppState, type AppStateStatus } from 'react-native';

import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { WearableSyncService } from '@/services/ble/WearableSyncService';
import {
  isBlockingSyncStatus,
  type DeviceState,
  type SyncProgress,
  type SyncResult,
  type WearableLiveEvent,
  type WearableScanResult,
} from '@/types/device';
import { parseSqliteDateTime } from '@/utils/dateTime';

const MAX_LIVE_EVENTS = 200;
const FOREGROUND_AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const FOREGROUND_AUTO_SYNC_MIN_DELAY_MS = 5 * 1000;

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface WearableSyncContextValue {
  isReady: boolean;
  deviceState: DeviceState;
  liveEvents: WearableLiveEvent[];
  progress: SyncProgress;
  scanResults: WearableScanResult[];
  scan: () => Promise<void>;
  pairDevice: (device: WearableScanResult) => Promise<SyncResult | null>;
  selectDevice: (device: WearableScanResult) => Promise<void>;
  forgetDevice: () => Promise<void>;
  syncSelected: (options?: { showOverlay?: boolean }) => Promise<SyncResult | null>;
  restartDevice: () => Promise<void>;
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
  chargingStatus: null,
  bodyStatus: null,
  liveHeartRate: null,
  liveHeartRateAt: null,
  syncError: null,
};

export const defaultWearableSyncContextValue: WearableSyncContextValue = {
  isReady: false,
  deviceState: emptyDeviceState,
  liveEvents: [],
  progress: {
    status: 'idle',
    message: 'Select a wearable and run a manual sync.',
  },
  scanResults: [],
  scan: async () => {},
  pairDevice: async () => null,
  selectDevice: async () => {},
  forgetDevice: async () => {},
  syncSelected: async () => null,
  restartDevice: async () => {},
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
  const [isReady, setIsReady] = useState(false);
  const [deviceState, setDeviceState] = useState<DeviceState>(emptyDeviceState);
  const [liveEvents, setLiveEvents] = useState<WearableLiveEvent[]>([]);
  const [progress, setProgress] = useState<SyncProgress>(defaultWearableSyncContextValue.progress);
  const [scanResults, setScanResults] = useState<WearableScanResult[]>([]);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [lastSyncAttemptAtMs, setLastSyncAttemptAtMs] = useState<number | null>(null);
  const appStateRef = useRef(appState);

  const appendLiveEvent = useCallback((event: WearableLiveEvent) => {
    setLiveEvents((current) => [event, ...current].slice(0, MAX_LIVE_EVENTS));
  }, []);

  const resetLiveEvents = useCallback(() => {
    setLiveEvents([]);
  }, []);

  useEffect(() => {
    let cancelled = false;

    service.getDeviceState()
      .then((state) => {
        if (!cancelled) {
          setDeviceState(state);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setIsReady(true);
        }
      });

    return () => {
      cancelled = true;
      void service.dispose();
    };
  }, [service]);

  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppState(nextState);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const liveUpdatesBlocked = progress.status === 'scanning' || isBlockingSyncStatus(progress.status);

    if (!deviceState.id || liveUpdatesBlocked) {
      void service.stopLiveUpdates();
      return;
    }

    void service.startLiveUpdates(
      (nextState) => {
        if (!cancelled) {
          setDeviceState(nextState);
        }
      },
      appendLiveEvent,
    ).catch(() => {});

    return () => {
      cancelled = true;
      void service.stopLiveUpdates();
    };
  }, [appendLiveEvent, deviceState.id, progress.status, service]);

  const runSyncSelected = useCallback(async (options?: { showOverlay?: boolean }) => {
    setLastSyncAttemptAtMs(Date.now());
    const showOverlay = options?.showOverlay ?? true;

    try {
      const result = await service.syncSelected(
        (next) => {
          setProgress(showOverlay ? next : { ...next, showOverlay: false });
        },
        appendLiveEvent,
      );
      setDeviceState(await service.getDeviceState());
      healthRepository.invalidateCaches('all');
      refreshHealthData();
      void healthRepository.warmCaches().catch(() => {});
      return result;
    } catch {
      setDeviceState(await service.getDeviceState());
      return null;
    }
  }, [appendLiveEvent, healthRepository, refreshHealthData, service]);

  useEffect(() => {
    const syncBlocked = progress.status === 'scanning' || isBlockingSyncStatus(progress.status);
    if (!isReady || !deviceState.id || appState !== 'active' || syncBlocked) {
      return;
    }

    const lastSyncedAtMs = deviceState.lastSyncedAt
      ? parseSqliteDateTime(deviceState.lastSyncedAt).getTime()
      : null;
    const lastActivityAtMs = Math.max(lastSyncAttemptAtMs ?? 0, lastSyncedAtMs ?? 0);
    const elapsedMs = lastActivityAtMs > 0 ? Date.now() - lastActivityAtMs : Number.POSITIVE_INFINITY;
    const delayMs =
      lastActivityAtMs > 0
        ? Math.max(FOREGROUND_AUTO_SYNC_INTERVAL_MS - elapsedMs, FOREGROUND_AUTO_SYNC_MIN_DELAY_MS)
        : FOREGROUND_AUTO_SYNC_MIN_DELAY_MS;

    const timer = setTimeout(() => {
      if (appStateRef.current !== 'active') {
        return;
      }

      void runSyncSelected({ showOverlay: false });
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [appState, deviceState.id, deviceState.lastSyncedAt, isReady, lastSyncAttemptAtMs, progress.status, runSyncSelected]);

  const value = useMemo<WearableSyncContextValue>(
    () => ({
      isReady,
      deviceState,
      liveEvents,
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
      pairDevice: async (device) => {
        await service.selectDevice(device);
        resetLiveEvents();
        setScanResults([]);
        setProgress({
          status: 'connecting',
          message: `Pairing ${device.name} and starting the first sync...`,
        });
        setDeviceState(await service.getDeviceState());
        return runSyncSelected();
      },
      selectDevice: async (device) => {
        await service.selectDevice(device);
        resetLiveEvents();
        setLastSyncAttemptAtMs(null);
        setDeviceState(await service.getDeviceState());
        setProgress({
          status: 'idle',
          message: `Selected ${device.name}.`,
        });
      },
      forgetDevice: async () => {
        await service.forgetDevice();
        resetLiveEvents();
        setLastSyncAttemptAtMs(null);
        setDeviceState(emptyDeviceState);
        setScanResults([]);
        setProgress({
          status: 'idle',
          message: 'Removed the selected wearable.',
        });
      },
      syncSelected: async (options) => runSyncSelected(options),
      restartDevice: async () => {
        try {
          await service.restartDevice(
            (next) => {
              setProgress(next);
            },
            appendLiveEvent,
          );
          setDeviceState(await service.getDeviceState());
        } catch (error) {
          setDeviceState(await service.getDeviceState());
          setProgress({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to restart the wearable.',
          });
          throw error;
        }
      },
      setAlarm: async (unixSeconds) => {
        try {
          await service.setAlarm(
            unixSeconds,
            (next) => {
              setProgress(next);
            },
            appendLiveEvent,
          );
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
          await service.disableAlarm(
            (next) => {
              setProgress(next);
            },
            appendLiveEvent,
          );
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
    [
      appendLiveEvent,
      deviceState,
      isReady,
      liveEvents,
      progress,
      resetLiveEvents,
      runSyncSelected,
      scanResults,
      service,
    ],
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
