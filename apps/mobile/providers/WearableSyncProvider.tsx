import {
  type Context,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { AppState, type AppStateStatus } from 'react-native';

import { openAppDatabaseAsync } from '@/db/appDatabase';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useAppDatabaseControls } from '@/providers/AppDatabaseProvider';
import { registerBackgroundDeviceSyncTaskAsync } from '@/services/background/backgroundDeviceSyncTask';
import { getBackgroundSyncState } from '@/services/background/backgroundSyncState';
import { WearableSyncService } from '@/services/ble/WearableSyncService';
import {
  isBlockingSyncStatus,
  type BackgroundSyncState,
  type DeviceState,
  type SyncProgress,
  type SyncResult,
  type WearableLiveEvent,
  type WearableScanResult,
} from '@/types/device';

const MAX_LIVE_EVENTS = 200;

const SHOULD_LOG_MOBILE_SYNC_PERF =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  (typeof process === 'undefined' || process.env.NODE_ENV !== 'test');

type PerformanceLogValue = string | number | boolean | null;

function logMobileSyncPerf(label: string, startedAt: number, details?: Record<string, PerformanceLogValue>) {
  if (!SHOULD_LOG_MOBILE_SYNC_PERF) {
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  const suffix = details
    ? Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
    : '';
  console.info(`[mobile-perf] ${label} ${elapsedMs}ms${suffix ? ` ${suffix}` : ''}`);
}

export interface WearableSyncContextValue {
  isReady: boolean;
  deviceState: DeviceState;
  backgroundSyncState: BackgroundSyncState;
  liveEvents: WearableLiveEvent[];
  progress: SyncProgress;
  scanResults: WearableScanResult[];
  scan: () => Promise<void>;
  loadSeededData: () => Promise<void>;
  pairDevice: (device: WearableScanResult) => Promise<void>;
  selectDevice: (device: WearableScanResult) => Promise<void>;
  forgetDevice: () => Promise<void>;
  syncSelected: (options?: { showOverlay?: boolean }) => Promise<SyncResult | null>;
  restartDevice: () => Promise<void>;
  setAlarm: (unixSeconds: number) => Promise<void>;
  disableAlarm: () => Promise<void>;
}

interface WearableStateContextValue {
  isReady: boolean;
  deviceState: DeviceState;
  backgroundSyncState: BackgroundSyncState;
}

interface WearableProgressContextValue {
  progress: SyncProgress;
}

interface WearableLiveEventsContextValue {
  liveEvents: WearableLiveEvent[];
}

interface WearableScanContextValue {
  scanResults: WearableScanResult[];
}

interface WearableActionsContextValue {
  scan: () => Promise<void>;
  loadSeededData: () => Promise<void>;
  pairDevice: (device: WearableScanResult) => Promise<void>;
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
    lastSyncImportSummary: null,
  },
  liveEvents: [],
  progress: {
    status: 'idle',
    message: 'Select a wearable and run a manual sync.',
  },
  scanResults: [],
  scan: async () => {},
  loadSeededData: async () => {},
  pairDevice: async () => {},
  selectDevice: async () => {},
  forgetDevice: async () => {},
  syncSelected: async () => null,
  restartDevice: async () => {},
  setAlarm: async () => {},
  disableAlarm: async () => {},
};

const WearableStateContext = createContext<WearableStateContextValue | null>(null);
const WearableProgressContext = createContext<WearableProgressContextValue | null>(null);
const WearableLiveEventsContext = createContext<WearableLiveEventsContextValue | null>(null);
const WearableScanContext = createContext<WearableScanContextValue | null>(null);
const WearableActionsContext = createContext<WearableActionsContextValue | null>(null);

