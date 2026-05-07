import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  AuthorizationStatus,
  CategoryValueSleepAnalysis,
  ComparisonPredicateOperator,
  authorizationStatusFor,
  deleteObjects,
  isHealthDataAvailable,
  requestAuthorization,
  saveCategorySample,
  saveQuantitySample,
} from '@kingstinct/react-native-healthkit';

import { formatSqliteDateTime, parseSqliteDateTime } from '@/utils/dateTime';
import { MAX_PLAUSIBLE_RECORDED_BPM, MIN_PLAUSIBLE_RECORDED_BPM } from '@/utils/heartRate';
import {
  MAX_PLAUSIBLE_RESPIRATORY_RATE,
  MAX_PLAUSIBLE_RESPIRATORY_RATE_RAW,
  MIN_PLAUSIBLE_RESPIRATORY_RATE,
  MIN_PLAUSIBLE_RESPIRATORY_RATE_RAW,
  RESPIRATORY_RATE_RAW_VALUE_DIVISOR,
} from '@/utils/respiratoryRate';

const HEALTHKIT_WRITE_TYPES = [
  'HKCategoryTypeIdentifierSleepAnalysis',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierOxygenSaturation',
  'HKQuantityTypeIdentifierRespiratoryRate',
] as const;
type AppleHealthWriteType = typeof HEALTHKIT_WRITE_TYPES[number];

