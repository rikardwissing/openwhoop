import type { SQLiteDatabase } from 'expo-sqlite';

import {
  clearLocalBackgroundSyncState,
  upsertLocalBackgroundSyncState,
} from '@/data/graphql/localSqliteMutations';
import { formatSqliteDateTime, parseSqliteDateTime } from '@/utils/dateTime';
import type {
  BackgroundSyncResult,
  BackgroundSyncState,
  NotificationPermissionState,
  SyncImportBottleneck,
  SyncImportPerformanceSummary,
  SyncSource,
} from '@/types/device';

const BACKGROUND_SYNC_ROW_ID = 1;
const FOREGROUND_LOCK_STALE_MS = 15 * 60 * 1000;
const BACKGROUND_LOCK_STALE_MS = 6 * 60 * 1000;

interface BackgroundSyncStateRow {
  paired_device_id: string | null;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_success_at: string | null;
  last_source: SyncSource | null;
  last_result: BackgroundSyncResult | null;
  last_error: string | null;
  last_imported_readings: number | null;
  notification_permission: NotificationPermissionState | null;
  notification_baseline_at: string | null;
  lock_owner: string | null;
  lock_started_at: string | null;
  last_sync_import_summary_json: string | null;
}

type DatabaseLike = SQLiteDatabase & {
  withExclusiveTransactionAsync?: (task: (tx: SQLiteDatabase) => Promise<void>) => Promise<void>;
};

const EMPTY_BACKGROUND_SYNC_STATE: BackgroundSyncState = {
  pairedDeviceId: null,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastSuccessAt: null,
  lastSource: null,
  lastResult: null,
  lastError: null,
  lastImportedReadings: null,
  notificationPermission: 'unknown',
  notificationBaselineAt: null,
  lastSyncImportSummary: null,
};

function parseLockOwnerSource(owner: string | null | undefined): SyncSource | null {
  if (!owner) {
    return null;
  }

  if (owner.startsWith('background:')) {
    return 'background';
  }

  if (owner.startsWith('foreground:')) {
    return 'foreground';
  }

  return null;
}

function resolveLockStaleMs(owner: string | null | undefined) {
  return parseLockOwnerSource(owner) === 'background'
    ? BACKGROUND_LOCK_STALE_MS
    : FOREGROUND_LOCK_STALE_MS;
}

function parseNullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseRequiredNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseSyncImportBottleneck(value: unknown): SyncImportBottleneck {
  return value === 'ble' || value === 'db' || value === 'mixed' ? value : 'unknown';
}

function parseSyncImportSummary(value: string | null): SyncImportPerformanceSummary | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SyncImportPerformanceSummary>;
    const source = parsed.source === 'foreground' || parsed.source === 'background' ? parsed.source : null;
    const status =
      parsed.status === 'success' || parsed.status === 'skipped' || parsed.status === 'error'
        ? parsed.status
        : null;
    const capturedAt = typeof parsed.capturedAt === 'string' ? parsed.capturedAt : null;

    if (!source || !status || !capturedAt) {
      return null;
    }

    return {
      source,
      status,
      capturedAt,
      totalMs: parseRequiredNumber(parsed.totalMs),
      connectMs: parseNullableNumber(parsed.connectMs),
      historyRequestToCompleteMs: parseNullableNumber(parsed.historyRequestToCompleteMs),
      historyReceiveMs: parseNullableNumber(parsed.historyReceiveMs),
      dbFlushMsTotal: parseRequiredNumber(parsed.dbFlushMsTotal),
      dbFlushMsAvg: parseNullableNumber(parsed.dbFlushMsAvg),
      dbFlushMsMax: parseRequiredNumber(parsed.dbFlushMsMax),
      ackWaitMsTotal: parseRequiredNumber(parsed.ackWaitMsTotal),
      ackWaitMsAvg: parseNullableNumber(parsed.ackWaitMsAvg),
      ackWaitMsMax: parseRequiredNumber(parsed.ackWaitMsMax),
      importedRows: parseRequiredNumber(parsed.importedRows),
      persistedRows: parseRequiredNumber(parsed.persistedRows),
      flushCount: parseRequiredNumber(parsed.flushCount),
      flushRowsTotal: parseRequiredNumber(parsed.flushRowsTotal),
      historyEndCount: parseRequiredNumber(parsed.historyEndCount),
      ackSentCount: parseRequiredNumber(parsed.ackSentCount),
      maxPendingRows: parseRequiredNumber(parsed.maxPendingRows),
      rowsPerSecReceive: parseNullableNumber(parsed.rowsPerSecReceive),
      rowsPerSecPersist: parseNullableNumber(parsed.rowsPerSecPersist),
      suspectedBottleneck: parseSyncImportBottleneck(parsed.suspectedBottleneck),
      error: typeof parsed.error === 'string' ? parsed.error : null,
    };
  } catch {
    return null;
  }
}

