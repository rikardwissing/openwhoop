import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { SQLiteDatabase } from 'expo-sqlite';

import { APP_DATABASE_NAME } from '@/db/schema';

const EXPORT_DIRECTORY_NAME = 'exports';

export interface DatabaseExportResult {
  fileName: string;
  fileUri: string;
  sizeBytes: number;
}

export async function exportAndShareDatabaseSnapshot(db: SQLiteDatabase): Promise<DatabaseExportResult> {
  const sharingAvailable = await Sharing.isAvailableAsync();

  if (!sharingAvailable) {
    throw new Error('File sharing is not available on this device.');
  }

  const serializedDatabase = await db.serializeAsync();
  const exportFile = new File(Paths.cache, EXPORT_DIRECTORY_NAME, APP_DATABASE_NAME);

  exportFile.create({
    intermediates: true,
    overwrite: true,
  });
  exportFile.write(serializedDatabase);

  await Sharing.shareAsync(exportFile.uri, {
    dialogTitle: 'Export BtWearable Database',
  });

  return {
    fileName: exportFile.name,
    fileUri: exportFile.uri,
    sizeBytes: serializedDatabase.byteLength,
  };
}
