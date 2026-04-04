import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DERIVED_DATA_SCHEMA_VERSION, initializeDatabase } from '@/db/schema';
import {
  SQLiteHealthRepository,
  clearDashboardAggregatesForDebug,
  markDerivedRefreshPending,
  primeDashboardSnapshot,
  processPendingDerivedRefresh,
  rebuildAggregateTablesForDebug,
  refreshDashboardSnapshot,
  refreshDerivedData,
  shouldRefreshDerivedData,
} from '@/data/sqlite/SQLiteHealthRepository';
import {
  listRecentPerformanceDiagnosticRuns,
  runFullPerformanceSweep,
} from '@/services/performanceDiagnostics';

type SqlArg = string | number | null;

class NodeSqliteAdapter {
  readonly calls: string[] = [];

  constructor(private readonly db: DatabaseSync) {}

  async getFirstAsync<T>(sql: string, ...args: SqlArg[]) {
    this.calls.push(sql);
    return (this.db.prepare(sql).get(...args) as T | undefined) ?? null;
  }

  async getAllAsync<T>(sql: string, ...args: SqlArg[]) {
    this.calls.push(sql);
    return this.db.prepare(sql).all(...args) as T[];
  }

  async runAsync(sql: string, ...args: SqlArg[]) {
    this.calls.push(sql);
    return this.db.prepare(sql).run(...args);
  }

  async execAsync(sql: string) {
    this.calls.push(sql);
    this.db.exec(sql);
  }

