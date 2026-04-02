import { Suspense, type ReactNode } from 'react';
import { SQLiteProvider } from 'expo-sqlite';

import { APP_DATABASE_NAME, initializeDatabase } from '@/db/schema';

const seedAsset = require('../assets/databases/btwearable-seed.db');

export function AppDatabaseProvider({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <SQLiteProvider
        assetSource={__DEV__ ? { assetId: seedAsset } : undefined}
        databaseName={APP_DATABASE_NAME}
        onInit={initializeDatabase}
        useSuspense>
        {children}
      </SQLiteProvider>
    </Suspense>
  );
}
