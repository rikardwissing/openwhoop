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
import { AppState, type AppStateStatus } from 'react-native';

import { openAppDatabaseAsync } from '@/db/appDatabase';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useAppDatabase, useAppDatabaseControls } from '@/providers/AppDatabaseProvider';
import {
  registerBackgroundDeviceSyncTaskAsync,
  runBackgroundDeviceSyncWithServiceAsync,
  runBackgroundDeviceSyncNowAsync,
  type BackgroundDeviceSyncManualRunResult,
} from '@/services/background/backgroundDeviceSyncTask';
import {
  beginBackgroundExecutionAssertionAsync,
  endBackgroundExecutionAssertionAsync,
} from '@/services/background/backgroundExecutionAssertion';
import { getBackgroundSyncState } from '@/services/background/backgroundSyncState';
import { WearableSyncService } from '@/services/ble/WearableSyncService';
import {
  cancelMissingDeviceDataReminderNotificationsAsync,
  syncMissingDeviceDataReminderNotificationsAsync,
} from '@/services/notifications/missingDeviceDataReminders';
import { updateTonightWidget } from '@/services/widgets/tonightWidget';
import {
  isBlockingSyncStatus,
  type BackgroundSyncState,
  type DeviceState,
  type SyncProgress,
  type WearableLiveEvent,
  type WearableScanResult,
} from '@/types/device';

const MAX_LIVE_EVENTS = 200;
const BACKGROUND_SYNC_REFRESH_STATUS_HOLD_MS = 450;
const BACKGROUND_SYNC_REFRESH_DISMISS_HOLD_MS = 300;
const BACKGROUND_SYNC_REFRESH_ERROR_HOLD_MS = 1200;
const BATTERY_EVENT_LIVE_EVENT_KIND = 'battery-event';
const BATTERY_EVENT_BACKGROUND_SYNC_COOLDOWN_MS = 60_000;

const SHOULD_LOG_MOBILE_SYNC_PERF =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  (typeof process === 'undefined' || process.env.NODE_ENV !== 'test');

type PerformanceLogValue = string | number | boolean | null;

interface WearableBackgroundSyncOptions {
  ignoreCooldown?: boolean;
  showOverlay?: boolean;
  triggerLabel?: string;
  useExistingBleService?: boolean;
}

interface BackgroundSyncRefreshIndicator {
  active: boolean;
  message: string;
  showStatus: boolean;
}

