import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { APP_DATABASE_NAME, initializeDatabase } from '@/db/schema';

export async function openAppDatabaseAsync(): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(APP_DATABASE_NAME, { useNewConnection: true });
  await initializeDatabase(db);
  return db;
}
