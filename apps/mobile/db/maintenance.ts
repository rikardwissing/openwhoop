import type { SQLiteDatabase } from 'expo-sqlite';

import { rewriteHeartRateTable } from '@/db/schema';

const VACUUM_FREE_BYTES_THRESHOLD = 16 * 1024 * 1024;

interface SqliteCountRow {
  count?: number;
  [key: string]: number | null | undefined;
}

export interface DatabaseMaintenanceInspection {
  heartRateNeedsRewrite: boolean;
  pageCount: number;
  pageSizeBytes: number;
  freelistCount: number;
  sizeBytes: number;
  freeBytes: number;
  needsMaintenance: boolean;
}

export interface DatabaseMaintenanceResult {
  ran: boolean;
  rewroteHeartRateSchema: boolean;
  vacuumed: boolean;
  sizeBytesBefore: number;
  sizeBytesAfter: number;
  freeBytesBefore: number;
  freeBytesAfter: number;
  reclaimedBytes: number;
}

export interface StartupMigrationInspection {
  heartRateNeedsRewrite: boolean;
  pendingSensorDataBackfillRows: number;
  needsMigration: boolean;
}

export interface StartupMigrationResult {
  ran: boolean;
  rewroteHeartRateSchema: boolean;
  backfilledSensorDataRows: number;
}

export interface StartupMigrationProgress {
  stage: 'heart_rate_rewrite' | 'sensor_data_backfill' | 'complete';
  completedUnits: number;
  totalUnits: number;
  backfilledSensorDataRows: number;
  totalSensorDataRows: number;
}

interface StartupMigrationRunOptions {
  onProgress?: (progress: StartupMigrationProgress) => void;
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

async function heartRateNeedsRewrite(db: SQLiteDatabase) {
  const [columns, indexes] = await Promise.all([
    db.getAllAsync<{ name: string }>('PRAGMA table_info(heart_rate)'),
    db.getAllAsync<{ name: string }>('PRAGMA index_list(heart_rate)'),
  ]);
  const columnNames = new Set(columns.map((column) => column.name));

  if (
    columnNames.has('imu_data') ||
    columnNames.has('activity') ||
    columnNames.has('sensor_data') ||
    columnNames.has('synced')
  ) {
    return true;
  }

  return indexes.some((index) => index.name === 'idx_heart_rate_time');
}

async function heartRateColumnNames(db: SQLiteDatabase) {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(heart_rate)');
  return new Set(columns.map((column) => column.name));
}

async function countPendingSensorDataBackfillRows(db: SQLiteDatabase) {
  const heartRateColumns = await heartRateColumnNames(db);

  if (!heartRateColumns.has('sensor_data')) {
    return 0;
  }

  const row = await db.getFirstAsync<SqliteCountRow>(
    `
      SELECT COUNT(*) AS count
      FROM heart_rate
      WHERE sensor_data IS NOT NULL AND TRIM(sensor_data) <> ''
    `,
  );

  return row?.count ?? 0;
}

function asNullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseAccelGravity(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }

  const x = asNullableNumber(value[0]);
  const y = asNullableNumber(value[1]);
  const z = asNullableNumber(value[2]);

  return x !== null && y !== null && z !== null ? [x, y, z] : null;
}

function parseSensorDataBackfillRow(rowId: number, value: string) {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error(`Unable to migrate heart_rate row ${rowId}: invalid sensor_data JSON.`);
  }

  const accelGravity = parseAccelGravity(parsed.accel_gravity);

  return {
    ppgGreen: asNullableNumber(parsed.ppg_green),
    ppgRedIr: asNullableNumber(parsed.ppg_red_ir),
    spo2Red: asNullableNumber(parsed.spo2_red),
    spo2Ir: asNullableNumber(parsed.spo2_ir),
    skinTempRaw: asNullableNumber(parsed.skin_temp_raw),
    ambientLight: asNullableNumber(parsed.ambient_light),
    ledDrive1: asNullableNumber(parsed.led_drive_1),
    ledDrive2: asNullableNumber(parsed.led_drive_2),
    respRateRaw: asNullableNumber(parsed.resp_rate_raw),
    signalQuality: asNullableNumber(parsed.signal_quality),
    skinContact: asNullableNumber(parsed.skin_contact),
    accelGravityX: accelGravity?.[0] ?? null,
    accelGravityY: accelGravity?.[1] ?? null,
    accelGravityZ: accelGravity?.[2] ?? null,
  };
}