const APPLE_HEALTH_EXPORT_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS apple_health_export_state (
    metric_key TEXT PRIMARY KEY NOT NULL,
    last_exported_at TEXT,
    exported_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`;

const DEFAULT_LAST_EXPORTED_AT = '1970-01-01 00:00:00';
const EXPORT_BUCKET_SECONDS = 5 * 60;
const MAX_QUANTITY_EXPORT_BATCH = 2500;
const MAX_SLEEP_EXPORT_BATCH = 500;
const HEALTHKIT_OPERATION_TIMEOUT_MS = 10_000;
const HEALTHKIT_BACKGROUND_DEADLINE_RESERVE_MS = 1_500;
const MIN_PLAUSIBLE_SPO2 = 70;
const MAX_PLAUSIBLE_SPO2 = 100;
const OXYGEN_SATURATION_PERCENT_UNIT_MIGRATION_KEY = 'oxygenSaturation.percentUnitMigration.v1';
const OXYGEN_SATURATION_CALIBRATION_MIGRATION_KEY = 'oxygenSaturation.calibrationMigration.v1';
const OXYGEN_SATURATION_SAFE_REEXPORT_MIGRATION_KEY = 'oxygenSaturation.safeReexport.v1';
const OXYGEN_SATURATION_LEGACY_CLEANUP_MIGRATION_KEY = 'oxygenSaturation.legacyCleanup.v1';
const OXYGEN_SATURATION_EXPORT_VERSION = 2;
const RESPIRATORY_RATE_RAW_ENCODING_MIGRATION_KEY = 'respiratoryRate.rawEncodingMigration.v1';
const RESPIRATORY_RATE_SAFE_REEXPORT_MIGRATION_KEY = 'respiratoryRate.safeReexport.v1';
const RESPIRATORY_RATE_LEGACY_CLEANUP_MIGRATION_KEY = 'respiratoryRate.legacyCleanup.v1';
const RESPIRATORY_RATE_EXPORT_VERSION = 2;
const MIN_PLAUSIBLE_HRV_SDNN = 1;
const MAX_PLAUSIBLE_HRV_SDNN = 300;

type AppleHealthExportMetric = 'sleep' | 'heartRate' | 'hrvSdnn' | 'oxygenSaturation' | 'respiratoryRate';

type AppleHealthDb = Pick<SQLiteDatabase, 'execAsync' | 'getAllAsync' | 'getFirstAsync' | 'runAsync'>;

interface AppleHealthExportStateRow {
  last_exported_at: string | null;
  exported_count: number | null;
}

interface HeartBucketRow {
  start_time: string;
  end_time: string;
  avg_bpm: number;
  sample_count: number;
}

interface OxygenBucketRow {
  start_time: string;
  end_time: string;
  avg_spo2: number;
  sample_count: number;
}

interface RespiratoryRateBucketRow {
  start_time: string;
  end_time: string;
  avg_respiratory_rate: number;
  sample_count: number;
}

interface HrvSourceRow {
  id: number;
  time: string;
  rr_intervals: string;
}

interface SleepCycleExportRow {
  sleep_id: string;
  start: string;
  end: string;
}

interface SleepStageExportRow {
  start: string;
  end: string;
  stage: string;
}

export interface AppleHealthMetricExportSummary {
  exported: number;
  skipped: number;
  lastExportedAt: string | null;
  hasMore: boolean;
}

export interface AppleHealthExportResult {
  status: 'success' | 'unavailable' | 'permission_denied';
  message: string;
  totals: {
    exported: number;
    skipped: number;
  };
  metrics: Record<AppleHealthExportMetric, AppleHealthMetricExportSummary>;
}

function emptyMetricSummary(): AppleHealthMetricExportSummary {
  return {
    exported: 0,
    skipped: 0,
    lastExportedAt: null,
    hasMore: false,
  };
}

function emptyExportResult(status: AppleHealthExportResult['status'], message: string): AppleHealthExportResult {
  return {
    status,
    message,
    totals: {
      exported: 0,
      skipped: 0,
    },
    metrics: {
      sleep: emptyMetricSummary(),
      heartRate: emptyMetricSummary(),
      hrvSdnn: emptyMetricSummary(),
      oxygenSaturation: emptyMetricSummary(),
      respiratoryRate: emptyMetricSummary(),
    },
  };
}

async function ensureAppleHealthExportState(db: AppleHealthDb) {
  await db.execAsync(APPLE_HEALTH_EXPORT_STATE_TABLE_SQL);
}

async function loadExportState(db: AppleHealthDb, metric: string) {
  const row = await db.getFirstAsync<AppleHealthExportStateRow>(
    `
      SELECT last_exported_at, exported_count
      FROM apple_health_export_state
      WHERE metric_key = ?
    `,
    [metric],
  );

  return {
    lastExportedAt: row?.last_exported_at ?? DEFAULT_LAST_EXPORTED_AT,
    exportedCount: row?.exported_count ?? 0,
  };
}

async function saveExportState(
  db: AppleHealthDb,
  metric: string,
  lastExportedAt: string,
  exportedCount: number,
) {
  await db.runAsync(
    `
      INSERT INTO apple_health_export_state (metric_key, last_exported_at, exported_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(metric_key) DO UPDATE SET
        last_exported_at = excluded.last_exported_at,
        exported_count = excluded.exported_count,
        updated_at = excluded.updated_at
    `,
    [metric, lastExportedAt, exportedCount, formatSqliteDateTime(new Date())],
  );
}

async function deleteExportState(db: AppleHealthDb, metric: string) {
  await db.runAsync('DELETE FROM apple_health_export_state WHERE metric_key = ?', [metric]);
}

async function markMetricReexportMigration(
  db: AppleHealthDb,
  migrationKey: string,
  metric: AppleHealthExportMetric,
) {
  const migrationState = await loadExportState(db, migrationKey);
  if (migrationState.lastExportedAt !== DEFAULT_LAST_EXPORTED_AT) {
    return false;
  }

  await deleteExportState(db, metric);
  await saveExportState(db, migrationKey, formatSqliteDateTime(new Date()), 1);
  return true;
}

function assertAppleHealthExportBudget(options: AppleHealthExportOptions | undefined, label: string) {
  if (
    options?.deadlineMs !== undefined &&
    Date.now() + HEALTHKIT_BACKGROUND_DEADLINE_RESERVE_MS >= options.deadlineMs
  ) {
    throw new Error(`${label} paused because the background sync window is closing.`);
  }
}

function resolveHealthKitOperationTimeout(options: AppleHealthExportOptions | undefined) {
  if (options?.deadlineMs === undefined) {
    return HEALTHKIT_OPERATION_TIMEOUT_MS;
  }

  return Math.max(
    1_000,
    Math.min(
      HEALTHKIT_OPERATION_TIMEOUT_MS,
      options.deadlineMs - Date.now() - HEALTHKIT_BACKGROUND_DEADLINE_RESERVE_MS,
    ),
  );
}

async function withHealthKitOperationTimeout<T>(
  operation: () => Promise<T>,
  label: string,
  options?: AppleHealthExportOptions,
) {
  assertAppleHealthExportBudget(options, label);
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out while Apple Health was busy.`));
        }, resolveHealthKitOperationTimeout(options));
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function buildLegacyMetricCleanupFilter(metric: AppleHealthExportMetric, currentVersion: number) {
  return {
    AND: [
      {
        metadata: {
          withMetadataKey: 'UnstrapMetric',
          value: metric,
        },
      },
      {
        metadata: {
          withMetadataKey: 'HKSyncVersion',
          operatorType: ComparisonPredicateOperator.lessThan,
          value: currentVersion,
        },
      },
    ],
  };
}