export function WearableSyncContextProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WearableSyncContextValue;
}) {
  const stateValue = useMemo<WearableStateContextValue>(
    () => ({
      isReady: value.isReady,
      deviceState: value.deviceState,
      backgroundSyncState: value.backgroundSyncState,
    }),
    [value.backgroundSyncState, value.deviceState, value.isReady],
  );
  const progressValue = useMemo<WearableProgressContextValue>(
    () => ({ progress: value.progress }),
    [value.progress],
  );
  const liveEventsValue = useMemo<WearableLiveEventsContextValue>(
    () => ({ liveEvents: value.liveEvents }),
    [value.liveEvents],
  );
  const scanValue = useMemo<WearableScanContextValue>(
    () => ({ scanResults: value.scanResults }),
    [value.scanResults],
  );
  const actionsValue = useMemo<WearableActionsContextValue>(
    () => ({
      scan: value.scan,
      loadSeededData: value.loadSeededData,
      pairDevice: value.pairDevice,
      selectDevice: value.selectDevice,
      forgetDevice: value.forgetDevice,
      syncSelected: value.syncSelected,
      restartDevice: value.restartDevice,
      setAlarm: value.setAlarm,
      disableAlarm: value.disableAlarm,
    }),
    [
      value.disableAlarm,
      value.forgetDevice,
      value.loadSeededData,
      value.pairDevice,
      value.restartDevice,
      value.scan,
      value.selectDevice,
      value.setAlarm,
      value.syncSelected,
    ],
  );

  return (
    <WearableStateContext.Provider value={stateValue}>
      <WearableProgressContext.Provider value={progressValue}>
        <WearableLiveEventsContext.Provider value={liveEventsValue}>
          <WearableScanContext.Provider value={scanValue}>
            <WearableActionsContext.Provider value={actionsValue}>
              {children}
            </WearableActionsContext.Provider>
          </WearableScanContext.Provider>
        </WearableLiveEventsContext.Provider>
      </WearableProgressContext.Provider>
    </WearableStateContext.Provider>
  );
}

