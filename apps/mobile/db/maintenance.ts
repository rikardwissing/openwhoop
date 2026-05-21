import type { SQLiteDatabase } from 'expo-sqlite';

import {
  estimateDerivedDataRefreshChunkCount,
  refreshDerivedData,
  type DerivedDataRefreshProgress,
} from '@/data/sqlite/SQLiteHealthRepository';
import {
  DERIVED_DATA_SCHEMA_VERSION,
  rewriteHeartRateTable,
  type RewriteHeartRateTableProgress,
} from '@/db/schema';

const VACUUM_FREE_BYTES_THRESHOLD = 16 * 1024 * 1024;
const HEART_RATE_REWRITE_PROGRESS_UNITS = 4;
const DERIVED_DATA_REFRESH_FIXED_PROGRESS_UNITS = 3;

interface SqliteCountRow {
  count?: number;
  [key: string]: number | null | undefined;
}

interface HeartTimeBoundsRow {
  min_time: string | null;
  max_time: string | null;
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
  derivedDataNeedsRefresh: boolean;
  derivedRefreshChunkCount: number;
  estimatedTotalUnits: number;
  needsMigration: boolean;
}

export interface StartupMigrationResult {
  ran: boolean;
  rewroteHeartRateSchema: boolean;
  backfilledSensorDataRows: number;
  refreshedDerivedData: boolean;
}