async function cleanupLegacyMetricSamples(
  db: AppleHealthDb,
  migrationKey: string,
  typeIdentifier: AppleHealthWriteType,
  metric: AppleHealthExportMetric,
  currentVersion: number,
  options?: AppleHealthExportOptions,
) {
  const migrationState = await loadExportState(db, migrationKey);
  if (migrationState.lastExportedAt !== DEFAULT_LAST_EXPORTED_AT) {
    return;
  }

  const deleted = await withHealthKitOperationTimeout(
    () => deleteObjects(typeIdentifier, buildLegacyMetricCleanupFilter(metric, currentVersion)),
    `Apple Health cleanup for ${metric}`,
    options,
  );
  await saveExportState(db, migrationKey, formatSqliteDateTime(new Date()), deleted);
}

function sampleEndDate(start: Date, end: Date) {
  return end.getTime() > start.getTime() ? end : new Date(start.getTime() + 1000);
}

type HealthKitWriteMetadata = Record<string, never>;

function metadataFor(metric: AppleHealthExportMetric, id: string, version = 1): HealthKitWriteMetadata {
  const syncId = `unstrap.${metric}.${id}`;

  return {
    HKDeviceManufacturerName: 'Unstrap',
    HKDeviceName: 'Unstrap wearable',
    HKExternalUUID: syncId,
    HKSyncIdentifier: syncId,
    HKSyncVersion: version,
    HKWasUserEntered: false,
    UnstrapMetric: metric,
  } as unknown as HealthKitWriteMetadata;
}

function parseRrIntervals(value: string): number[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part > 0);
}

