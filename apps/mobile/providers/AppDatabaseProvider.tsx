import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';

import { colors, typography } from '@/constants/theme';
import { clearLocalAppDatabaseAsync, seedBundledAppDatabaseAsync } from '@/db/appDatabase';
import {
  inspectRequiredStartupMigration,
  runRequiredStartupMigration,
  type StartupMigrationInspection,
  type StartupMigrationProgress,
} from '@/db/maintenance';
import { APP_DATABASE_NAME, initializeDatabase } from '@/db/schema';

const AppDatabaseContext = createContext<SQLiteDatabase | null>(null);
interface AppDatabaseControlsValue {
  loadSeededData: () => Promise<void>;
  clearAllLocalData: () => Promise<void>;
}

const AppDatabaseControlsContext = createContext<AppDatabaseControlsValue | null>(null);

function AppDatabaseStatusScreen({
  actionLabel,
  message,
  onAction,
  progress,
  title,
}: {
  actionLabel?: string;
  message: string;
  onAction?: () => void;
  progress?: {
    label: string;
    value: number;
  };
  title: string;
}) {
  return (
    <View style={styles.statusScreen}>
      <View style={styles.statusCard}>
        <Text accessibilityRole="header" style={styles.statusTitle}>
          {title}
        </Text>
        <Text style={styles.statusMessage}>{message}</Text>
        {progress ? (
          <View style={styles.progressSection}>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.max(0, Math.min(progress.value, 1)) * 100}%`,
                  },
                ]}
              />
            </View>
            <Text style={styles.progressLabel}>{progress.label}</Text>
          </View>
        ) : null}
        {actionLabel && onAction ? (
          <Pressable accessibilityRole="button" onPress={onAction} style={styles.statusActionButton}>
            <Text style={styles.statusActionLabel}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function buildMigrationProgressState(
  inspection: StartupMigrationInspection,
  progress?: Pick<StartupMigrationProgress, 'stage' | 'completedUnits' | 'backfilledSensorDataRows' | 'totalSensorDataRows'>,
) {
  const totalUnits = Math.max(
    (inspection.heartRateNeedsRewrite ? 1 : 0) + inspection.pendingSensorDataBackfillRows,
    1,
  );
  const totalSensorDataRows = progress?.totalSensorDataRows ?? inspection.pendingSensorDataBackfillRows;
  const completedUnits = progress?.completedUnits ?? 0;
  const backfilledSensorDataRows = progress?.backfilledSensorDataRows ?? 0;
  const currentStage =
    progress?.stage ??
    (inspection.pendingSensorDataBackfillRows > 0
      ? 'sensor_data_backfill'
      : inspection.heartRateNeedsRewrite
        ? 'heart_rate_rewrite'
        : 'complete');

  if (currentStage === 'heart_rate_rewrite') {
    return {
      message: 'Rewriting saved heart data to the new storage format before the app starts.',
      progress: {
        label: `Step ${Math.min(completedUnits + 1, totalUnits)} of ${totalUnits}`,
        value: totalUnits > 0 ? completedUnits / totalUnits : 0,
      },
    };
  }

  if (totalSensorDataRows > 0) {
    return {
      message: `Updating ${totalSensorDataRows} saved heart samples to the new storage format before the app starts.`,
      progress: {
        label: `${backfilledSensorDataRows} / ${totalSensorDataRows} samples updated`,
        value: totalUnits > 0 ? completedUnits / totalUnits : 0,
      },
    };
  }

  return {
    message: 'Updating the local database before the app starts.',
    progress: {
      label: `${completedUnits} / ${totalUnits} steps completed`,
      value: totalUnits > 0 ? completedUnits / totalUnits : 0,
    },
  };
}

function AppDatabaseMigrationGate({
  children,
  db,
  onReady,
}: {
  children: ReactNode;
  db: SQLiteDatabase;
  onReady: (db: SQLiteDatabase) => void;
}) {
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<
    | { status: 'checking' }
    | {
        status: 'migrating';
        message: string;
        progress: {
          label: string;
          value: number;
        };
      }
    | { status: 'ready' }
    | { status: 'error'; message: string }
  >({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setState({ status: 'checking' });

      const inspection = await inspectRequiredStartupMigration(db);
      if (cancelled) {
        return;
      }

      if (!inspection.needsMigration) {
        setState({ status: 'ready' });
        onReady(db);
        return;
      }

      setState({
        status: 'migrating',
        ...buildMigrationProgressState(inspection),
      });

      await runRequiredStartupMigration(db, {
        onProgress: (progress) => {
          if (cancelled) {
            return;
          }

          setState({
            status: 'migrating',
            ...buildMigrationProgressState(inspection, progress),
          });
        },
      });
      if (cancelled) {
        return;
      }

      setState({ status: 'ready' });
      onReady(db);
    };

    run().catch((error) => {
      if (cancelled) {
        return;
      }

      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Startup migration failed.',
      });
    });

    return () => {
      cancelled = true;
    };
  }, [db, onReady, retryToken]);

  if (state.status === 'ready') {
    return <>{children}</>;
  }

  if (state.status === 'checking') {
    return (
      <AppDatabaseStatusScreen
        message="Checking your saved data before the app starts."
        title="Preparing local data"
      />
    );
  }

  if (state.status === 'migrating') {
    return (
      <AppDatabaseStatusScreen
        message={state.message}
        progress={state.progress}
        title="Migrating local data"
      />
    );
  }

  if (state.status === 'error') {
    return (
      <AppDatabaseStatusScreen
        actionLabel="Retry migration"
        message={state.message}
        onAction={() => setRetryToken((value) => value + 1)}
        title="Migration failed"
      />
    );
  }

  return null;
}

function AppDatabaseBridge({
  children,
  onDatabaseChange,
  onDatabaseReady,
}: {
  children: ReactNode;
  onDatabaseChange: (db: SQLiteDatabase | null) => void;
  onDatabaseReady: (db: SQLiteDatabase) => void;
}) {
  const db = useSQLiteContext();

  useEffect(() => {
    onDatabaseChange(db);

    return () => {
      onDatabaseChange(null);
    };
  }, [db, onDatabaseChange]);

  return (
    <AppDatabaseMigrationGate db={db} onReady={onDatabaseReady}>
      <AppDatabaseContext.Provider value={db}>
        {children}
      </AppDatabaseContext.Provider>
    </AppDatabaseMigrationGate>
  );
}

export function AppDatabaseProvider({ children }: { children: ReactNode }) {
  const currentDatabaseRef = useRef<SQLiteDatabase | null>(null);
  const pendingDatabaseReadyWaitersRef = useRef<Array<() => void>>([]);
  const pendingDatabaseDetachedWaitersRef = useRef<Array<() => void>>([]);
  const [providerRevision, setProviderRevision] = useState(0);
  const [isReplacingDatabase, setIsReplacingDatabase] = useState(false);

  const handleDatabaseChange = useCallback((db: SQLiteDatabase | null) => {
    currentDatabaseRef.current = db;

    if (!db) {
      const waiters = pendingDatabaseDetachedWaitersRef.current;
      pendingDatabaseDetachedWaitersRef.current = [];
      waiters.forEach((resolve) => resolve());
    }
  }, []);

  const handleDatabaseReady = useCallback((db: SQLiteDatabase) => {
    if (currentDatabaseRef.current !== db) {
      return;
    }

    const waiters = pendingDatabaseReadyWaitersRef.current;
    pendingDatabaseReadyWaitersRef.current = [];
    waiters.forEach((resolve) => resolve());
  }, []);

  const waitForNextDatabaseReady = useCallback(
    () =>
      new Promise<void>((resolve) => {
        pendingDatabaseReadyWaitersRef.current.push(resolve);
      }),
    [],
  );

  const waitForCurrentDatabaseDetached = useCallback(
    () =>
      new Promise<void>((resolve) => {
        if (!currentDatabaseRef.current) {
          resolve();
          return;
        }

        pendingDatabaseDetachedWaitersRef.current.push(resolve);
      }),
    [],
  );

  const replaceDatabase = useCallback(
    async (replace: (currentDb?: SQLiteDatabase) => Promise<void>) => {
      const currentDatabase = currentDatabaseRef.current ?? undefined;

      setIsReplacingDatabase(true);
      await waitForCurrentDatabaseDetached();

      const waitForDatabaseReady = waitForNextDatabaseReady();

      try {
        await replace(currentDatabase);
      } finally {
        setProviderRevision((value) => value + 1);
        setIsReplacingDatabase(false);
      }

      await waitForDatabaseReady;
    },
    [waitForCurrentDatabaseDetached, waitForNextDatabaseReady],
  );

  const loadSeededData = useCallback(async () => {
    await replaceDatabase((currentDb) => seedBundledAppDatabaseAsync(currentDb));
  }, [replaceDatabase]);

  const clearAllLocalData = useCallback(async () => {
    await replaceDatabase((currentDb) => clearLocalAppDatabaseAsync(currentDb));
  }, [replaceDatabase]);

  const controlsValue = useMemo<AppDatabaseControlsValue>(
    () => ({
      loadSeededData,
      clearAllLocalData,
    }),
    [clearAllLocalData, loadSeededData],
  );

  return (
    <AppDatabaseControlsContext.Provider value={controlsValue}>
      {isReplacingDatabase ? null : (
        <SQLiteProvider
          key={providerRevision}
          databaseName={APP_DATABASE_NAME}
          options={{ useNewConnection: true }}
          onInit={initializeDatabase}>
          <AppDatabaseBridge onDatabaseChange={handleDatabaseChange} onDatabaseReady={handleDatabaseReady}>
            {children}
          </AppDatabaseBridge>
        </SQLiteProvider>
      )}
    </AppDatabaseControlsContext.Provider>
  );
}

export function useOptionalAppDatabase() {
  return useContext(AppDatabaseContext);
}

export function useOptionalAppDatabaseControls() {
  return useContext(AppDatabaseControlsContext);
}

export function useAppDatabaseControls() {
  const value = useContext(AppDatabaseControlsContext);

  if (!value) {
    throw new Error('App database controls are not available.');
  }

  return value;
}

const styles = StyleSheet.create({
  statusScreen: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  statusCard: {
    alignItems: 'center',
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    maxWidth: 420,
    paddingHorizontal: 24,
    paddingVertical: 28,
    width: '100%',
  },
  statusTitle: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 24,
    textAlign: 'center',
  },
  statusMessage: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  progressSection: {
    gap: 8,
    width: '100%',
  },
  progressTrack: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    height: 10,
    overflow: 'hidden',
    width: '100%',
  },
  progressFill: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    height: '100%',
  },
  progressLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
    textAlign: 'center',
  },
  statusActionButton: {
    backgroundColor: colors.primary,
    borderRadius: 999,
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  statusActionLabel: {
    color: colors.background,
    fontFamily: typography.bodyBold,
    fontSize: 15,
  },
});
