import { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { AppState, type AppStateStatus } from 'react-native';

import { openAppDatabaseAsync } from '@/db/appDatabase';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { getBackgroundSyncState } from '@/services/background/backgroundSyncState';
import {
  disableBackgroundSync,
  enableBackgroundSyncAfterPairing,
  ensureBackgroundSyncRegistered,
  getBackgroundSyncDiagnostics,
  triggerBackgroundSyncForTesting,
} from '@/services/background/backgroundSyncTask';
import { WearableSyncService } from '@/services/ble/WearableSyncService';
import {
  isBlockingSyncStatus,
  type BackgroundSyncDiagnostics,
  type BackgroundSyncState,
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
const BACKGROUND_TEST_POLL_INTERVAL_MS = 250;
const BACKGROUND_TEST_TIMEOUT_MS = 12_000;

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface WearableSyncContextValue {
  isReady: boolean;
  deviceState: DeviceState;
  backgroundSyncState: BackgroundSyncState;
  backgroundSyncDiagnostics: BackgroundSyncDiagnostics;
  liveEvents: WearableLiveEvent[];
  progress: SyncProgress;
  scanResults: WearableScanResult[];
  scan: () => Promise<void>;
  pairDevice: (device: WearableScanResult) => Promise<SyncResult | null>;
  selectDevice: (device: WearableScanResult) => Promise<void>;
  forgetDevice: () => Promise<void>;
  syncSelected: (options?: { showOverlay?: boolean }) => Promise<SyncResult | null>;
  triggerBackgroundSyncTest: () => Promise<boolean>;
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
  backgroundSyncState: {
    pairedDeviceId: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastSuccessAt: null,
    lastSource: null,
    lastResult: null,
    lastError: null,
    lastImportedReadings: null,
    notificationPermission: 'unknown',
    notificationBaselineAt: null,
  },
  backgroundSyncDiagnostics: {
    apiStatus: 'unknown',
    isTaskDefined: false,
    isTaskRegistered: false,
    minimumIntervalMinutes: 15,
  },
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
  triggerBackgroundSyncTest: async () => false,
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
  const [backgroundSyncState, setBackgroundSyncState] = useState<BackgroundSyncState>(
    defaultWearableSyncContextValue.backgroundSyncState,
  );
  const [backgroundSyncDiagnostics, setBackgroundSyncDiagnostics] = useState<BackgroundSyncDiagnostics>(
    defaultWearableSyncContextValue.backgroundSyncDiagnostics,
  );
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

  const readBackgroundStateFresh = useCallback(async () => {
    const freshDb = await openAppDatabaseAsync();

    try {
      return await getBackgroundSyncState(freshDb);
    } finally {
      await freshDb.closeAsync().catch(() => {});
    }
  }, []);

  const refreshBackgroundState = useCallback(async () => {
    try {
      setBackgroundSyncState(await readBackgroundStateFresh());
    } catch {}
  }, [readBackgroundStateFresh]);

  const refreshBackgroundDiagnostics = useCallback(async () => {
    try {
      setBackgroundSyncDiagnostics(await getBackgroundSyncDiagnostics());
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([service.getDeviceState(), readBackgroundStateFresh(), getBackgroundSyncDiagnostics()])
      .then(([state, nextBackgroundState, nextBackgroundDiagnostics]) => {
        if (!cancelled) {
          setDeviceState(state);
          setBackgroundSyncState(nextBackgroundState);
          setBackgroundSyncDiagnostics(nextBackgroundDiagnostics);
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
  }, [readBackgroundStateFresh, service]);

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
    if (!isReady) {
      return;
    }

    if (!deviceState.id) {
      setBackgroundSyncState(defaultWearableSyncContextValue.backgroundSyncState);
      void refreshBackgroundDiagnostics();
      return;
    }

    void ensureBackgroundSyncRegistered(deviceState.id)
      .then(async () => {
        await refreshBackgroundState();
        await refreshBackgroundDiagnostics();
      })
      .catch(() => {});
  }, [deviceState.id, isReady, refreshBackgroundDiagnostics, refreshBackgroundState]);

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
      await refreshBackgroundState();
      healthRepository.invalidateCaches('all');
      refreshHealthData();
      void healthRepository.warmCaches().catch(() => {});
      return result;
    } catch {
      setDeviceState(await service.getDeviceState());
      await refreshBackgroundState();
      return null;
    }
  }, [appendLiveEvent, healthRepository, refreshBackgroundState, refreshHealthData, service]);

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
      backgroundSyncState,
      backgroundSyncDiagnostics,
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
        const result = await runSyncSelected();
        if (result) {
          await enableBackgroundSyncAfterPairing(device.id);
          await refreshBackgroundState();
          await refreshBackgroundDiagnostics();
        }
        return result;
      },
      selectDevice: async (device) => {
        await service.selectDevice(device);
        resetLiveEvents();
        setLastSyncAttemptAtMs(null);
        setDeviceState(await service.getDeviceState());
        await refreshBackgroundState();
        setProgress({
          status: 'idle',
          message: `Selected ${device.name}.`,
        });
      },
      forgetDevice: async () => {
        await service.forgetDevice();
        await disableBackgroundSync();
        resetLiveEvents();
        setLastSyncAttemptAtMs(null);
        setDeviceState(emptyDeviceState);
        setBackgroundSyncState(defaultWearableSyncContextValue.backgroundSyncState);
        await refreshBackgroundDiagnostics();
        setScanResults([]);
        setProgress({
          status: 'idle',
          message: 'Removed the selected wearable.',
        });
      },
      syncSelected: async (options) => runSyncSelected(options),
      triggerBackgroundSyncTest: async () => {
        const baselineState = await readBackgroundStateFresh().catch(
          () => defaultWearableSyncContextValue.backgroundSyncState,
        );
        const diagnostics = await getBackgroundSyncDiagnostics().catch(
          () => defaultWearableSyncContextValue.backgroundSyncDiagnostics,
        );

        setBackgroundSyncDiagnostics(diagnostics);

        if (!deviceState.id) {
          setProgress({
            status: 'error',
            message: 'Select a wearable before testing background sync.',
          });
          return false;
        }

        if (diagnostics.apiStatus !== 'available') {
          setProgress({
            status: 'error',
            message: 'Background tasks are unavailable on this build or device. Use a physical iPhone development build.',
          });
          return false;
        }

        if (!diagnostics.isTaskRegistered) {
          setProgress({
            status: 'error',
            message: 'The background task is not registered yet. Pair the wearable again or reopen the app and check Registered.',
          });
          return false;
        }

        setProgress({
          status: 'refreshing',
          message: 'Triggering background sync test...',
          showOverlay: false,
        });

        const triggered = await triggerBackgroundSyncForTesting();
        await refreshBackgroundDiagnostics();

        if (!triggered) {
          setProgress({
            status: 'error',
            message: 'Background task testing is only available in a development build on a physical device.',
          });
          return false;
        }

        const deadline = Date.now() + BACKGROUND_TEST_TIMEOUT_MS;
        let sawStartedRun = false;
        while (Date.now() < deadline) {
          await delay(BACKGROUND_TEST_POLL_INTERVAL_MS);
          const nextState = await readBackgroundStateFresh().catch(() => null);
          if (!nextState) {
            continue;
          }

          setBackgroundSyncState(nextState);

          if (!sawStartedRun && nextState.lastRunStartedAt !== baselineState.lastRunStartedAt) {
            sawStartedRun = true;
            setProgress({
              status: 'refreshing',
              message: 'Background worker started. Waiting for it to record a result...',
              showOverlay: false,
            });
          }

          if (
            nextState.lastRunFinishedAt !== baselineState.lastRunFinishedAt ||
            nextState.lastResult !== baselineState.lastResult
          ) {
            setProgress({
              status: 'complete',
              message: 'Background sync test ran. Check Last finished and Last result below.',
            });
            return true;
          }
        }

        setProgress({
          status: 'error',
          message: sawStartedRun
            ? 'The background worker started, but it has not recorded a finish yet. Check Last started below and the Xcode device logs.'
            : 'The test trigger was sent, but no background run was recorded. Check API, Registered, and Xcode logs if it still stays idle.',
        });
        return false;
      },
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
      backgroundSyncDiagnostics,
      backgroundSyncState,
      deviceState,
      isReady,
      liveEvents,
      progress,
      refreshBackgroundDiagnostics,
      refreshBackgroundState,
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