async function backfillHeartRateSensorColumns(
  db: SQLiteDatabase,
  options?: {
    onProgress?: (completedRows: number, totalRows: number) => void;
  },
) {
  const heartRateColumns = await heartRateColumnNames(db);

  if (!heartRateColumns.has('sensor_data')) {
    return 0;
  }

  const rows = await db.getAllAsync<{ id: number; sensor_data: string }>(
    `
      SELECT id, sensor_data
      FROM heart_rate
      WHERE sensor_data IS NOT NULL AND TRIM(sensor_data) <> ''
      ORDER BY id ASC
    `,
  );

  if (rows.length === 0) {
    return 0;
  }

  await db.execAsync('BEGIN IMMEDIATE;');

  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const migrated = parseSensorDataBackfillRow(row.id, row.sensor_data);

      await db.runAsync(
        `
          UPDATE heart_rate
          SET
            ppg_green = COALESCE(ppg_green, ?),
            ppg_red_ir = COALESCE(ppg_red_ir, ?),
            spo2_red = COALESCE(spo2_red, ?),
            spo2_ir = COALESCE(spo2_ir, ?),
            skin_temp_raw = COALESCE(skin_temp_raw, ?),
            ambient_light = COALESCE(ambient_light, ?),
            led_drive_1 = COALESCE(led_drive_1, ?),
            led_drive_2 = COALESCE(led_drive_2, ?),
            resp_rate_raw = COALESCE(resp_rate_raw, ?),
            signal_quality = COALESCE(signal_quality, ?),
            skin_contact = COALESCE(skin_contact, ?),
            accel_gravity_x = COALESCE(accel_gravity_x, ?),
            accel_gravity_y = COALESCE(accel_gravity_y, ?),
            accel_gravity_z = COALESCE(accel_gravity_z, ?),
            sensor_data = NULL
          WHERE id = ?
        `,
        migrated.ppgGreen,
        migrated.ppgRedIr,
        migrated.spo2Red,
        migrated.spo2Ir,
        migrated.skinTempRaw,
        migrated.ambientLight,
        migrated.ledDrive1,
        migrated.ledDrive2,
        migrated.respRateRaw,
        migrated.signalQuality,
        migrated.skinContact,
        migrated.accelGravityX,
        migrated.accelGravityY,
        migrated.accelGravityZ,
        row.id,
      );

      options?.onProgress?.(index + 1, rows.length);
    }

    await db.execAsync('COMMIT;');
  } catch (error) {
    try {
      await db.execAsync('ROLLBACK;');
    } catch {}

    throw error;
  }

  return rows.length;
}

export async function inspectRequiredStartupMigration(db: SQLiteDatabase): Promise<StartupMigrationInspection> {
  const [needsRewrite, pendingSensorDataBackfillRows] = await Promise.all([
    heartRateNeedsRewrite(db),
    countPendingSensorDataBackfillRows(db),
  ]);

  return {
    heartRateNeedsRewrite: needsRewrite,
    pendingSensorDataBackfillRows,
    needsMigration: needsRewrite || pendingSensorDataBackfillRows > 0,
  };
}

