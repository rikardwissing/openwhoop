import {
  acquireBackgroundSyncLock,
  getBackgroundSyncState,
  recordSyncImportSummary,
  releaseBackgroundSyncLock,
  updateNotificationPermissionState,
} from '@/services/background/backgroundSyncState';

interface BackgroundSyncRow {
  paired_device_id: string | null;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_success_at: string | null;
  last_source: 'foreground' | 'background' | null;
  last_result: 'success' | 'skipped' | 'error' | null;
  last_error: string | null;
  last_imported_readings: number | null;
  notification_permission: 'unknown' | 'granted' | 'provisional' | 'denied';
  notification_baseline_at: string | null;
  lock_owner: string | null;
  lock_started_at: string | null;
  last_sync_import_summary_json: string | null;
}

class MockBackgroundSyncDb {
  row: BackgroundSyncRow | null = null;

  async getFirstAsync<T>() {
    return (this.row ? { ...this.row } : null) as T | null;
  }

  async runAsync(_sql: string, ...args: Array<string | number | null>) {
    this.row = {
      paired_device_id: args[1] as string | null,
      last_run_started_at: args[2] as string | null,
      last_run_finished_at: args[3] as string | null,
      last_success_at: args[4] as string | null,
      last_source: args[5] as 'foreground' | 'background' | null,
      last_result: args[6] as 'success' | 'skipped' | 'error' | null,
      last_error: args[7] as string | null,
      last_imported_readings: args[8] as number | null,
      notification_permission: (args[9] as BackgroundSyncRow['notification_permission'] | null) ?? 'unknown',
      notification_baseline_at: args[10] as string | null,
      lock_owner: args[11] as string | null,
      lock_started_at: args[12] as string | null,
      last_sync_import_summary_json: args[13] as string | null,
    };
  }

  async execAsync() {}

  async withExclusiveTransactionAsync(task: (tx: never) => Promise<void>) {
    await task(this as never);
  }
}

describe('background sync state coordination', () => {
  it('returns the default state before any row exists', async () => {
    const db = new MockBackgroundSyncDb();

    await expect(getBackgroundSyncState(db as never)).resolves.toEqual({
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
    });
  });

  it('persists and reloads the latest sync import summary', async () => {
    const db = new MockBackgroundSyncDb();

    await recordSyncImportSummary(db as never, {
      source: 'foreground',
      status: 'success',
      capturedAt: '2026-04-09 11:15:00',
      totalMs: 12_345,
      connectMs: 1_200,
      historyRequestToCompleteMs: 10_800,
      historyReceiveMs: 9_400,
      dbFlushMsTotal: 1_800,
      dbFlushMsAvg: 300,
      dbFlushMsMax: 450,
      ackWaitMsTotal: 120,
      ackWaitMsAvg: 40,
      ackWaitMsMax: 75,
      importedRows: 10_000,
      persistedRows: 9_850,
      flushCount: 6,
      flushRowsTotal: 9_850,
      historyEndCount: 3,
      ackSentCount: 3,
      maxPendingRows: 500,
      rowsPerSecReceive: 1_064,
      rowsPerSecPersist: 5_472,
      suspectedBottleneck: 'ble',
      error: null,
    });

    await expect(getBackgroundSyncState(db as never)).resolves.toMatchObject({
      lastSyncImportSummary: {
        source: 'foreground',
        status: 'success',
        totalMs: 12_345,
        persistedRows: 9_850,
        suspectedBottleneck: 'ble',
      },
    });
  });

  it('prevents overlapping locks and releases them by owner', async () => {
    const db = new MockBackgroundSyncDb();

    await expect(acquireBackgroundSyncLock(db as never, 'foreground:1', new Date('2026-04-02T10:00:00'))).resolves.toBe(true);
    await expect(acquireBackgroundSyncLock(db as never, 'background:2', new Date('2026-04-02T10:01:00'))).resolves.toBe(false);

    await releaseBackgroundSyncLock(db as never, 'foreground:1');

    await expect(acquireBackgroundSyncLock(db as never, 'background:2', new Date('2026-04-02T10:02:00'))).resolves.toBe(true);
  });

  it('recovers stale locks before allowing a new sync owner in', async () => {
    const db = new MockBackgroundSyncDb();

    await updateNotificationPermissionState(
      db as never,
      'granted',
      '2026-04-02 09:00:00',
    );
    db.row = {
      ...(db.row as BackgroundSyncRow),
      lock_owner: 'foreground:1',
      lock_started_at: '2026-04-02 09:00:00',
    };

    await expect(acquireBackgroundSyncLock(db as never, 'background:2', new Date('2026-04-02T09:20:30'))).resolves.toBe(true);
    expect(db.row?.lock_owner).toBe('background:2');
  });
});