export interface StartupMigrationProgress {
  stage: 'heart_rate_rewrite' | 'sensor_data_backfill' | 'derived_data_refresh' | 'complete';
  completedUnits: number;
  totalUnits: number;
  stageCompletedUnits: number;
  stageTotalUnits: number;
  stageLabel?: string;
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

async function countHeartRows(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<SqliteCountRow>(
    `
      SELECT COUNT(*) AS count
      FROM heart_rate
    `,
  );

  return row?.count ?? 0;
}

async function loadHeartTimeBounds(db: SQLiteDatabase) {
  return db.getFirstAsync<HeartTimeBoundsRow>(
    `
      SELECT MIN(time) AS min_time, MAX(time) AS max_time
      FROM heart_rate
    `,
  );
}

async function derivedDataNeedsStartupRefresh(db: SQLiteDatabase) {
  const heartCount = await countHeartRows(db);

  if (heartCount === 0) {
    return false;
  }

  const row = await db.getFirstAsync<{ derived_schema_version: number | null }>(
    `
      SELECT derived_schema_version
      FROM derived_data_state
      WHERE id = 1
    `,
  );

  return row?.derived_schema_version !== DERIVED_DATA_SCHEMA_VERSION;
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

function estimateStartupMigrationTotalUnits(inspection: {
  heartRateNeedsRewrite: boolean;
  pendingSensorDataBackfillRows: number;
  derivedDataNeedsRefresh: boolean;
  derivedRefreshChunkCount: number;
}) {
  return Math.max(
    inspection.pendingSensorDataBackfillRows +
      (inspection.heartRateNeedsRewrite ? HEART_RATE_REWRITE_PROGRESS_UNITS : 0) +
      (inspection.derivedDataNeedsRefresh
        ? inspection.derivedRefreshChunkCount + DERIVED_DATA_REFRESH_FIXED_PROGRESS_UNITS
        : 0),
    1,
  );
}

function stageTotalUnitsForInspection(
  inspection: StartupMigrationInspection,
  stage: StartupMigrationProgress['stage'],
) {
  if (stage === 'sensor_data_backfill') {
    return inspection.pendingSensorDataBackfillRows;
  }

  if (stage === 'heart_rate_rewrite') {
    return HEART_RATE_REWRITE_PROGRESS_UNITS;
  }

  if (stage === 'derived_data_refresh') {
    return inspection.derivedRefreshChunkCount + DERIVED_DATA_REFRESH_FIXED_PROGRESS_UNITS;
  }

  return 0;
}

function initialStartupMigrationStage(
  inspection: StartupMigrationInspection,
): Exclude<StartupMigrationProgress['stage'], 'complete'> {
  if (inspection.pendingSensorDataBackfillRows > 0) {
    return 'sensor_data_backfill';
  }

  if (inspection.heartRateNeedsRewrite) {
    return 'heart_rate_rewrite';
  }

  return 'derived_data_refresh';
}

function rewriteStageLabel(progress: RewriteHeartRateTableProgress) {
  switch (progress.phase) {
    case 'ensuring_columns':
      return 'Checking heart table columns';
    case 'creating_replacement_table':
      return 'Preparing replacement heart table';
    case 'copying_rows':
      return 'Copying saved heart rows';
    case 'swapping_tables':
      return 'Switching to the migrated heart table';
    case 'complete':
      return 'Heart table rewrite finished';
  }
}

function derivedRefreshStageLabel(progress: DerivedDataRefreshProgress) {
  switch (progress.phase) {
    case 'clearing':
      return 'Clearing stale insights';
    case 'refreshing_range':
      if (progress.currentChunk && progress.totalChunks > 0) {
        return `Rebuilding time window ${progress.currentChunk} of ${progress.totalChunks}`;
      }

      return 'Preparing derived data windows';
    case 'persisting_sleep_feature_state':
      return 'Saving rebuilt sleep features';
    case 'persisting_state':
      return 'Saving derived data state';
    case 'complete':
      return 'Derived data refresh finished';
  }
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

  await db.withExclusiveTransactionAsync(async (tx) => {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const migrated = parseSensorDataBackfillRow(row.id, row.sensor_data);

      await tx.runAsync(
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
  });

  return rows.length;
}

export async function inspectRequiredStartupMigration(db: SQLiteDatabase): Promise<StartupMigrationInspection> {
  const [needsRewrite, pendingSensorDataBackfillRows, derivedDataNeedsRefresh] = await Promise.all([
    heartRateNeedsRewrite(db),
    countPendingSensorDataBackfillRows(db),
    derivedDataNeedsStartupRefresh(db),
  ]);

  let derivedRefreshChunkCount = 0;
  if (derivedDataNeedsRefresh) {
    const bounds = await loadHeartTimeBounds(db);
    if (bounds?.min_time && bounds.max_time) {
      derivedRefreshChunkCount = estimateDerivedDataRefreshChunkCount(bounds.min_time, bounds.max_time);
    }
  }

  const estimatedTotalUnits = estimateStartupMigrationTotalUnits({
    heartRateNeedsRewrite: needsRewrite,
    pendingSensorDataBackfillRows,
    derivedDataNeedsRefresh,
    derivedRefreshChunkCount,
  });

  return {
    heartRateNeedsRewrite: needsRewrite,
    pendingSensorDataBackfillRows,
    derivedDataNeedsRefresh,
    derivedRefreshChunkCount,
    estimatedTotalUnits,
    needsMigration: needsRewrite || pendingSensorDataBackfillRows > 0 || derivedDataNeedsRefresh,
  };
}

export async function runRequiredStartupMigration(
  db: SQLiteDatabase,
  options?: StartupMigrationRunOptions,
): Promise<StartupMigrationResult> {
  const inspection = await inspectRequiredStartupMigration(db);
  let rewroteHeartRateSchema = false;
  let refreshedDerivedData = false;
  const totalUnits = inspection.estimatedTotalUnits;
  let completedUnits = 0;
  let currentBackfilledSensorDataRows = 0;

  const emitProgress = ({
    stage,
    stageCompletedUnits,
    stageLabel,
    stageTotalUnits,
  }: {
    stage: StartupMigrationProgress['stage'];
    stageCompletedUnits: number;
    stageLabel?: string;
    stageTotalUnits: number;
  }) => {
    options?.onProgress?.({
      stage,
      completedUnits: completedUnits + stageCompletedUnits,
      totalUnits,
      stageCompletedUnits,
      stageTotalUnits,
      stageLabel,
      backfilledSensorDataRows: currentBackfilledSensorDataRows,
      totalSensorDataRows: inspection.pendingSensorDataBackfillRows,
    });
  };

  if (totalUnits > 0) {
    const initialStage = initialStartupMigrationStage(inspection);
    emitProgress({
      stage: initialStage,
      stageCompletedUnits: 0,
      stageTotalUnits: stageTotalUnitsForInspection(inspection, initialStage),
      stageLabel:
        initialStage === 'heart_rate_rewrite'
          ? 'Checking heart table columns'
          : initialStage === 'derived_data_refresh'
            ? 'Clearing stale insights'
            : undefined,
    });
  }

  const backfilledSensorDataRows = await backfillHeartRateSensorColumns(db, {
    onProgress: (completedRows, totalRows) => {
      currentBackfilledSensorDataRows = completedRows;
      if (totalUnits === 0 || totalRows === 0) {
        return;
      }

      emitProgress({
        stage: 'sensor_data_backfill',
        stageCompletedUnits: completedRows,
        stageTotalUnits: totalRows,
      });
    },
  });
  currentBackfilledSensorDataRows = backfilledSensorDataRows;
  completedUnits += backfilledSensorDataRows;

  if (inspection.heartRateNeedsRewrite) {
    await rewriteHeartRateTable(db, {
      onProgress: (progress) => {
        emitProgress({
          stage: 'heart_rate_rewrite',
          stageCompletedUnits: progress.completedUnits,
          stageTotalUnits: progress.totalUnits,
          stageLabel: rewriteStageLabel(progress),
        });
      },
    });
    completedUnits += HEART_RATE_REWRITE_PROGRESS_UNITS;
    rewroteHeartRateSchema = true;
  }

  if (inspection.derivedDataNeedsRefresh) {
    await refreshDerivedData(db, {
      onProgress: (progress) => {
        emitProgress({
          stage: 'derived_data_refresh',
          stageCompletedUnits: progress.completedUnits,
          stageTotalUnits: progress.totalUnits,
          stageLabel: derivedRefreshStageLabel(progress),
        });
      },
    });
    completedUnits += inspection.derivedRefreshChunkCount + DERIVED_DATA_REFRESH_FIXED_PROGRESS_UNITS;
    refreshedDerivedData = true;
  }

  if (totalUnits > 0) {
    options?.onProgress?.({
      stage: 'complete',
      completedUnits: totalUnits,
      totalUnits,
      stageCompletedUnits: 0,
      stageTotalUnits: 0,
      stageLabel: 'Migration finished',
      backfilledSensorDataRows,
      totalSensorDataRows: inspection.pendingSensorDataBackfillRows,
    });
  }

  return {
    ran: rewroteHeartRateSchema || backfilledSensorDataRows > 0 || refreshedDerivedData,
    rewroteHeartRateSchema,
    backfilledSensorDataRows,
    refreshedDerivedData,
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
