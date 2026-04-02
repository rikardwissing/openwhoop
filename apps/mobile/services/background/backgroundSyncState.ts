import type { SQLiteDatabase } from 'expo-sqlite';

import { formatSqliteDateTime, parseSqliteDateTime } from '@/utils/dateTime';
import type { BackgroundSyncResult, BackgroundSyncState, NotificationPermissionState, SyncSource } from '@/types/device';

const BACKGROUND_SYNC_ROW_ID = 1;
const LOCK_STALE_MS = 15 * 60 * 1000;

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
}

type DatabaseLike = Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync' | 'execAsync'> & {
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
};

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
        lock_started_at
      FROM background_sync_state
      WHERE id = 1
      LIMIT 1
    `,
  );
}

async function persistBackgroundSyncStateRow(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
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
    ...patch,
  };

  await db.runAsync(
    `
      INSERT INTO background_sync_state (
        id,
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
        lock_started_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        paired_device_id = excluded.paired_device_id,
        last_run_started_at = excluded.last_run_started_at,
        last_run_finished_at = excluded.last_run_finished_at,
        last_success_at = excluded.last_success_at,
        last_source = excluded.last_source,
        last_result = excluded.last_result,
        last_error = excluded.last_error,
        last_imported_readings = excluded.last_imported_readings,
        notification_permission = excluded.notification_permission,
        notification_baseline_at = excluded.notification_baseline_at,
        lock_owner = excluded.lock_owner,
        lock_started_at = excluded.lock_started_at
    `,
    BACKGROUND_SYNC_ROW_ID,
    next.paired_device_id,
    next.last_run_started_at,
    next.last_run_finished_at,
    next.last_success_at,
    next.last_source,
    next.last_result,
    next.last_error,
    next.last_imported_readings,
    next.notification_permission,
    next.notification_baseline_at,
    next.lock_owner,
    next.lock_started_at,
  );
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
  };
}

export async function setBackgroundSyncPairedDevice(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  deviceId: string | null,
) {
  await persistBackgroundSyncStateRow(db, {
    paired_device_id: deviceId,
  });
}

export async function updateNotificationPermissionState(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  permission: NotificationPermissionState,
  baselineAt: string | null,
) {
  await persistBackgroundSyncStateRow(db, {
    notification_permission: permission,
    notification_baseline_at: baselineAt,
  });
}

export async function recordBackgroundRunStart(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  params: {
    deviceId: string;
    source: SyncSource;
    startedAt: string;
  },
) {
  await persistBackgroundSyncStateRow(db, {
    paired_device_id: params.deviceId,
    last_run_started_at: params.startedAt,
    last_source: params.source,
    last_error: null,
  });
}

export async function recordBackgroundRunResult(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  params: {
    deviceId: string;
    source: SyncSource;
    result: BackgroundSyncResult;
    finishedAt: string;
    importedReadings: number;
    error: string | null;
  },
) {
  const current = await loadBackgroundSyncStateRow(db);
  await persistBackgroundSyncStateRow(db, {
    paired_device_id: params.deviceId,
    last_run_finished_at: params.finishedAt,
    last_success_at: params.result === 'success' ? params.finishedAt : current?.last_success_at ?? null,
    last_source: params.source,
    last_result: params.result,
    last_error: params.error,
    last_imported_readings: params.importedReadings,
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
    const stale =
      row?.lock_owner !== null &&
      row?.lock_owner !== undefined &&
      (!lockStartedAt || now.getTime() - lockStartedAt.getTime() > LOCK_STALE_MS);

    if (row?.lock_owner && row.lock_owner !== owner && !stale) {
      acquired = false;
      return;
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
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
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

export async function clearBackgroundSyncState(db: Pick<SQLiteDatabase, 'execAsync'>) {
  await db.execAsync(`
    DELETE FROM delivered_notifications;
    DELETE FROM background_sync_state;
  `);
}
