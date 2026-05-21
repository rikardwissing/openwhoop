import {
  deleteDatabaseAsync,
  importDatabaseFromAssetAsync,
  openDatabaseAsync,
  type SQLiteDatabase,
} from 'expo-sqlite';

import { APP_DATABASE_NAME, initializeDatabase } from '@/db/schema';
import { createResilientDatabase } from '@/db/resilientDatabase';

const seededDatabaseAsset = require('../assets/databases/btwearable.db');

export async function openAppDatabaseAsync(): Promise<SQLiteDatabase> {
  const db = createResilientDatabase(await openDatabaseAsync(APP_DATABASE_NAME, { useNewConnection: true }));
  await initializeDatabase(db);
  return db;
}

export async function clearLocalAppDatabaseAsync(currentDb?: SQLiteDatabase): Promise<void> {
  await currentDb?.closeAsync().catch(() => {});
  await deleteDatabaseAsync(APP_DATABASE_NAME).catch(() => {});
}

export async function seedBundledAppDatabaseAsync(currentDb?: SQLiteDatabase): Promise<void> {
  await clearLocalAppDatabaseAsync(currentDb);
  await importDatabaseFromAssetAsync(APP_DATABASE_NAME, {
    assetId: seededDatabaseAsset,
    forceOverwrite: true,
  });
}