async function withExclusiveTransaction(db: DatabaseLike, task: (tx: SQLiteDatabase) => Promise<void>) {
  if (typeof db.withExclusiveTransactionAsync === 'function') {
    return db.withExclusiveTransactionAsync(task);
  }

  await task(db as SQLiteDatabase);
}

async function loadBackgroundSyncStateRow(db: Pick<SQLiteDatabase, 'getFirstAsync'>) {
  return db.getFirstAsync<BackgroundSyncStateRow>(
    `
      SELECT
        paired_device_id,
        last_run_started_at,
        last_run_finished_at,
        last_success_at,
        last_source,
        last_result,
        last_error,
        last_imported_readings,
        notification_permission,
        notification_baseline_at,
        lock_owner,
        lock_started_at,
        last_sync_import_summary_json
      FROM background_sync_state
      WHERE id = 1
      LIMIT 1
    `,
  );
}

async function persistBackgroundSyncStateRow(
  db: SQLiteDatabase,
  patch: Partial<BackgroundSyncStateRow>,
) {
  const current = await loadBackgroundSyncStateRow(db);
  const next: BackgroundSyncStateRow = {
    paired_device_id: current?.paired_device_id ?? null,
    last_run_started_at: current?.last_run_started_at ?? null,
    last_run_finished_at: current?.last_run_finished_at ?? null,
    last_success_at: current?.last_success_at ?? null,
    last_source: current?.last_source ?? null,
    last_result: current?.last_result ?? null,
    last_error: current?.last_error ?? null,
    last_imported_readings: current?.last_imported_readings ?? null,
    notification_permission: current?.notification_permission ?? 'unknown',
    notification_baseline_at: current?.notification_baseline_at ?? null,
    lock_owner: current?.lock_owner ?? null,
    lock_started_at: current?.lock_started_at ?? null,
    last_sync_import_summary_json: current?.last_sync_import_summary_json ?? null,
    ...patch,
  };

  await upsertLocalBackgroundSyncState(db, {
    id: BACKGROUND_SYNC_ROW_ID,
    paired_device_id: next.paired_device_id,
    last_run_started_at: next.last_run_started_at,
    last_run_finished_at: next.last_run_finished_at,
    last_success_at: next.last_success_at,
    last_source: next.last_source,
    last_result: next.last_result,
    last_error: next.last_error,
    last_imported_readings: next.last_imported_readings,
    notification_permission: next.notification_permission ?? 'unknown',
    notification_baseline_at: next.notification_baseline_at,
    lock_owner: next.lock_owner,
    lock_started_at: next.lock_started_at,
    last_sync_import_summary_json: next.last_sync_import_summary_json,
  });
}

export async function getBackgroundSyncState(db: Pick<SQLiteDatabase, 'getFirstAsync'>): Promise<BackgroundSyncState> {
  const row = await loadBackgroundSyncStateRow(db);

  if (!row) {
    return { ...EMPTY_BACKGROUND_SYNC_STATE };
  }

  return {
    pairedDeviceId: row.paired_device_id,
    lastRunStartedAt: row.last_run_started_at,
    lastRunFinishedAt: row.last_run_finished_at,
    lastSuccessAt: row.last_success_at,
    lastSource: row.last_source,
    lastResult: row.last_result,
    lastError: row.last_error,
    lastImportedReadings: row.last_imported_readings,
    notificationPermission: row.notification_permission ?? 'unknown',
    notificationBaselineAt: row.notification_baseline_at,
    lastSyncImportSummary: parseSyncImportSummary(row.last_sync_import_summary_json),
  };
}