  async withExclusiveTransactionAsync<T>(
    callback: (tx: Pick<NodeSqliteAdapter, 'runAsync' | 'execAsync'>) => Promise<T>,
  ) {
    this.calls.push('BEGIN EXCLUSIVE TRANSACTION');
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const result = await callback({
        runAsync: this.runAsync.bind(this),
        execAsync: this.execAsync.bind(this),
      });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

async function createRepositoryFixture() {
  const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
  await initializeDatabase(adapter as never);

  const heartInsert = `
    INSERT INTO heart_rate (id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data, synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `;
  await adapter.runAsync(
    heartInsert,
    1,
    58,
    '2026-03-18 05:00:00',
    '980,990,1000',
    3,
    98,
    33.2,
    '{"ppg_green":12000}',
  );
  await adapter.runAsync(
    heartInsert,
    2,
    62,
    '2026-03-18 05:05:00',
    '970,980,995',
    4,
    98,
    33.4,
    '{"ppg_green":15000}',
  );
  await adapter.runAsync(
    heartInsert,
    3,
    72,
    '2026-03-19 06:55:00',
    '920,930,940',
    5,
    97,
    33.8,
    '{"ppg_green":21000}',
  );
  await adapter.runAsync(
    heartInsert,
    4,
    76,
    '2026-03-19 07:00:00',
    '900,910,920',
    6,
    97,
    34.1,
    '{"ppg_green":24000}',
  );

  await adapter.runAsync(
    `
      INSERT INTO sleep_cycles (id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, score, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `,
    '2026-03-19',
    '2026-03-19',
    '2026-03-18 23:00:00',
    '2026-03-19 07:00:00',
    56,
    76,
    61,
    42,
    64,
    53,
    92,
  );
  await adapter.runAsync(
    `
      INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
      VALUES (?, ?, ?, ?, ?)
    `,
    '2026-03-19',
    '2026-03-18 23:00:00',
    '2026-03-19 02:00:00',
    'deep',
    1,
  );
  await adapter.runAsync(
    `
      INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
      VALUES (?, ?, ?, ?, ?)
    `,
    '2026-03-19',
    '2026-03-19 02:00:00',
    '2026-03-19 07:00:00',
    'light',
    1,
  );

  await adapter.runAsync(
    `
      INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
      VALUES (1, ?, 4, '2026-03-19 07:05:00')
    `,
    DERIVED_DATA_SCHEMA_VERSION,
  );

  return {
    adapter,
    repository: new SQLiteHealthRepository(adapter as never),
  };
}

function formatTestSqliteDateTime(date: Date) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  const second = `${date.getSeconds()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

async function insertOvernightStillness(
  adapter: NodeSqliteAdapter,
  start: Date,
  idOffset = 0,
) {
  const heartInsert = `
    INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
    VALUES (?, ?, ?, ?, ?, 0)
  `;
  const gravity = [0.11, -0.02, 0.98];

  for (let index = 0; index < 60; index += 1) {
    const sampleDate = new Date(start.getTime() + index * 10 * 60000);
    const sleepEndsAt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 7, 0, 0);
    const skinContact = sampleDate < sleepEndsAt ? 1 : 0;
    await adapter.runAsync(
      heartInsert,
      idOffset + index + 1,
      58,
      formatTestSqliteDateTime(sampleDate),
      '1000,990,980',
      JSON.stringify({
        ppg_green: 15000,
        skin_contact: skinContact,
        skin_temp_raw: 830,
        accel_gravity: gravity,
      }),
    );
  }
}

async function insertSyntheticHeartSeries(
  adapter: NodeSqliteAdapter,
  {
    count,
    start,
    idOffset = 0,
    intervalMinutes = 5,
  }: {
    count: number;
    start: Date;
    idOffset?: number;
    intervalMinutes?: number;
  },
) {
  const heartInsert = `
    INSERT INTO heart_rate (id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data, synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `;
  const gravity = [0.05, -0.01, 0.99];

  await adapter.withExclusiveTransactionAsync(async (tx) => {
    for (let index = 0; index < count; index += 1) {
      const sampleDate = new Date(start.getTime() + index * intervalMinutes * 60000);
      const bpm = 56 + (index % 18);
      const stress = 2 + (index % 6);
      const spo2 = 96 + (index % 3);
      const skinTemp = 33.1 + ((index % 5) * 0.1);

      await tx.runAsync(
        heartInsert,
        idOffset + index + 1,
        bpm,
        formatTestSqliteDateTime(sampleDate),
        `${1020 - (index % 40)},${1005 - (index % 35)},${990 - (index % 30)}`,
        stress,
        spo2,
        Number(skinTemp.toFixed(1)),
        JSON.stringify({
          ppg_green: 14_000 + ((index % 12) * 350),
          skin_contact: 1,
          accel_gravity: gravity,
        }),
      );
    }
  });
}

describe('SQLiteHealthRepository', () => {
  it('skips derived refresh when derived state matches the source history', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await adapter.runAsync(
      `
        INSERT INTO heart_rate (id, bpm, time, rr_intervals, synced)
        VALUES (1, 60, '2026-03-20 06:00:00', '1000,990,980', 0)
      `,
    );
    await adapter.runAsync(
      `
        INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
        VALUES (1, ?, 1, '2026-03-20 06:05:00')
      `,
      DERIVED_DATA_SCHEMA_VERSION,
    );

    await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(false);
    adapter.close();
  });

  it('rebuilds derived data when metadata is missing or stale', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await adapter.runAsync(
      `
        INSERT INTO heart_rate (id, bpm, time, rr_intervals, synced)
        VALUES (1, 60, '2026-03-20 06:00:00', '1000,990,980', 0)
      `,
    );

    await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(true);

    await adapter.runAsync(
      `
        INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
        VALUES (1, 0, 1, '2026-03-20 06:05:00')
      `,
    );
    await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(true);

    await adapter.runAsync(
      `
        UPDATE derived_data_state
        SET derived_schema_version = ?, source_heart_count = 99
        WHERE id = 1
      `,
      DERIVED_DATA_SCHEMA_VERSION,
    );
    await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(true);

    adapter.close();
  });

  it('reuses cached snapshots and only invalidates the affected sleep cache on preference writes', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    const firstHeart = await repository.getHeartHistory('14d');
    expect(firstHeart.restingHr).toBe(56);
    const afterFirstHeart = adapter.calls.length;

    const secondHeart = await repository.getHeartHistory('14d');
    expect(secondHeart.restingHr).toBe(56);
    expect(adapter.calls.length).toBe(afterFirstHeart);

    const firstSleep = await repository.getSleepHistory('14d');
    expect(firstSleep.sleepPlan.targetWakeTime).toBe('7:00 AM');

    await repository.setTargetWakeMinutes(6 * 60 + 30);
    const afterWakeSave = adapter.calls.length;

    const thirdHeart = await repository.getHeartHistory('14d');
    expect(thirdHeart.restingHr).toBe(56);
    expect(adapter.calls.length).toBe(afterWakeSave);

    const secondSleep = await repository.getSleepHistory('14d');
    expect(secondSleep.sleepPlan.targetWakeTime).toBe('6:30 AM');
    expect(adapter.calls.length).toBeGreaterThan(afterWakeSave);

    adapter.close();
  });

  it('waits for repository mutations before querying heart history', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    let releaseMutation!: () => void;
    const pendingMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });

    (repository as unknown as { mutationPromise: Promise<void> | null }).mutationPromise = pendingMutation;

    const baselineCalls = adapter.calls.length;
    const heartPromise = repository.getHeartHistory('14d');

    await Promise.resolve();
    expect(adapter.calls.length).toBe(baselineCalls);

    releaseMutation();

    await expect(heartPromise).resolves.toMatchObject({
      restingHr: 56,
    });
    expect(adapter.calls.length).toBeGreaterThan(baselineCalls);

    adapter.close();
  });

  it('rebuilds aggregate tables without rebuilding the dashboard snapshot cache', async () => {
    const { adapter } = await createRepositoryFixture();

    await clearDashboardAggregatesForDebug(adapter as never);

    await expect(rebuildAggregateTablesForDebug(adapter as never)).resolves.toBe(true);

    const aggregateCounts = await adapter.getFirstAsync<{
      heart_days: number;
      bucket_rows: number;
      has_global: number;
      wellness_days: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*) FROM heart_day_stats) AS heart_days,
          (SELECT COUNT(*) FROM heart_intraday_buckets) AS bucket_rows,
          (SELECT COUNT(*) FROM heart_global_stats) AS has_global,
          (SELECT COUNT(*) FROM wellness_day_stats) AS wellness_days
      `,
    );

    expect(aggregateCounts?.heart_days).toBe(2);
    expect(aggregateCounts?.bucket_rows).toBeGreaterThan(0);
    expect(aggregateCounts?.has_global).toBe(1);
    expect(aggregateCounts?.wellness_days).toBe(2);

    adapter.close();
  });

  it('records a persisted full performance sweep with step history', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    const run = await runFullPerformanceSweep({
      db: adapter as never,
      repository,
      backgroundSyncState: {
        pairedDeviceId: 'strap-1',
        lastRunStartedAt: '2026-03-19 07:10:00',
        lastRunFinishedAt: '2026-03-19 07:11:00',
        lastSuccessAt: '2026-03-19 07:11:00',
        lastSource: 'background',
        lastResult: 'success',
        lastError: null,
        lastImportedReadings: 42,
        notificationPermission: 'granted',
        notificationBaselineAt: '2026-03-18 08:00:00',
      },
    });

    expect(run.runKind).toBe('full_sweep');
    expect(run.id).toBeGreaterThan(0);
    expect(run.steps.some((step) => step.key === 'dashboard.read.cold')).toBe(true);
    expect(run.steps.some((step) => step.key === 'aggregates.rebuild')).toBe(true);
    expect(run.steps.some((step) => step.key === 'dashboard.snapshot.warm')).toBe(true);
    expect(run.steps.some((step) => step.key === 'dashboard.snapshot.cold')).toBe(false);

    const recentRuns = await listRecentPerformanceDiagnosticRuns(adapter as never, 5);
    expect(recentRuns).toHaveLength(1);
    expect(recentRuns[0]?.id).toBe(run.id);
    expect(recentRuns[0]?.lastSyncImportedReadings).toBe(42);
    expect(recentRuns[0]?.steps.map((step) => step.key)).toEqual(
      expect.arrayContaining([
        'dashboard.read.warm',
        'dashboard.read.cold',
        'aggregates.rebuild',
        'dashboard.snapshot.warm',
      ]),
    );

    adapter.close();
  });

  it('does not extend overnight sleep through off-body stillness after waking', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    const start = new Date(2026, 3, 1, 23, 0, 0);
    const gravity = [0.11, -0.02, 0.98];

    for (let index = 0; index < 60; index += 1) {
      const sampleDate = new Date(start.getTime() + index * 10 * 60000);
      const skinContact = sampleDate < new Date(2026, 3, 2, 7, 0, 0) ? 1 : 0;
      await adapter.runAsync(
        heartInsert,
        index + 1,
        58,
        formatTestSqliteDateTime(sampleDate),
        '1000,990,980',
        JSON.stringify({
          ppg_green: 15000,
          skin_contact: skinContact,
          accel_gravity: gravity,
        }),
      );
    }

    await refreshDerivedData(adapter as never);

    const sleeps = await adapter.getAllAsync<{
      start: string;
      end: string;
    }>(
      `
        SELECT start, end
        FROM sleep_cycles
        ORDER BY start ASC
      `,
    );

    expect(sleeps).toEqual([
      {
        start: '2026-04-01 23:00:00',
        end: '2026-04-02 06:50:00',
      },
    ]);

    adapter.close();
  });

  it('trims a sustained trailing awake block and reports time asleep separately from time in bed', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    const start = new Date(2026, 3, 4, 0, 20, 0);
    const gravity = [0.11, -0.02, 0.98];

    for (let index = 0; index < 90; index += 1) {
      const sampleDate = new Date(start.getTime() + index * 5 * 60000);
      const isTrailingWake = sampleDate >= new Date(2026, 3, 4, 4, 30, 0);
      await adapter.runAsync(
        heartInsert,
        index + 1,
        isTrailingWake ? 66 : 58,
        formatTestSqliteDateTime(sampleDate),
        '1000,990,980',
        JSON.stringify({
          ppg_green: isTrailingWake ? 25000 : 15000,
          skin_contact: 1,
          accel_gravity: gravity,
        }),
      );
    }

    await refreshDerivedData(adapter as never);

    const sleeps = await adapter.getAllAsync<{
      start: string;
      end: string;
    }>(
      `
        SELECT start, end
        FROM sleep_cycles
        ORDER BY start ASC
      `,
    );

    expect(sleeps).toEqual([
      {
        start: '2026-04-04 00:20:00',
        end: '2026-04-04 04:30:00',
      },
    ]);

    const stageTail = await adapter.getFirstAsync<{ stage: string }>(
      `
        SELECT stage
        FROM sleep_stage_segments
        ORDER BY end DESC
        LIMIT 1
      `,
    );

    expect(stageTail?.stage).toBe('awake');

    const repository = new SQLiteHealthRepository(adapter as never);
    const sleepHistory = await repository.getSleepHistory('14d');

    expect(sleepHistory.wakeTime).toBe('4:30 AM');
    expect(sleepHistory.durationMinutes).toBe(245);
    expect(sleepHistory.timeInBedMinutes).toBe(445);
    expect(sleepHistory.sessions[0]).toMatchObject({
      wakeTime: '4:30 AM',
      durationMinutes: 245,
      timeInBedMinutes: 445,
    });

    adapter.close();
  });

  it('loads seeded snapshots and refreshes outdated derived data on startup', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btwearable-seed-'));
    const source = path.resolve(process.cwd(), 'assets/databases/btwearable-seed.db');
    const seedCopy = path.join(tempDir, 'btwearable-seed.db');
    fs.copyFileSync(source, seedCopy);

    const adapter = new NodeSqliteAdapter(new DatabaseSync(seedCopy));
    await initializeDatabase(adapter as never);
    await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(true);

    const repository = new SQLiteHealthRepository(adapter as never);
    const [dashboard, sleep, heart, wellness] = await Promise.all([
      repository.getDashboardSnapshot(),
      repository.getSleepHistory('14d'),
      repository.getHeartHistory('14d'),
      repository.getWellnessSnapshot('14d'),
    ]);

    expect(dashboard.summaryStats).toHaveLength(3);
    expect(dashboard.heartCard.series.length).toBeGreaterThan(0);
    expect(sleep.sessions).toHaveLength(0);
    expect(heart.intraday.length).toBeGreaterThan(0);
    expect(wellness.activities).toHaveLength(1);

    adapter.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads larger synthetic snapshots without triggering a derived rebuild', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const rowCount = 15_000;
    const latest = new Date();
    const start = new Date(latest.getTime() - (rowCount - 1) * 5 * 60000);
    await insertSyntheticHeartSeries(adapter, { count: rowCount, start });
    await adapter.runAsync(
      `
        INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
        VALUES (1, ?, ?, ?)
      `,
      DERIVED_DATA_SCHEMA_VERSION,
      rowCount,
      formatTestSqliteDateTime(latest),
    );

    await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(false);

    const repository = new SQLiteHealthRepository(adapter as never);
    const startedAt = Date.now();
    const [dashboard, sleep, heart, wellness] = await Promise.all([
      repository.getDashboardSnapshot(),
      repository.getSleepHistory('14d'),
      repository.getHeartHistory('14d'),
      repository.getWellnessSnapshot('14d'),
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(dashboard.summaryStats).toHaveLength(3);
    expect(sleep.sessions).toHaveLength(0);
    expect(heart.intraday.length).toBeGreaterThan(0);
    expect(wellness.activities).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(5_000);

    adapter.close();
  });

  it('reads the dashboard from cache without rescanning heart history in steady state', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await refreshDashboardSnapshot(adapter as never, 'full');
    expect(
      adapter.calls.some((sql) => sql.includes('SELECT bpm FROM heart_rate ORDER BY time ASC'))
    ).toBe(false);
    expect(
      adapter.calls.some((sql) => sql.includes('SELECT day, min_bpm') && sql.includes('FROM ('))
    ).toBe(false);
    adapter.calls.length = 0;

    const firstDashboard = await repository.getDashboardSnapshot();
    expect(firstDashboard.summaryStats).toHaveLength(3);
    expect(firstDashboard.heartCard.series.length).toBeGreaterThan(0);
    expect(adapter.calls).toEqual([
      expect.stringContaining('FROM dashboard_snapshot_cache'),
    ]);

    adapter.calls.length = 0;
    const secondDashboard = await repository.getDashboardSnapshot();
    expect(secondDashboard.summaryStats).toHaveLength(3);
    expect(adapter.calls).toHaveLength(0);

    adapter.close();
  });

  it('uses lightweight heart sample queries when rebuilding the full dashboard snapshot', async () => {
    const { adapter } = await createRepositoryFixture();

    await refreshDashboardSnapshot(adapter as never, 'full');

    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('SELECT bpm, time') &&
          sql.includes('FROM heart_rate') &&
          (sql.includes('WHERE time >= ? AND time <= ?') ||
            sql.includes('WHERE time >= ? AND time < ?')),
      ),
    ).toBe(true);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('FROM heart_rate') &&
          sql.includes('rr_intervals') &&
          sql.includes('sensor_data') &&
          sql.includes('WHERE time >= ? AND time <= ?'),
      ),
    ).toBe(false);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('FROM heart_rate') &&
          sql.includes('rr_intervals') &&
          sql.includes('sensor_data') &&
          sql.includes('WHERE time >= ? AND time < ?'),
      ),
    ).toBe(false);

    adapter.close();
  });

  it('uses lightweight heart sample queries when loading heart history', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await repository.getHeartHistory('14d');

    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('SELECT bpm, time') &&
          sql.includes('FROM heart_rate') &&
          (sql.includes('WHERE time >= ? AND time <= ?') ||
            sql.includes('WHERE time >= ? AND time < ?')),
      ),
    ).toBe(true);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('FROM heart_rate') &&
          sql.includes('rr_intervals') &&
          sql.includes('sensor_data') &&
          sql.includes('WHERE time >= ? AND time <= ?'),
      ),
    ).toBe(false);

    adapter.close();
  });

  it('uses lightweight heart metric queries when loading wellness history', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await adapter.runAsync(
      `
        INSERT INTO wellness_day_stats (day, stress_count, avg_stress, spo2_count, avg_spo2, skin_temp_count, avg_skin_temp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      '2026-03-18',
      2,
      3.5,
      2,
      98,
      2,
      33.3,
    );
    await adapter.runAsync(
      `
        INSERT INTO wellness_day_stats (day, stress_count, avg_stress, spo2_count, avg_spo2, skin_temp_count, avg_skin_temp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      '2026-03-19',
      2,
      5.5,
      2,
      97,
      2,
      33.95,
    );
    await adapter.runAsync(
      `
        INSERT INTO activities (period_id, start, end, activity, synced)
        VALUES (?, ?, ?, ?, 0)
      `,
      'activity-1',
      '2026-03-19 06:50:00',
      '2026-03-19 07:00:00',
      'Run',
    );

    await repository.getWellnessSnapshot('14d');

    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('SELECT') &&
          sql.includes('avg_stress') &&
          sql.includes('avg_spo2') &&
          sql.includes('avg_skin_temp') &&
          sql.includes('FROM wellness_day_stats'),
      ),
    ).toBe(true);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('FROM heart_intraday_buckets') &&
          sql.includes('WHERE bucket_start >= ? AND bucket_start <= ?'),
      ),
    ).toBe(true);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('AVG(stress) AS avg_stress') &&
          sql.includes('FROM heart_rate') &&
          sql.includes('GROUP BY day'),
      ),
    ).toBe(false);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('SELECT bpm FROM heart_rate ORDER BY time ASC'),
      ),
    ).toBe(false);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('SELECT bpm, time') &&
          sql.includes('FROM heart_rate') &&
          sql.includes('WHERE time >= ? AND time <= ?') &&
          sql.includes('ORDER BY time ASC'),
      ),
    ).toBe(false);
    expect(
      adapter.calls.some(
        (sql) =>
          sql.includes('FROM heart_rate') &&
          sql.includes('rr_intervals') &&
          sql.includes('sensor_data') &&
          sql.includes('WHERE time >= ?'),
      ),
    ).toBe(false);

    adapter.close();
  });

  it('primes the dashboard snapshot cache when derived data is already current', async () => {
    const { adapter } = await createRepositoryFixture();

    await expect(primeDashboardSnapshot(adapter as never)).resolves.toBe(true);

    const cached = await adapter.getFirstAsync<{
      snapshot_kind: string;
      source_heart_count: number;
    }>(
      `
        SELECT snapshot_kind, source_heart_count
        FROM dashboard_snapshot_cache
        WHERE id = 1
      `,
    );

    expect(cached).toEqual({
      snapshot_kind: 'full',
      source_heart_count: 4,
    });

    adapter.close();
  });

  it('fills missing wellness day stats while priming an already cached dashboard snapshot', async () => {
    const { adapter } = await createRepositoryFixture();

    await refreshDashboardSnapshot(adapter as never, 'full');
    await adapter.runAsync('DELETE FROM wellness_day_stats');

    await expect(primeDashboardSnapshot(adapter as never)).resolves.toBe(false);

    const row = await adapter.getFirstAsync<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM wellness_day_stats
      `,
    );

    expect(row?.count).toBeGreaterThan(0);

    adapter.close();
  });

  it('does not block cached dashboard reads when derived refresh is pending', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await refreshDashboardSnapshot(adapter as never, 'full');
    await markDerivedRefreshPending(adapter as never, '2026-03-19 06:55:00', '2026-03-19 07:00:00');
    adapter.calls.length = 0;

    const dashboard = await repository.getDashboardSnapshot();

    expect(dashboard.summaryStats).toHaveLength(3);
    expect(adapter.calls).toEqual([
      expect.stringContaining('FROM dashboard_snapshot_cache'),
    ]);
    expect(adapter.calls.some((sql) => sql.includes('UPDATE heart_rate SET stress'))).toBe(false);
    expect(adapter.calls.some((sql) => sql.includes('BEGIN EXCLUSIVE TRANSACTION'))).toBe(false);

    adapter.close();
  });

  it('updates only heart-visible dashboard fields for post-sync heart refreshes', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await refreshDashboardSnapshot(adapter as never, 'full');
    const before = await repository.getDashboardSnapshot();
    repository.invalidateCaches('dashboard');

    await adapter.runAsync(
      `
        INSERT INTO heart_rate (id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      5,
      110,
      '2026-03-19 08:05:00',
      '780,790,800',
      null,
      null,
      null,
      '{"ppg_green":25000}',
    );

    await refreshDashboardSnapshot(adapter as never, 'post_sync_heart_only');
    repository.invalidateCaches('dashboard');
    const after = await repository.getDashboardSnapshot();

    expect(after.recovery).toEqual(before.recovery);
    expect(after.summaryStats).toEqual(before.summaryStats);
    expect(after.sleepCard).toEqual(before.sleepCard);
    expect(after.strainCard).toEqual(before.strainCard);
    expect(after.heartCard.maxHr).toBeGreaterThan(before.heartCard.maxHr ?? 0);
    expect(after.heartCard.averageHr).toBeGreaterThan(before.heartCard.averageHr ?? 0);
    expect(after.heartCard.series.length).toBeGreaterThanOrEqual(before.heartCard.series.length);

    adapter.close();
  });

  it('preserves missing intraday buckets as null chart points', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, synced)
      VALUES (?, ?, ?, ?, 0)
    `;
    await adapter.runAsync(heartInsert, 1, 70, '2026-03-20 01:00:00', '1000,990,980');
    await adapter.runAsync(heartInsert, 2, 72, '2026-03-20 01:05:00', '1000,990,980');
    await adapter.runAsync(heartInsert, 3, 78, '2026-03-20 04:00:00', '1000,990,980');
    await adapter.runAsync(heartInsert, 4, 80, '2026-03-20 04:05:00', '1000,990,980');
    await adapter.runAsync(
      `
        INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
        VALUES (1, ?, 4, '2026-03-20 04:10:00')
      `,
      DERIVED_DATA_SCHEMA_VERSION,
    );

    const repository = new SQLiteHealthRepository(adapter as never);
    const heart = await repository.getHeartHistory('14d');

    expect(heart.intraday.find((point) => point.label === '1 AM')?.value).toBe(70);
    expect(heart.intraday.find((point) => point.label === '1:10 AM')?.value).toBeNull();
    expect(heart.intraday.find((point) => point.label === '4 AM')?.value).toBe(78);

    adapter.close();
  });

  it('merges overlapping pending derived refresh ranges', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await markDerivedRefreshPending(adapter as never, '2026-04-06 23:10:00', '2026-04-07 06:40:00');
    await markDerivedRefreshPending(adapter as never, '2026-04-06 22:50:00', '2026-04-07 07:00:00');

    const repository = new SQLiteHealthRepository(adapter as never);
    await expect(repository.getDerivedRefreshState()).resolves.toEqual({
      status: 'pending',
      pendingFromTime: '2026-04-06 22:50:00',
      pendingToTime: '2026-04-07 07:00:00',
      lastProcessedFromTime: null,
      lastProcessedToTime: null,
      lastError: null,
      isFirstSync: true,
    });

    adapter.close();
  });

  it('rebuilds only the pending append-only range and preserves older derived rows', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertOvernightStillness(adapter, new Date(2026, 3, 1, 23, 0, 0), 0);
    await refreshDerivedData(adapter as never);

    await insertOvernightStillness(adapter, new Date(2026, 3, 6, 23, 0, 0), 100);
    await markDerivedRefreshPending(adapter as never, '2026-04-06 23:00:00', '2026-04-07 08:50:00');
    await expect(processPendingDerivedRefresh(adapter as never)).resolves.toBe(true);

    const sleeps = await adapter.getAllAsync<{
      start: string;
      end: string;
    }>(
      `
        SELECT start, end
        FROM sleep_cycles
        ORDER BY start ASC
      `,
    );

    expect(sleeps).toEqual([
      {
        start: '2026-04-01 23:00:00',
        end: '2026-04-02 06:50:00',
      },
      {
        start: '2026-04-06 23:00:00',
        end: '2026-04-07 06:50:00',
      },
    ]);

    const derivedState = await adapter.getFirstAsync<{
      rebuild_status: string;
      pending_from_time: string | null;
      pending_to_time: string | null;
      last_processed_from_time: string | null;
      last_processed_to_time: string | null;
    }>(
      `
        SELECT rebuild_status, pending_from_time, pending_to_time, last_processed_from_time, last_processed_to_time
        FROM derived_data_state
        WHERE id = 1
      `,
    );

    expect(derivedState).toEqual({
      rebuild_status: 'idle',
      pending_from_time: null,
      pending_to_time: null,
      last_processed_from_time: '2026-04-06 23:00:00',
      last_processed_to_time: '2026-04-07 08:50:00',
    });

    const heartDayStats = await adapter.getAllAsync<{
      day: string;
      min_bpm: number;
      avg_bpm: number;
      max_bpm: number;
      strain_score: number | null;
    }>(
      `
        SELECT day, min_bpm, avg_bpm, max_bpm, strain_score
        FROM heart_day_stats
        ORDER BY day ASC
      `,
    );
    expect(heartDayStats).toHaveLength(4);
    expect(heartDayStats.every((row) => row.min_bpm > 0 && row.max_bpm >= row.min_bpm)).toBe(true);

    const latestSleep = await adapter.getFirstAsync<{
      avg_skin_temp: number | null;
    }>(
      `
        SELECT avg_skin_temp
        FROM sleep_cycles
        ORDER BY start DESC
        LIMIT 1
      `,
    );
    expect(latestSleep?.avg_skin_temp).toBeCloseTo(33.2, 1);

    adapter.close();
  });

  it('refreshes large histories without spread-based native extrema calls', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertSyntheticHeartSeries(adapter, {
      count: 5_000,
      start: new Date(2026, 0, 1, 0, 0, 0),
      intervalMinutes: 1,
    });

    const originalMin = Math.min;
    const originalMax = Math.max;
    const minSpy = jest.spyOn(Math, 'min').mockImplementation((...values: number[]) => {
      if (values.length > 1_000) {
        throw new Error(`Unexpected Math.min call with ${values.length} arguments`);
      }
      return originalMin(...values);
    });
    const maxSpy = jest.spyOn(Math, 'max').mockImplementation((...values: number[]) => {
      if (values.length > 1_000) {
        throw new Error(`Unexpected Math.max call with ${values.length} arguments`);
      }
      return originalMax(...values);
    });

    try {
      await expect(refreshDerivedData(adapter as never)).resolves.toBeUndefined();
    } finally {
      minSpy.mockRestore();
      maxSpy.mockRestore();
      adapter.close();
    }
  });
});
