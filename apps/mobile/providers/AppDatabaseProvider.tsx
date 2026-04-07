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
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';

import { clearLocalAppDatabaseAsync, seedBundledAppDatabaseAsync } from '@/db/appDatabase';
import { APP_DATABASE_NAME, initializeDatabase } from '@/db/schema';

const AppDatabaseContext = createContext<SQLiteDatabase | null>(null);
interface AppDatabaseControlsValue {
  loadSeededData: () => Promise<void>;
  clearAllLocalData: () => Promise<void>;
}

const AppDatabaseControlsContext = createContext<AppDatabaseControlsValue | null>(null);

function AppDatabaseBridge({
  children,
  onDatabaseChange,
}: {
  children: ReactNode;
  onDatabaseChange: (db: SQLiteDatabase | null) => void;
}) {
  const db = useSQLiteContext();

  useEffect(() => {
    onDatabaseChange(db);

    return () => {
      onDatabaseChange(null);
    };
  }, [db, onDatabaseChange]);

  return (
    <AppDatabaseContext.Provider value={db}>
      {children}
    </AppDatabaseContext.Provider>
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

    if (db) {
      const waiters = pendingDatabaseReadyWaitersRef.current;
      pendingDatabaseReadyWaitersRef.current = [];
      waiters.forEach((resolve) => resolve());
      return;
    }

    const waiters = pendingDatabaseDetachedWaitersRef.current;
    pendingDatabaseDetachedWaitersRef.current = [];
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
          <AppDatabaseBridge onDatabaseChange={handleDatabaseChange}>{children}</AppDatabaseBridge>
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