export async function setBackgroundSyncPairedDevice(
  db: SQLiteDatabase,
  deviceId: string | null,
) {
  await persistBackgroundSyncStateRow(db, {
    paired_device_id: deviceId,
  });
}

export async function updateNotificationPermissionState(
  db: SQLiteDatabase,
  permission: NotificationPermissionState,
  baselineAt: string | null,
) {
  await persistBackgroundSyncStateRow(db, {
    notification_permission: permission,
    notification_baseline_at: baselineAt,
  });
}

export async function recordBackgroundRunStart(
  db: SQLiteDatabase,
  params: {
    deviceId?: string | null;
    source: SyncSource;
    startedAt: string;
  },
) {
  const patch: Partial<BackgroundSyncStateRow> = {
    last_run_started_at: params.startedAt,
    last_source: params.source,
    last_result: null,
    last_error: null,
  };

  if (params.deviceId !== undefined && params.deviceId !== null) {
    patch.paired_device_id = params.deviceId;
  }

  await persistBackgroundSyncStateRow(db, patch);
}

export async function recordBackgroundRunResult(
  db: SQLiteDatabase,
  params: {
    deviceId?: string | null;
    source: SyncSource;
    result: BackgroundSyncResult;
    finishedAt: string;
    importedReadings: number;
    error: string | null;
  },
) {
  const patch: Partial<BackgroundSyncStateRow> = {
    last_run_finished_at: params.finishedAt,
    last_source: params.source,
    last_result: params.result,
    last_error: params.error,
    last_imported_readings: params.importedReadings,
  };

  if (params.result === 'success') {
    patch.last_success_at = params.finishedAt;
  }

  if (params.deviceId !== undefined && params.deviceId !== null) {
    patch.paired_device_id = params.deviceId;
  }

  await persistBackgroundSyncStateRow(db, patch);
}

export async function recordSyncImportSummary(
  db: SQLiteDatabase,
  summary: SyncImportPerformanceSummary,
) {
  await persistBackgroundSyncStateRow(db, {
    last_sync_import_summary_json: JSON.stringify(summary),
  });
}

export async function acquireBackgroundSyncLock(
  db: DatabaseLike,
  owner: string,
  now = new Date(),
): Promise<boolean> {
  let acquired = false;
  const startedAt = formatSqliteDateTime(now);

  await withExclusiveTransaction(db, async (tx) => {
    const row = await loadBackgroundSyncStateRow(tx);
    const lockStartedAt = row?.lock_started_at ? parseSqliteDateTime(row.lock_started_at) : null;
    const staleThresholdMs = resolveLockStaleMs(row?.lock_owner);
    const stale =
      row?.lock_owner !== null &&
      row?.lock_owner !== undefined &&
      (!lockStartedAt || now.getTime() - lockStartedAt.getTime() > staleThresholdMs);

    if (row?.lock_owner && row.lock_owner !== owner && !stale) {
      acquired = false;
      return;
    }

    if (row?.lock_owner && row.lock_owner !== owner && stale) {
      console.warn(
        '[background-sync] Reclaiming stale sync lock',
        JSON.stringify({
          previousOwner: row.lock_owner,
          previousStartedAt: row.lock_started_at,
          staleThresholdMs,
          nextOwner: owner,
        }),
      );
    }

    await persistBackgroundSyncStateRow(tx, {
      lock_owner: owner,
      lock_started_at: startedAt,
    });
    acquired = true;
  });

  return acquired;
}

export async function releaseBackgroundSyncLock(
  db: SQLiteDatabase,
  owner: string,
) {
  const row = await loadBackgroundSyncStateRow(db);
  if (!row?.lock_owner || row.lock_owner !== owner) {
    return;
  }

  await persistBackgroundSyncStateRow(db, {
    lock_owner: null,
    lock_started_at: null,
  });
}

export async function clearBackgroundSyncState(db: SQLiteDatabase) {
  await clearLocalBackgroundSyncState(db);
}