const DEFAULT_BACKGROUND_SYNC_REFRESH_INDICATOR: BackgroundSyncRefreshIndicator = {
  active: false,
  message: 'Running background sync...',
  showStatus: false,
};

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
  backgroundSyncRefreshIndicator: BackgroundSyncRefreshIndicator;
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
  runBackgroundSync: (options?: WearableBackgroundSyncOptions) => Promise<BackgroundDeviceSyncManualRunResult>;
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
  backgroundSyncRefreshIndicator: BackgroundSyncRefreshIndicator;
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
  runBackgroundSync: (options?: WearableBackgroundSyncOptions) => Promise<BackgroundDeviceSyncManualRunResult>;
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
  backgroundSyncRefreshIndicator: DEFAULT_BACKGROUND_SYNC_REFRESH_INDICATOR,
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
    message: 'Select a wearable and use background sync to import fresh data.',
  },
  scanResults: [],
  scan: async () => {},
  loadSeededData: async () => {},
  pairDevice: async () => {},
  selectDevice: async () => {},
  forgetDevice: async () => {},
  runBackgroundSync: async () => ({
    appleHealthExport: null,
    detectionNotifications: {
      activityReadyCount: 0,
      sleepReadyCount: 0,
      sleepStartedCount: 0,
    },
    error: null,
    importedReadings: 0,
    message: 'No wearable is selected, so background sync did not run.',
    notificationPermissionGranted: false,
    processedDerivedRefresh: false,
    status: 'no_device',
  }),
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
    () => ({
      backgroundSyncRefreshIndicator: value.backgroundSyncRefreshIndicator,
      progress: value.progress,
    }),
    [value.backgroundSyncRefreshIndicator, value.progress],
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
      runBackgroundSync: value.runBackgroundSync,
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
      value.runBackgroundSync,
      value.scan,
      value.selectDevice,
      value.setAlarm,
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
  const db = useAppDatabase();
  const healthRepository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { loadSeededData: loadBundledAppDatabase } = useAppDatabaseControls();
  const [service] = useState(() => new WearableSyncService(db));
  const [isReady, setIsReady] = useState(false);
  const [deviceState, setDeviceState] = useState<DeviceState>(emptyDeviceState);
  const [backgroundSyncState, setBackgroundSyncState] = useState<BackgroundSyncState>(
    defaultWearableSyncContextValue.backgroundSyncState,
  );
  const [backgroundSyncRefreshIndicator, setBackgroundSyncRefreshIndicator] = useState<BackgroundSyncRefreshIndicator>(
    DEFAULT_BACKGROUND_SYNC_REFRESH_INDICATOR,
  );
  const [liveEvents, setLiveEvents] = useState<WearableLiveEvent[]>([]);
  const [progress, setProgress] = useState<SyncProgress>(defaultWearableSyncContextValue.progress);
  const [scanResults, setScanResults] = useState<WearableScanResult[]>([]);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const backgroundSyncStateRef = useRef(backgroundSyncState);
  const backgroundSyncRefreshRunIdRef = useRef(0);
  const handledBatteryEventIdRef = useRef<string | null>(null);
  const batteryEventBackgroundSyncInFlightRef = useRef(false);
  const lastBatteryEventBackgroundSyncAtRef = useRef(0);
  const previousAppStateRef = useRef<AppStateStatus>(AppState.currentState);
  const progressStatusRef = useRef(progress.status);
  const runBackgroundSyncRef = useRef<WearableSyncContextValue['runBackgroundSync'] | null>(null);
  const [appBecameActiveCount, setAppBecameActiveCount] = useState(0);
  const latestDeviceStateRef = useRef<DeviceState>(emptyDeviceState);

  useEffect(() => {
    backgroundSyncStateRef.current = backgroundSyncState;
  }, [backgroundSyncState]);

  useEffect(() => {
    latestDeviceStateRef.current = deviceState;
  }, [deviceState]);

  progressStatusRef.current = progress.status;

  const appendLiveEvent = useCallback((event: WearableLiveEvent) => {
    setLiveEvents((current) => [event, ...current].slice(0, MAX_LIVE_EVENTS));
  }, []);

  const handleBatteryEventBackgroundSyncTrigger = useCallback((event: WearableLiveEvent) => {
    if (event.kind !== BATTERY_EVENT_LIVE_EVENT_KIND) {
      return;
    }

    if (handledBatteryEventIdRef.current === event.id) {
      return;
    }

    handledBatteryEventIdRef.current = event.id;
    const runBackgroundSync = runBackgroundSyncRef.current;
    const currentStatus = progressStatusRef.current;
    if (
      !runBackgroundSync ||
      batteryEventBackgroundSyncInFlightRef.current ||
      currentStatus === 'scanning' ||
      isBlockingSyncStatus(currentStatus)
    ) {
      return;
    }

    const now = Date.now();
    const cooldownRemainingMs =
      BATTERY_EVENT_BACKGROUND_SYNC_COOLDOWN_MS - (now - lastBatteryEventBackgroundSyncAtRef.current);
    if (cooldownRemainingMs > 0) {
      return;
    }

    batteryEventBackgroundSyncInFlightRef.current = true;
    lastBatteryEventBackgroundSyncAtRef.current = now;

    void (async () => {
      let assertionId: number | null = null;

      try {
        assertionId = await beginBackgroundExecutionAssertionAsync('BatteryEventSync');
        const result = await runBackgroundSync({
          showOverlay: false,
          triggerLabel: 'battery level event',
          useExistingBleService: true,
        });

        if (result.status === 'failed' || result.status === 'skipped') {
          lastBatteryEventBackgroundSyncAtRef.current = 0;
        }
      } catch {
        lastBatteryEventBackgroundSyncAtRef.current = 0;
      } finally {
        await endBackgroundExecutionAssertionAsync(assertionId);
        batteryEventBackgroundSyncInFlightRef.current = false;
      }
    })();
  }, []);

  const appendLiveEventAndHandleSyncTrigger = useCallback((event: WearableLiveEvent) => {
    appendLiveEvent(event);
    handleBatteryEventBackgroundSyncTrigger(event);
  }, [appendLiveEvent, handleBatteryEventBackgroundSyncTrigger]);

  const resetLiveEvents = useCallback(() => {
    setLiveEvents([]);
  }, []);

  const startBackgroundSyncRefreshIndicator = useCallback((message: string) => {
    backgroundSyncRefreshRunIdRef.current += 1;
    const runId = backgroundSyncRefreshRunIdRef.current;

    setBackgroundSyncRefreshIndicator({
      active: true,
      message,
      showStatus: true,
    });

    return runId;
  }, []);

  const finalizeBackgroundSyncRefreshIndicator = useCallback(
    (runId: number, message: string, holdMs: number) => {
      void (async () => {
        setBackgroundSyncRefreshIndicator({
          active: true,
          message,
          showStatus: true,
        });

        await delay(holdMs);
        if (backgroundSyncRefreshRunIdRef.current !== runId) {
          return;
        }

        setBackgroundSyncRefreshIndicator({
          active: false,
          message,
          showStatus: true,
        });

        await delay(BACKGROUND_SYNC_REFRESH_DISMISS_HOLD_MS);
        if (backgroundSyncRefreshRunIdRef.current !== runId) {
          return;
        }

        setBackgroundSyncRefreshIndicator(DEFAULT_BACKGROUND_SYNC_REFRESH_INDICATOR);
      })();
    },
    [],
  );

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
        const runFinishedChanged =
          nextState.lastRunFinishedAt !== previousState.lastRunFinishedAt ||
          nextState.lastSuccessAt !== previousState.lastSuccessAt;
        const importedRowsDuringRun =
          (nextState.lastImportedReadings ?? 0) > 0 &&
          nextState.lastRunFinishedAt !== previousState.lastRunFinishedAt;

        if (
          options?.refreshHealth &&
          runFinishedChanged &&
          (nextState.lastResult === 'success' || importedRowsDuringRun)
        ) {
          refreshHealthData(['heart', 'dashboard', 'sleep', 'wellness', 'trends', 'derived']);
        }
      } catch {}
    },
    [readBackgroundStateFresh, refreshHealthData],
  );

  const restartLiveUpdates = useCallback(async () => {
    await service.startLiveUpdates(
      (nextState) => {
        const previousState = latestDeviceStateRef.current;
        setDeviceState(nextState);
        latestDeviceStateRef.current = nextState;

        if (
          nextState.id &&
          (nextState.batteryPercent !== previousState.batteryPercent ||
            nextState.chargingStatus !== previousState.chargingStatus)
        ) {
          void updateTonightWidget(db);
        }
      },
      appendLiveEventAndHandleSyncTrigger,
    );
  }, [appendLiveEventAndHandleSyncTrigger, db, service]);

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
      const previousState = previousAppStateRef.current;
      previousAppStateRef.current = nextState;
      setAppState(nextState);
      if (previousState !== 'active' && nextState === 'active') {
        setAppBecameActiveCount((count) => count + 1);
      }
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
    if (
      appBecameActiveCount > 0 &&
      isReady &&
      !batteryEventBackgroundSyncInFlightRef.current &&
      progressStatusRef.current !== 'scanning' &&
      !isBlockingSyncStatus(progressStatusRef.current)
    ) {
      void restartLiveUpdates().catch(() => {});
    }
  }, [appBecameActiveCount, appState, deviceState.id, isReady, refreshBackgroundState, restartLiveUpdates]);

  useEffect(() => {
    if (!isReady || !deviceState.id) {
      return;
    }

    void registerBackgroundDeviceSyncTaskAsync({
      requestNotificationPermission: true,
    }).catch(() => {});
  }, [deviceState.id, isReady]);

  useEffect(() => {
    if (!isReady || deviceState.id) {
      return;
    }

    void cancelMissingDeviceDataReminderNotificationsAsync().catch(() => {});
  }, [deviceState.id, isReady]);

  useEffect(() => {
    if (!isReady || !deviceState.id) {
      return;
    }

    void syncMissingDeviceDataReminderNotificationsAsync(db, {
      deviceName: deviceState.name ?? 'wearable',
    }).catch(() => {});
  }, [db, deviceState.id, deviceState.name, isReady]);

  useEffect(() => {
    let cancelled = false;

    if (!deviceState.id) {
      void service.stopLiveUpdates();
      return;
    }

    void service
      .startLiveUpdates(
        (nextState) => {
          if (!cancelled) {
            const previousState = latestDeviceStateRef.current;
            setDeviceState(nextState);
            latestDeviceStateRef.current = nextState;

            if (
              nextState.id &&
              (nextState.batteryPercent !== previousState.batteryPercent ||
                nextState.chargingStatus !== previousState.chargingStatus)
            ) {
              void updateTonightWidget(db);
            }
          }
        },
        appendLiveEventAndHandleSyncTrigger,
      )
      .catch(() => {});

    return () => {
      cancelled = true;
      void service.stopLiveUpdates();
    };
  }, [appendLiveEventAndHandleSyncTrigger, db, deviceState.id, service]);

  const runBackgroundSync = useCallback(
    async (options?: WearableBackgroundSyncOptions) => {
      const ignoreCooldown = options?.ignoreCooldown ?? false;
      const showOverlay = options?.showOverlay ?? true;
      const triggerLabel = options?.triggerLabel ?? 'manual trigger';
      const useExistingBleService = options?.useExistingBleService ?? true;
      const syncStartedAt = Date.now();
      const refreshIndicatorRunId = startBackgroundSyncRefreshIndicator('Running background sync...');
      let stoppedLiveUpdates = false;

      if (!useExistingBleService) {
        setProgress({
          status: 'syncing',
          message: 'Running bounded background sync...',
          showOverlay,
        });
      }

      try {
        let result: BackgroundDeviceSyncManualRunResult;
        if (useExistingBleService) {
          result = await runBackgroundDeviceSyncWithServiceAsync(db, service, {
            ignoreCooldown,
            triggerLabel,
          });
        } else {
          await service.stopLiveUpdates().catch(() => {});
          stoppedLiveUpdates = true;
          result = await runBackgroundDeviceSyncNowAsync({
            ignoreCooldown,
            triggerLabel,
          });
        }

        setDeviceState(await service.getDeviceState());
        await refreshBackgroundState({
          refreshHealth:
            result.status === 'completed' ||
            result.status === 'paused' ||
            result.status === 'failed' ||
            result.importedReadings > 0 ||
            result.processedDerivedRefresh,
        });

        if (
          result.importedReadings > 0 ||
          result.processedDerivedRefresh
        ) {
          refreshHealthData(['dashboard', 'sleep', 'heart', 'wellness', 'trends', 'derived']);
        }

        setProgress({
          status: result.status === 'failed' ? 'error' : 'complete',
          message: result.message,
          importedReadings: result.importedReadings,
          showOverlay,
        });

        finalizeBackgroundSyncRefreshIndicator(
          refreshIndicatorRunId,
          result.status === 'failed'
            ? result.message
            : result.status === 'no_device'
              ? 'Local data refreshed'
              : result.status === 'skipped'
                ? result.message
                : 'Fully synced',
          result.status === 'failed'
            ? BACKGROUND_SYNC_REFRESH_ERROR_HOLD_MS
            : BACKGROUND_SYNC_REFRESH_STATUS_HOLD_MS,
        );

        logMobileSyncPerf('background.syncNow', syncStartedAt, {
          importedReadings: result.importedReadings,
          showOverlay,
          status: result.status,
          trigger: triggerLabel,
        });

        return result;
      } catch (error) {
        setDeviceState(await service.getDeviceState());
        await refreshBackgroundState();
        setProgress({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to run background sync now.',
          showOverlay,
        });
        finalizeBackgroundSyncRefreshIndicator(
          refreshIndicatorRunId,
          error instanceof Error ? error.message : 'Unable to run background sync now.',
          BACKGROUND_SYNC_REFRESH_ERROR_HOLD_MS,
        );
        logMobileSyncPerf('background.syncNow', syncStartedAt, {
          importedReadings: null,
          showOverlay,
          status: 'failed',
          trigger: triggerLabel,
        });
        throw error;
      } finally {
        if (stoppedLiveUpdates) {
          void restartLiveUpdates().catch(() => {});
        }
      }
    },
    [db, refreshBackgroundState, refreshHealthData, restartLiveUpdates, service],
  );

  runBackgroundSyncRef.current = runBackgroundSync;

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
      await cancelMissingDeviceDataReminderNotificationsAsync().catch(() => {});
      resetLiveEvents();
      setScanResults([]);
      setProgress({
        status: 'idle',
        message: `Paired ${device.name}. Background sync will import fresh data automatically.`,
      });
      setDeviceState(await service.getDeviceState());
      await refreshBackgroundState();
    },
    [refreshBackgroundState, resetLiveEvents, service],
  );

  const selectDevice = useCallback(
    async (device: WearableScanResult) => {
      await service.selectDevice(device);
      await cancelMissingDeviceDataReminderNotificationsAsync().catch(() => {});
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
    await cancelMissingDeviceDataReminderNotificationsAsync().catch(() => {});
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
    () => ({
      backgroundSyncRefreshIndicator,
      progress,
    }),
    [backgroundSyncRefreshIndicator, progress],
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
      runBackgroundSync,
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
      runBackgroundSync,
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
