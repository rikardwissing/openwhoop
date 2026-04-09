import type { SQLiteDatabase } from 'expo-sqlite';

import { migrateLegacyHeartRateTable } from '@/db/schema';

const VACUUM_FREE_BYTES_THRESHOLD = 16 * 1024 * 1024;

interface SqliteCountRow {
  count?: number;
  [key: string]: number | null | undefined;
}

export interface DatabaseMaintenanceInspection {
  heartRateHasImuColumn: boolean;
  pageCount: number;
  pageSizeBytes: number;
  freelistCount: number;
  sizeBytes: number;
  freeBytes: number;
  needsMaintenance: boolean;
}

export interface DatabaseMaintenanceResult {
  ran: boolean;
  migratedLegacyHeartRate: boolean;
  vacuumed: boolean;
  sizeBytesBefore: number;
  sizeBytesAfter: number;
  freeBytesBefore: number;
  freeBytesAfter: number;
  reclaimedBytes: number;
}

async function getPragmaCount(db: SQLiteDatabase, pragma: string) {
  const row = await db.getFirstAsync<SqliteCountRow>(`PRAGMA ${pragma}`);

  if (!row) {
    return 0;
  }

  if (typeof row.count === 'number' && Number.isFinite(row.count)) {
    return row.count;
  }

  for (const value of Object.values(row)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return 0;
}

async function heartRateHasImuColumn(db: SQLiteDatabase) {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(heart_rate)');
  return columns.some((column) => column.name === 'imu_data');
}

export async function inspectDatabaseMaintenance(db: SQLiteDatabase): Promise<DatabaseMaintenanceInspection> {
  const [hasImuColumn, pageCount, pageSizeBytes, freelistCount] = await Promise.all([
    heartRateHasImuColumn(db),
    getPragmaCount(db, 'page_count'),
    getPragmaCount(db, 'page_size'),
    getPragmaCount(db, 'freelist_count'),
  ]);
  const sizeBytes = pageCount * pageSizeBytes;
  const freeBytes = freelistCount * pageSizeBytes;

  return {
    heartRateHasImuColumn: hasImuColumn,
    pageCount,
    pageSizeBytes,
    freelistCount,
    sizeBytes,
    freeBytes,
    needsMaintenance: hasImuColumn || freeBytes >= VACUUM_FREE_BYTES_THRESHOLD,
  };
}

async function checkpointWal(db: SQLiteDatabase) {
  try {
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {}
}

export async function runDatabaseMaintenance(db: SQLiteDatabase): Promise<DatabaseMaintenanceResult> {
  const before = await inspectDatabaseMaintenance(db);
  let migratedLegacyHeartRate = false;

  if (before.heartRateHasImuColumn) {
    await migrateLegacyHeartRateTable(db);
    migratedLegacyHeartRate = true;
  }

  const shouldVacuum = migratedLegacyHeartRate || before.freeBytes >= VACUUM_FREE_BYTES_THRESHOLD;

  if (shouldVacuum) {
    await checkpointWal(db);
    await db.execAsync('VACUUM;');
    await checkpointWal(db);
  }

  const after = await inspectDatabaseMaintenance(db);

  return {
    ran: migratedLegacyHeartRate || shouldVacuum,
    migratedLegacyHeartRate,
    vacuumed: shouldVacuum,
    sizeBytesBefore: before.sizeBytes,
    sizeBytesAfter: after.sizeBytes,
    freeBytesBefore: before.freeBytes,
    freeBytesAfter: after.freeBytes,
    reclaimedBytes: Math.max(before.sizeBytes - after.sizeBytes, 0),
  };
}