function standardDeviation(values: readonly number[]) {
  if (values.length < 2) {
    return null;
  }

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function sleepStageValue(stage: string) {
  switch (stage) {
    case 'awake':
      return CategoryValueSleepAnalysis.awake;
    case 'rem':
      return CategoryValueSleepAnalysis.asleepREM;
    case 'deep':
      return CategoryValueSleepAnalysis.asleepDeep;
    case 'light':
      return CategoryValueSleepAnalysis.asleepCore;
    default:
      return CategoryValueSleepAnalysis.asleepUnspecified;
  }
}

export interface AppleHealthExportOptions {
  deadlineMs?: number;
  requestAuthorization?: boolean;
}

function getAuthorizedAppleHealthWriteTypes() {
  return new Set(
    HEALTHKIT_WRITE_TYPES.filter(
      (typeIdentifier) => authorizationStatusFor(typeIdentifier) === AuthorizationStatus.sharingAuthorized,
    ),
  );
}

async function requestAppleHealthWriteAuthorization() {
  const didRequest = await requestAuthorization({
    toShare: HEALTHKIT_WRITE_TYPES,
  });

  if (!didRequest) {
    return new Set<AppleHealthWriteType>();
  }

  return getAuthorizedAppleHealthWriteTypes();
}

export async function writeLocalMetricsToAppleHealthIfAuthorized(
  db: AppleHealthDb,
  options?: Omit<AppleHealthExportOptions, 'requestAuthorization'>,
): Promise<AppleHealthExportResult> {
  return writeLocalMetricsToAppleHealth(db, { ...options, requestAuthorization: false });
}

async function exportHeartRate(
  db: AppleHealthDb,
  options?: AppleHealthExportOptions,
): Promise<AppleHealthMetricExportSummary> {
  const state = await loadExportState(db, 'heartRate');
  const rows = await db.getAllAsync<HeartBucketRow>(
    `
      SELECT
        MIN(time) AS start_time,
        MAX(time) AS end_time,
        AVG(bpm) AS avg_bpm,
        COUNT(*) AS sample_count
      FROM heart_rate
      WHERE time > ?
        AND bpm BETWEEN ? AND ?
      GROUP BY CAST(strftime('%s', time) / ? AS INTEGER)
      ORDER BY start_time ASC
      LIMIT ?
    `,
    [
      state.lastExportedAt,
      MIN_PLAUSIBLE_RECORDED_BPM,
      MAX_PLAUSIBLE_RECORDED_BPM,
      EXPORT_BUCKET_SECONDS,
      MAX_QUANTITY_EXPORT_BATCH,
    ],
  );

  let exported = 0;
  let skipped = 0;
  let lastExportedAt = state.lastExportedAt;

  try {
    for (const row of rows) {
      const start = parseSqliteDateTime(row.start_time);
      const end = sampleEndDate(start, parseSqliteDateTime(row.end_time));
      const bpm = Math.round(row.avg_bpm);

      if (!Number.isFinite(bpm) || bpm < MIN_PLAUSIBLE_RECORDED_BPM || bpm > MAX_PLAUSIBLE_RECORDED_BPM) {
        skipped += 1;
        lastExportedAt = row.end_time;
        continue;
      }

      await withHealthKitOperationTimeout(
        () => saveQuantitySample(
          'HKQuantityTypeIdentifierHeartRate',
          'count/min',
          bpm,
          start,
          end,
          metadataFor('heartRate', row.start_time),
        ),
        'Apple Health heart rate save',
        options,
      );

      exported += 1;
      lastExportedAt = row.end_time;
    }
  } finally {
    if (lastExportedAt !== state.lastExportedAt) {
      await saveExportState(db, 'heartRate', lastExportedAt, state.exportedCount + exported);
    }
  }

  return {
    exported,
    skipped,
    lastExportedAt: lastExportedAt === DEFAULT_LAST_EXPORTED_AT ? null : lastExportedAt,
    hasMore: rows.length === MAX_QUANTITY_EXPORT_BATCH,
  };
}

async function exportHrvSdnn(
  db: AppleHealthDb,
  options?: AppleHealthExportOptions,
): Promise<AppleHealthMetricExportSummary> {
  const state = await loadExportState(db, 'hrvSdnn');
  const rows = await db.getAllAsync<HrvSourceRow>(
    `
      SELECT id, time, rr_intervals
      FROM heart_rate
      WHERE time > ?
        AND rr_intervals <> ''
      ORDER BY time ASC
      LIMIT ?
    `,
    [state.lastExportedAt, MAX_QUANTITY_EXPORT_BATCH],
  );

  let exported = 0;
  let skipped = 0;
  let lastExportedAt = state.lastExportedAt;

  try {
    for (const row of rows) {
      const rr = parseRrIntervals(row.rr_intervals);
      const sdnn = standardDeviation(rr);

      if (sdnn === null || sdnn < MIN_PLAUSIBLE_HRV_SDNN || sdnn > MAX_PLAUSIBLE_HRV_SDNN) {
        skipped += 1;
        lastExportedAt = row.time;
        continue;
      }

      const start = parseSqliteDateTime(row.time);
      await withHealthKitOperationTimeout(
        () => saveQuantitySample(
          'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
          'ms',
          Math.round(sdnn),
          start,
          sampleEndDate(start, start),
          metadataFor('hrvSdnn', `${row.id}`),
        ),
        'Apple Health HRV save',
        options,
      );

      exported += 1;
      lastExportedAt = row.time;
    }
  } finally {
    if (lastExportedAt !== state.lastExportedAt) {
      await saveExportState(db, 'hrvSdnn', lastExportedAt, state.exportedCount + exported);
    }
  }

  return {
    exported,
    skipped,
    lastExportedAt: lastExportedAt === DEFAULT_LAST_EXPORTED_AT ? null : lastExportedAt,
    hasMore: rows.length === MAX_QUANTITY_EXPORT_BATCH,
  };
}

async function exportOxygenSaturation(
  db: AppleHealthDb,
  options?: AppleHealthExportOptions,
): Promise<AppleHealthMetricExportSummary> {
  await markMetricReexportMigration(
    db,
    OXYGEN_SATURATION_PERCENT_UNIT_MIGRATION_KEY,
    'oxygenSaturation',
  );
  await markMetricReexportMigration(
    db,
    OXYGEN_SATURATION_CALIBRATION_MIGRATION_KEY,
    'oxygenSaturation',
  );
  await markMetricReexportMigration(
    db,
    OXYGEN_SATURATION_SAFE_REEXPORT_MIGRATION_KEY,
    'oxygenSaturation',
  );

  const state = await loadExportState(db, 'oxygenSaturation');
  const rows = await db.getAllAsync<OxygenBucketRow>(
    `
      SELECT
        MIN(time) AS start_time,
        MAX(time) AS end_time,
        AVG(spo2) AS avg_spo2,
        COUNT(*) AS sample_count
      FROM heart_rate
      WHERE time > ?
        AND spo2 BETWEEN ? AND ?
      GROUP BY CAST(strftime('%s', time) / ? AS INTEGER)
      ORDER BY start_time ASC
      LIMIT ?
    `,
    [
      state.lastExportedAt,
      MIN_PLAUSIBLE_SPO2,
      MAX_PLAUSIBLE_SPO2,
      EXPORT_BUCKET_SECONDS,
      MAX_QUANTITY_EXPORT_BATCH,
    ],
  );

  let exported = 0;
  let skipped = 0;
  let lastExportedAt = state.lastExportedAt;

  try {
    for (const row of rows) {
      const spo2 = Number(row.avg_spo2.toFixed(1));

      if (!Number.isFinite(spo2) || spo2 < MIN_PLAUSIBLE_SPO2 || spo2 > MAX_PLAUSIBLE_SPO2) {
        skipped += 1;
        lastExportedAt = row.end_time;
        continue;
      }

      const start = parseSqliteDateTime(row.start_time);
      const end = sampleEndDate(start, parseSqliteDateTime(row.end_time));
      await withHealthKitOperationTimeout(
        () => saveQuantitySample(
          'HKQuantityTypeIdentifierOxygenSaturation',
          '%',
          spo2 / 100,
          start,
          end,
          metadataFor('oxygenSaturation', row.start_time, OXYGEN_SATURATION_EXPORT_VERSION),
        ),
        'Apple Health oxygen saturation save',
        options,
      );

      exported += 1;
      lastExportedAt = row.end_time;
    }
  } finally {
    if (lastExportedAt !== state.lastExportedAt) {
      await saveExportState(db, 'oxygenSaturation', lastExportedAt, state.exportedCount + exported);
    }
  }

  const summary = {
    exported,
    skipped,
    lastExportedAt: lastExportedAt === DEFAULT_LAST_EXPORTED_AT ? null : lastExportedAt,
    hasMore: rows.length === MAX_QUANTITY_EXPORT_BATCH,
  };

  if (!summary.hasMore && (summary.exported > 0 || state.lastExportedAt !== DEFAULT_LAST_EXPORTED_AT)) {
    await cleanupLegacyMetricSamples(
      db,
      OXYGEN_SATURATION_LEGACY_CLEANUP_MIGRATION_KEY,
      'HKQuantityTypeIdentifierOxygenSaturation',
      'oxygenSaturation',
      OXYGEN_SATURATION_EXPORT_VERSION,
      options,
    ).catch((error) => {
      console.warn(
        '[apple-health] Deferred oxygen saturation cleanup',
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  return summary;
}

async function exportRespiratoryRate(
  db: AppleHealthDb,
  options?: AppleHealthExportOptions,
): Promise<AppleHealthMetricExportSummary> {
  await markMetricReexportMigration(
    db,
    RESPIRATORY_RATE_RAW_ENCODING_MIGRATION_KEY,
    'respiratoryRate',
  );
  await markMetricReexportMigration(
    db,
    RESPIRATORY_RATE_SAFE_REEXPORT_MIGRATION_KEY,
    'respiratoryRate',
  );

  const state = await loadExportState(db, 'respiratoryRate');
  const rows = await db.getAllAsync<RespiratoryRateBucketRow>(
    `
      SELECT
        MIN(time) AS start_time,
        MAX(time) AS end_time,
        AVG(CAST(resp_rate_raw / ${RESPIRATORY_RATE_RAW_VALUE_DIVISOR} AS INTEGER)) AS avg_respiratory_rate,
        COUNT(*) AS sample_count
      FROM heart_rate
      WHERE time > ?
        AND resp_rate_raw BETWEEN ? AND ?
      GROUP BY CAST(strftime('%s', time) / ? AS INTEGER)
      ORDER BY start_time ASC
      LIMIT ?
    `,
    [
      state.lastExportedAt,
      MIN_PLAUSIBLE_RESPIRATORY_RATE_RAW,
      MAX_PLAUSIBLE_RESPIRATORY_RATE_RAW,
      EXPORT_BUCKET_SECONDS,
      MAX_QUANTITY_EXPORT_BATCH,
    ],
  );

  let exported = 0;
  let skipped = 0;
  let lastExportedAt = state.lastExportedAt;

  try {
    for (const row of rows) {
      const respiratoryRate = Number(row.avg_respiratory_rate.toFixed(1));

      if (
        !Number.isFinite(respiratoryRate) ||
        respiratoryRate < MIN_PLAUSIBLE_RESPIRATORY_RATE ||
        respiratoryRate > MAX_PLAUSIBLE_RESPIRATORY_RATE
      ) {
        skipped += 1;
        lastExportedAt = row.end_time;
        continue;
      }

      const start = parseSqliteDateTime(row.start_time);
      const end = sampleEndDate(start, parseSqliteDateTime(row.end_time));
      await withHealthKitOperationTimeout(
        () => saveQuantitySample(
          'HKQuantityTypeIdentifierRespiratoryRate',
          'count/min',
          respiratoryRate,
          start,
          end,
          metadataFor('respiratoryRate', row.start_time, RESPIRATORY_RATE_EXPORT_VERSION),
        ),
        'Apple Health respiratory rate save',
        options,
      );

      exported += 1;
      lastExportedAt = row.end_time;
    }
  } finally {
    if (lastExportedAt !== state.lastExportedAt) {
      await saveExportState(db, 'respiratoryRate', lastExportedAt, state.exportedCount + exported);
    }
  }

  const summary = {
    exported,
    skipped,
    lastExportedAt: lastExportedAt === DEFAULT_LAST_EXPORTED_AT ? null : lastExportedAt,
    hasMore: rows.length === MAX_QUANTITY_EXPORT_BATCH,
  };

  if (!summary.hasMore && (summary.exported > 0 || state.lastExportedAt !== DEFAULT_LAST_EXPORTED_AT)) {
    await cleanupLegacyMetricSamples(
      db,
      RESPIRATORY_RATE_LEGACY_CLEANUP_MIGRATION_KEY,
      'HKQuantityTypeIdentifierRespiratoryRate',
      'respiratoryRate',
      RESPIRATORY_RATE_EXPORT_VERSION,
      options,
    ).catch((error) => {
      console.warn(
        '[apple-health] Deferred respiratory rate cleanup',
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  return summary;
}

async function loadSleepStages(db: AppleHealthDb, sleepId: string) {
  return db.getAllAsync<SleepStageExportRow>(
    `
      SELECT start, end, stage
      FROM sleep_stage_segments
      WHERE sleep_id = ?
      ORDER BY start ASC
    `,
    [sleepId],
  );
}

async function exportSleep(
  db: AppleHealthDb,
  options?: AppleHealthExportOptions,
): Promise<AppleHealthMetricExportSummary> {
  const state = await loadExportState(db, 'sleep');
  const rows = await db.getAllAsync<SleepCycleExportRow>(
    `
      SELECT sleep_id, start, end
      FROM sleep_cycles
      WHERE end > ?
        AND completion_status = 'complete'
      ORDER BY end ASC
      LIMIT ?
    `,
    [state.lastExportedAt, MAX_SLEEP_EXPORT_BATCH],
  );

  let exported = 0;
  let skipped = 0;
  let lastExportedAt = state.lastExportedAt;

  try {
    for (const row of rows) {
      const start = parseSqliteDateTime(row.start);
      const end = parseSqliteDateTime(row.end);

      if (end.getTime() <= start.getTime()) {
        skipped += 1;
        lastExportedAt = row.end;
        continue;
      }

      await withHealthKitOperationTimeout(
        () => saveCategorySample(
          'HKCategoryTypeIdentifierSleepAnalysis',
          CategoryValueSleepAnalysis.inBed,
          start,
          end,
          metadataFor('sleep', `${row.sleep_id}.inBed`),
        ),
        'Apple Health sleep save',
        options,
      );
      exported += 1;

      const stages = await loadSleepStages(db, row.sleep_id);
      const stageRows = stages.length > 0
        ? stages
        : [{ start: row.start, end: row.end, stage: 'asleepUnspecified' }];

      for (const stage of stageRows) {
        const stageStart = parseSqliteDateTime(stage.start);
        const stageEnd = parseSqliteDateTime(stage.end);

        if (stageEnd.getTime() <= stageStart.getTime()) {
          skipped += 1;
          continue;
        }

        await withHealthKitOperationTimeout(
          () => saveCategorySample(
            'HKCategoryTypeIdentifierSleepAnalysis',
            sleepStageValue(stage.stage),
            stageStart,
            stageEnd,
            metadataFor('sleep', `${row.sleep_id}.${stage.stage}.${stage.start}`),
          ),
          'Apple Health sleep stage save',
          options,
        );
        exported += 1;
      }

      lastExportedAt = row.end;
    }
  } finally {
    if (lastExportedAt !== state.lastExportedAt) {
      await saveExportState(db, 'sleep', lastExportedAt, state.exportedCount + exported);
    }
  }

  return {
    exported,
    skipped,
    lastExportedAt: lastExportedAt === DEFAULT_LAST_EXPORTED_AT ? null : lastExportedAt,
    hasMore: rows.length === MAX_SLEEP_EXPORT_BATCH,
  };
}

function buildResult(
  metrics: AppleHealthExportResult['metrics'],
  deniedTypes: readonly AppleHealthWriteType[],
  failedMetrics: readonly AppleHealthExportMetric[] = [],
): AppleHealthExportResult {
  const exported = Object.values(metrics).reduce((total, metric) => total + metric.exported, 0);
  const skipped = Object.values(metrics).reduce((total, metric) => total + metric.skipped, 0);
  const hasMore = Object.values(metrics).some((metric) => metric.hasMore);
  const permissionSuffix = deniedTypes.length > 0
    ? ` ${deniedTypes.length === 1 ? 'One metric is' : 'Some metrics are'} not enabled in Apple Health permissions.`
    : '';
  const failureSuffix = failedMetrics.length > 0
    ? ` ${failedMetrics.length === 1 ? 'One metric could' : 'Some metrics could'} not be written and will retry on the next sync.`
    : '';
  const message =
    failedMetrics.length > 0 && exported === 0 && skipped === 0
      ? `Apple Health was busy, so Unstrap kept local data and will retry on the next sync.${permissionSuffix}`
      : exported > 0
      ? `Wrote ${exported} Apple Health ${exported === 1 ? 'sample' : 'samples'}${skipped > 0 ? ` and skipped ${skipped}` : ''}.${hasMore ? ' More local samples are queued for the next export.' : ''}${permissionSuffix}${failureSuffix}`
      : skipped > 0
        ? `No new Apple Health samples were written. Skipped ${skipped} local ${skipped === 1 ? 'sample' : 'samples'} that did not map cleanly.${permissionSuffix}${failureSuffix}`
        : `Apple Health is already up to date with the local export state.${permissionSuffix}${failureSuffix}`;

  return {
    status: 'success',
    message,
    totals: {
      exported,
      skipped,
    },
    metrics,
  };
}

export async function writeLocalMetricsToAppleHealth(
  db: AppleHealthDb,
  options?: AppleHealthExportOptions,
): Promise<AppleHealthExportResult> {
  if (Platform.OS !== 'ios') {
    return emptyExportResult('unavailable', 'Apple Health export is only available on iPhone.');
  }

  if (!isHealthDataAvailable()) {
    return emptyExportResult('unavailable', 'Apple Health is not available on this device.');
  }

  await ensureAppleHealthExportState(db);

  const shouldRequestAuthorization = options?.requestAuthorization ?? true;
  const authorizedTypes = shouldRequestAuthorization
    ? await requestAppleHealthWriteAuthorization()
    : getAuthorizedAppleHealthWriteTypes();
  if (authorizedTypes.size === 0) {
    return emptyExportResult(
      'permission_denied',
      shouldRequestAuthorization
        ? 'Apple Health write permission was not granted for all supported Unstrap metrics.'
        : 'Apple Health write permission has not been granted yet.',
    );
  }

  const deniedTypes = HEALTHKIT_WRITE_TYPES.filter((type) => !authorizedTypes.has(type));
  const failedMetrics: AppleHealthExportMetric[] = [];
  const runMetricExport = async (
    metric: AppleHealthExportMetric,
    task: () => Promise<AppleHealthMetricExportSummary>,
  ) => {
    try {
      return await task();
    } catch (error) {
      failedMetrics.push(metric);
      console.warn(
        '[apple-health] Metric export failed',
        JSON.stringify({
          metric,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return emptyMetricSummary();
    }
  };

  const metrics = {
    sleep: authorizedTypes.has('HKCategoryTypeIdentifierSleepAnalysis')
      ? await runMetricExport('sleep', () => exportSleep(db, options))
      : emptyMetricSummary(),
    heartRate: authorizedTypes.has('HKQuantityTypeIdentifierHeartRate')
      ? await runMetricExport('heartRate', () => exportHeartRate(db, options))
      : emptyMetricSummary(),
    hrvSdnn: authorizedTypes.has('HKQuantityTypeIdentifierHeartRateVariabilitySDNN')
      ? await runMetricExport('hrvSdnn', () => exportHrvSdnn(db, options))
      : emptyMetricSummary(),
    oxygenSaturation: authorizedTypes.has('HKQuantityTypeIdentifierOxygenSaturation')
      ? await runMetricExport('oxygenSaturation', () => exportOxygenSaturation(db, options))
      : emptyMetricSummary(),
    respiratoryRate: authorizedTypes.has('HKQuantityTypeIdentifierRespiratoryRate')
      ? await runMetricExport('respiratoryRate', () => exportRespiratoryRate(db, options))
      : emptyMetricSummary(),
  };

  return buildResult(metrics, deniedTypes, failedMetrics);
}
