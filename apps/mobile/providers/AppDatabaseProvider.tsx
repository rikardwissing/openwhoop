import { createContext, Suspense, useContext, type ReactNode } from 'react';
import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';

import { APP_DATABASE_NAME, initializeDatabase } from '@/db/schema';

const seedAsset = require('../assets/databases/btwearable-seed.db');
const AppDatabaseContext = createContext<SQLiteDatabase | null>(null);

function AppDatabaseBridge({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();

  return (
    <AppDatabaseContext.Provider value={db}>
      {children}
    </AppDatabaseContext.Provider>
  );
}

export function AppDatabaseProvider({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <SQLiteProvider
        assetSource={__DEV__ ? { assetId: seedAsset } : undefined}
        databaseName={APP_DATABASE_NAME}
        onInit={initializeDatabase}
        useSuspense>
        <AppDatabaseBridge>{children}</AppDatabaseBridge>
      </SQLiteProvider>
    </Suspense>
  );
}

export function useOptionalAppDatabase() {
  return useContext(AppDatabaseContext);
}