export function WearableSyncProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const healthRepository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { loadSeededData: loadBundledAppDatabase } = useAppDatabaseControls();
  const [service] = useState(() => new WearableSyncService(db));
  const [isReady, setIsReady] = useState(false);
  const [deviceState, setDeviceState] = useState<DeviceState>(emptyDeviceState);
  const [backgroundSyncState, setBackgroundSyncState] = useState<BackgroundSyncState>(
    defaultWearableSyncContextValue.backgroundSyncState,
  );
  const [liveEvents, setLiveEvents] = useState<WearableLiveEvent[]>([]);
  const [progress, setProgress] = useState<SyncProgress>(defaultWearableSyncContextValue.progress);
  const [scanResults, setScanResults] = useState<WearableScanResult[]>([]);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const backgroundSyncStateRef = useRef(backgroundSyncState);

  useEffect(() => {
    backgroundSyncStateRef.current = backgroundSyncState;
  }, [backgroundSyncState]);

  const appendLiveEvent = useCallback((event: WearableLiveEvent) => {
    setLiveEvents((current) => [event, ...current].slice(0, MAX_LIVE_EVENTS));
  }, []);

  const resetLiveEvents = useCallback(() => {
    setLiveEvents([]);
  }, []);

  const triggerDerivedRefresh = useCallback(() => {
    refreshHealthData(['dashboard', 'heart', 'trends', 'derived']);

    const derivedRefreshStartedAt = Date.now();
    void healthRepository
      .processPendingDerivedRefresh()
      .then((processed) => {
        logMobileSyncPerf('foreground.processPendingDerivedRefresh', derivedRefreshStartedAt, {
          processed,
        });
        refreshHealthData(processed ? ['dashboard', 'sleep', 'wellness', 'trends', 'derived'] : 'derived');
      })
      .catch(() => {
        refreshHealthData('derived');
      });
  }, [healthRepository, refreshHealthData]);

  const readBackgroundStateFresh = useCallback(async () => {
    const freshDb = await openAppDatabaseAsync();

    try {
      return await getBackgroundSyncState(freshDb);
    } finally {
      await freshDb.closeAsync().catch(() => {});
    }
  }, []);

  const refreshBackgroundState = useCallback(
    async (options?: { refreshHealth?: boolean }) => {
      try {
        const nextState = await readBackgroundStateFresh();
        const previousState = backgroundSyncStateRef.current;
        setBackgroundSyncState(nextState);

        if (
          options?.refreshHealth &&
          nextState.lastResult === 'success' &&
          (nextState.lastSuccessAt !== previousState.lastSuccessAt ||
            nextState.lastRunFinishedAt !== previousState.lastRunFinishedAt)
        ) {
          refreshHealthData(['heart', 'dashboard', 'sleep', 'wellness', 'trends', 'derived']);
        }
      } catch {}
    },
    [readBackgroundStateFresh, refreshHealthData],
  );

  useEffect(() => {
    let cancelled = false;

    Promise.all([service.getDeviceState(), readBackgroundStateFresh()])
      .then(([state, nextBackgroundState]) => {
        if (!cancelled) {
          setDeviceState(state);
          setBackgroundSyncState(nextBackgroundState);
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
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppState(nextState);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (appState !== 'active' || !deviceState.id) {
      return;
    }

    void refreshBackgroundState({ refreshHealth: true });
  }, [appState, deviceState.id, refreshBackgroundState]);

  useEffect(() => {
    if (!isReady || !deviceState.id) {
      return;
    }

    void registerBackgroundDeviceSyncTaskAsync({
      requestNotificationPermission: true,
    }).catch(() => {});
  }, [deviceState.id, isReady]);

  useEffect(() => {
    let cancelled = false;
    const liveUpdatesBlocked = progress.status === 'scanning' || isBlockingSyncStatus(progress.status);

    if (!deviceState.id || liveUpdatesBlocked) {
      void service.stopLiveUpdates();
      return;
    }

    void service
      .startLiveUpdates(
        (nextState) => {
          if (!cancelled) {
            setDeviceState(nextState);
          }
        },
        appendLiveEvent,
      )
      .catch(() => {});

    return () => {
      cancelled = true;
      void service.stopLiveUpdates();
    };
  }, [appendLiveEvent, deviceState.id, progress.status, service]);

  const runSyncSelected = useCallback(
    async (options?: { showOverlay?: boolean }) => {
      const showOverlay = options?.showOverlay ?? true;
      const syncStartedAt = Date.now();

      try {
        const result = await service.syncSelected(
          (next) => {
            setProgress(showOverlay ? next : { ...next, showOverlay: false });
          },
          appendLiveEvent,
        );

        setDeviceState(await service.getDeviceState());
        await refreshBackgroundState();
        logMobileSyncPerf('foreground.syncSelected', syncStartedAt, {
          importedReadings: result.importedReadings,
          showOverlay,
        });

        triggerDerivedRefresh();
        return result;
      } catch {
        setDeviceState(await service.getDeviceState());
        await refreshBackgroundState();
        logMobileSyncPerf('foreground.syncSelected', syncStartedAt, {
          importedReadings: null,
          showOverlay,
        });
        return null;
      }
    },
    [appendLiveEvent, refreshBackgroundState, service, triggerDerivedRefresh],
  );

  const scan = useCallback(async () => {
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
  }, [service]);

  const loadSeededData = useCallback(async () => {
    setProgress({
      status: 'refreshing',
      message: 'Loading bundled seeded data...',
      showOverlay: false,
    });

    try {
      await loadBundledAppDatabase();
    } catch (error) {
      setProgress({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to load bundled seeded data.',
      });
      throw error;
    }
  }, [loadBundledAppDatabase]);

  const pairDevice = useCallback(
    async (device: WearableScanResult) => {
      await service.selectDevice(device);
      resetLiveEvents();
      setScanResults([]);
      setProgress({
        status: 'idle',
        message: `Paired ${device.name}. Run a manual sync when you're ready to import data.`,
      });
      setDeviceState(await service.getDeviceState());
      await refreshBackgroundState();
    },
    [refreshBackgroundState, resetLiveEvents, service],
  );

  const selectDevice = useCallback(
    async (device: WearableScanResult) => {
      await service.selectDevice(device);
      resetLiveEvents();
      setDeviceState(await service.getDeviceState());
      await refreshBackgroundState();
      setProgress({
        status: 'idle',
        message: `Selected ${device.name}.`,
      });
    },
    [refreshBackgroundState, resetLiveEvents, service],
  );

  const forgetDevice = useCallback(async () => {
    await service.forgetDevice();
    resetLiveEvents();
    setDeviceState(emptyDeviceState);
    await refreshBackgroundState();
    setScanResults([]);
    setProgress({
      status: 'idle',
      message: 'Removed the selected wearable.',
    });
  }, [refreshBackgroundState, resetLiveEvents, service]);

  const restartDevice = useCallback(async () => {
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
  }, [appendLiveEvent, service]);

  const setAlarm = useCallback(
    async (unixSeconds: number) => {
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
    [appendLiveEvent, service],
  );

  const disableAlarmAction = useCallback(async () => {
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
  }, [appendLiveEvent, service]);

  const stateValue = useMemo<WearableStateContextValue>(
    () => ({
      isReady,
      deviceState,
      backgroundSyncState,
    }),
    [backgroundSyncState, deviceState, isReady],
  );
  const progressValue = useMemo<WearableProgressContextValue>(
    () => ({ progress }),
    [progress],
  );
  const liveEventsValue = useMemo<WearableLiveEventsContextValue>(
    () => ({ liveEvents }),
    [liveEvents],
  );
  const scanValue = useMemo<WearableScanContextValue>(
    () => ({ scanResults }),
    [scanResults],
  );
  const actionsValue = useMemo<WearableActionsContextValue>(
    () => ({
      scan,
      loadSeededData,
      pairDevice,
      selectDevice,
      forgetDevice,
      syncSelected: runSyncSelected,
      restartDevice,
      setAlarm,
      disableAlarm: disableAlarmAction,
    }),
    [
      disableAlarmAction,
      forgetDevice,
      loadSeededData,
      pairDevice,
      restartDevice,
      runSyncSelected,
      scan,
      selectDevice,
      setAlarm,
    ],
  );

  return (
    <WearableStateContext.Provider value={stateValue}>
      <WearableProgressContext.Provider value={progressValue}>
        <WearableLiveEventsContext.Provider value={liveEventsValue}>
          <WearableScanContext.Provider value={scanValue}>
            <WearableActionsContext.Provider value={actionsValue}>
              {children}
            </WearableActionsContext.Provider>
          </WearableScanContext.Provider>
        </WearableLiveEventsContext.Provider>
      </WearableProgressContext.Provider>
    </WearableStateContext.Provider>
  );
}

function useRequiredContext<T>(context: Context<T | null>, label: string) {
  const value = useContext(context);

  if (!value) {
    throw new Error(label);
  }

  return value;
}

export function useWearableSyncState() {
  return useRequiredContext(WearableStateContext, 'Wearable sync state is not available.');
}

export function useWearableSyncProgress() {
  return useRequiredContext(WearableProgressContext, 'Wearable sync progress is not available.');
}

export function useWearableLiveEvents() {
  return useRequiredContext(WearableLiveEventsContext, 'Wearable live events are not available.');
}

export function useWearableScanResults() {
  return useRequiredContext(WearableScanContext, 'Wearable scan state is not available.');
}

export function useWearableSyncActions() {
  return useRequiredContext(WearableActionsContext, 'Wearable sync actions are not available.');
}

export function useWearableSync() {
  const state = useWearableSyncState();
  const { progress } = useWearableSyncProgress();
  const { liveEvents } = useWearableLiveEvents();
  const { scanResults } = useWearableScanResults();
  const actions = useWearableSyncActions();

  return {
    ...state,
    progress,
    liveEvents,
    scanResults,
    ...actions,
  };
}