export async function runRequiredStartupMigration(
  db: SQLiteDatabase,
  options?: StartupMigrationRunOptions,
): Promise<StartupMigrationResult> {
  const inspection = await inspectRequiredStartupMigration(db);
  let rewroteHeartRateSchema = false;
  const totalUnits = (inspection.heartRateNeedsRewrite ? 1 : 0) + inspection.pendingSensorDataBackfillRows;

  if (totalUnits > 0) {
    options?.onProgress?.({
      stage: inspection.pendingSensorDataBackfillRows > 0 ? 'sensor_data_backfill' : 'heart_rate_rewrite',
      completedUnits: 0,
      totalUnits,
      backfilledSensorDataRows: 0,
      totalSensorDataRows: inspection.pendingSensorDataBackfillRows,
    });
  }

  const backfilledSensorDataRows = await backfillHeartRateSensorColumns(db, {
    onProgress: (completedRows, totalRows) => {
      if (totalUnits === 0) {
        return;
      }

      options?.onProgress?.({
        stage: completedRows >= totalRows && !inspection.heartRateNeedsRewrite ? 'complete' : 'sensor_data_backfill',
        completedUnits: completedRows,
        totalUnits,
        backfilledSensorDataRows: completedRows,
        totalSensorDataRows: totalRows,
      });
    },
  });

  if (inspection.heartRateNeedsRewrite) {
    if (totalUnits > 0) {
      options?.onProgress?.({
        stage: 'heart_rate_rewrite',
        completedUnits: backfilledSensorDataRows,
        totalUnits,
        backfilledSensorDataRows,
        totalSensorDataRows: inspection.pendingSensorDataBackfillRows,
      });
    }

    await rewriteHeartRateTable(db);
    rewroteHeartRateSchema = true;
  }

  if (totalUnits > 0) {
    options?.onProgress?.({
      stage: 'complete',
      completedUnits: totalUnits,
      totalUnits,
      backfilledSensorDataRows,
      totalSensorDataRows: inspection.pendingSensorDataBackfillRows,
    });
  }

  return {
    ran: rewroteHeartRateSchema || backfilledSensorDataRows > 0,
    rewroteHeartRateSchema,
    backfilledSensorDataRows,
  };
}

export async function inspectDatabaseMaintenance(db: SQLiteDatabase): Promise<DatabaseMaintenanceInspection> {
  const [needsRewrite, pageCount, pageSizeBytes, freelistCount] = await Promise.all([
    heartRateNeedsRewrite(db),
    getPragmaCount(db, 'page_count'),
    getPragmaCount(db, 'page_size'),
    getPragmaCount(db, 'freelist_count'),
  ]);
  const sizeBytes = pageCount * pageSizeBytes;
  const freeBytes = freelistCount * pageSizeBytes;

  return {
    heartRateNeedsRewrite: needsRewrite,
    pageCount,
    pageSizeBytes,
    freelistCount,
    sizeBytes,
    freeBytes,
    needsMaintenance: needsRewrite || freeBytes >= VACUUM_FREE_BYTES_THRESHOLD,
  };
}

async function checkpointWal(db: SQLiteDatabase) {
  try {
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {}
}

export async function runDatabaseMaintenance(db: SQLiteDatabase): Promise<DatabaseMaintenanceResult> {
  const before = await inspectDatabaseMaintenance(db);
  let rewroteHeartRateSchema = false;

  if (before.heartRateNeedsRewrite) {
    await backfillHeartRateSensorColumns(db);
    await rewriteHeartRateTable(db);
    rewroteHeartRateSchema = true;
  }

  const shouldVacuum = rewroteHeartRateSchema || before.freeBytes >= VACUUM_FREE_BYTES_THRESHOLD;

  if (shouldVacuum) {
    await checkpointWal(db);
    await db.execAsync('VACUUM;');
    await checkpointWal(db);
  }

  const after = await inspectDatabaseMaintenance(db);

  return {
    ran: rewroteHeartRateSchema || shouldVacuum,
    rewroteHeartRateSchema,
    vacuumed: shouldVacuum,
    sizeBytesBefore: before.sizeBytes,
    sizeBytesAfter: after.sizeBytes,
    freeBytesBefore: before.freeBytes,
    freeBytesAfter: after.freeBytes,
    reclaimedBytes: Math.max(before.sizeBytes - after.sizeBytes, 0),
  };
}