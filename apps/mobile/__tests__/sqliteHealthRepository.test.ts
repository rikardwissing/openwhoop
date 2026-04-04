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

function calculateExpectedStressValues(samples: Array<{ bpm: number; rr: number[] }>) {
  const stressWindow = 120;

  return samples.map((_, index) => {
    const start = Math.max(0, index - stressWindow + 1);
    const window = samples.slice(start, index + 1);
    if (window.length < stressWindow) {
      return null;
    }

    const realRrLength = window.reduce(
      (sum, row) => sum + row.rr.filter((value) => value > 0).length,
      0,
    );
    const values = realRrLength >= stressWindow
      ? window.flatMap((row) => row.rr.filter((value) => value > 0))
      : window
          .map((row) => Math.round((60 / row.bpm) * 1000))
          .filter((value) => value > 0);

    if (values.length < stressWindow) {
      return null;
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let modeBin = 0;
    let modeFreq = 0;
    const bins = new Map<number, number>();

    for (const value of values) {
      min = Math.min(min, value);
      max = Math.max(max, value);

      const bin = Math.floor(value / 50);
      const frequency = (bins.get(bin) ?? 0) + 1;
      bins.set(bin, frequency);

      if (frequency > modeFreq) {
        modeBin = bin;
        modeFreq = frequency;
      }
    }

    const variabilityRange = (max - min) / 1000;
    if (variabilityRange < 0.0001) {
      return 10;
    }

    const mode = modeBin * 50 + 25;
    const aMode = modeFreq / values.length * 100;
    return Math.min(10, Math.round((aMode / (2 * variabilityRange * mode / 1000)) * 100) / 100);
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
    expect(run.steps.some((step) => step.key === 'derived.full.rebuild')).toBe(true);
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
        'derived.full.rebuild',
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

  it('batches heart metric writes during a full derived refresh', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertSyntheticHeartSeries(adapter, {
      count: 600,
      start: new Date(2026, 3, 1, 0, 0, 0),
      intervalMinutes: 1,
    });

    adapter.calls.length = 0;
    await refreshDerivedData(adapter as never);

    expect(
      adapter.calls.some((sql) => sql.includes('CREATE TEMP TABLE IF NOT EXISTS heart_metric_updates')),
    ).toBe(true);
    expect(
      adapter.calls.some((sql) => sql.includes('INSERT INTO heart_metric_updates')),
    ).toBe(true);
    expect(
      adapter.calls.some(
        (sql) => sql.includes('UPDATE heart_rate SET stress = ?, spo2 = ?, skin_temp = ? WHERE time = ?'),
      ),
    ).toBe(false);

    adapter.close();
  });

  it('matches legacy stress scoring across bpm fallback and rr-driven windows', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const samples = Array.from({ length: 140 }, (_, index) => {
      if (index < 60) {
        return {
          bpm: 56 + (index % 7),
          rr: [],
        };
      }

      if (index < 120) {
        return {
          bpm: 58 + (index % 9),
          rr: [1020 - (index % 40)],
        };
      }

      return {
        bpm: 60 + (index % 11),
        rr: [
          980 - (index % 25),
          995 - (index % 20),
          1010 - (index % 15),
        ],
      };
    });

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    const gravity = [0.05, -0.01, 0.99];

    await adapter.withExclusiveTransactionAsync(async (tx) => {
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        const sampleDate = new Date(2026, 3, 3, 0, index, 0);
        await tx.runAsync(
          heartInsert,
          index + 1,
          sample.bpm,
          formatTestSqliteDateTime(sampleDate),
          sample.rr.join(','),
          JSON.stringify({
            ppg_green: 15_000 + ((index % 10) * 400),
            spo2_red: 12_000 + index,
            spo2_ir: 14_000 + index,
            skin_contact: 1,
            skin_temp_raw: 830,
            accel_gravity: gravity,
          }),
        );
      }
    });

    await refreshDerivedData(adapter as never);

    const rows = await adapter.getAllAsync<{
      stress: number | null;
    }>(
      `
        SELECT stress
        FROM heart_rate
        ORDER BY time ASC
      `,
    );

    expect(rows.map((row) => row.stress)).toEqual(calculateExpectedStressValues(samples));

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

  it('drops isolated awake spikes from sleep stage summaries while preserving real awake blocks', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await adapter.runAsync(
      `
        INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
        VALUES (1, ?, 0, '2026-04-04 01:00:00')
      `,
      DERIVED_DATA_SCHEMA_VERSION,
    );

    await adapter.runAsync(
      `
        INSERT INTO sleep_cycles (id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, score, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      '2026-04-04',
      '2026-04-04',
      '2026-04-04 00:00:00',
      '2026-04-04 00:49:59',
      54,
      64,
      59,
      40,
      62,
      51,
      88,
    );

    const stageInsert = `
      INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
      VALUES (?, ?, ?, ?, ?)
    `;
    await adapter.runAsync(stageInsert, '2026-04-04', '2026-04-04 00:00:00', '2026-04-04 00:14:59', 'light', 1);
    await adapter.runAsync(stageInsert, '2026-04-04', '2026-04-04 00:15:00', '2026-04-04 00:15:00', 'awake', 1);
    await adapter.runAsync(stageInsert, '2026-04-04', '2026-04-04 00:15:01', '2026-04-04 00:29:59', 'light', 1);
    await adapter.runAsync(stageInsert, '2026-04-04', '2026-04-04 00:30:00', '2026-04-04 00:34:59', 'awake', 1);
    await adapter.runAsync(stageInsert, '2026-04-04', '2026-04-04 00:35:00', '2026-04-04 00:49:59', 'light', 1);

    const repository = new SQLiteHealthRepository(adapter as never);
    const sleepHistory = await repository.getSleepHistory('14d');

    expect(sleepHistory.sessions).toHaveLength(1);
    expect(sleepHistory.sessions[0]?.stages).toEqual([
      { stage: 'light', minutes: 30 },
      { stage: 'awake', minutes: 5 },
      { stage: 'light', minutes: 15 },
    ]);

    adapter.close();
  });

  it('collapses brief summary-stage fragments into surrounding sleep architecture blocks', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await adapter.runAsync(
      `
        INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
        VALUES (1, ?, 0, '2026-04-05 01:00:00')
      `,
      DERIVED_DATA_SCHEMA_VERSION,
    );

    await adapter.runAsync(
      `
        INSERT INTO sleep_cycles (id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, score, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      '2026-04-05',
      '2026-04-05',
      '2026-04-05 00:00:00',
      '2026-04-05 00:29:59',
      54,
      64,
      59,
      40,
      62,
      51,
      88,
    );

    const stageInsert = `
      INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
      VALUES (?, ?, ?, ?, ?)
    `;
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:00:00', '2026-04-05 00:09:59', 'light', 1);
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:10:00', '2026-04-05 00:11:59', 'rem', 1);
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:12:00', '2026-04-05 00:19:59', 'light', 1);
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:20:00', '2026-04-05 00:24:59', 'awake', 1);
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:25:00', '2026-04-05 00:29:59', 'light', 1);

    const repository = new SQLiteHealthRepository(adapter as never);
    const sleepHistory = await repository.getSleepHistory('14d');

    expect(sleepHistory.sessions).toHaveLength(1);
    expect(sleepHistory.sessions[0]?.stages).toEqual([
      { stage: 'light', minutes: 20 },
      { stage: 'awake', minutes: 5 },
      { stage: 'light', minutes: 5 },
    ]);

    adapter.close();
  });

  it('ignores isolated saturated ppg spikes while preserving sustained wake in dense sleep staging', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    const start = new Date(2026, 3, 5, 0, 0, 0);
    const sleepingGravity: [number, number, number] = [0.11, -0.02, 0.98];
    const awakeGravity: [number, number, number] = [-0.52, -0.8, 0.35];
    const spikeSeconds = new Set([15 * 60, 30 * 60, 45 * 60]);

    await adapter.withExclusiveTransactionAsync(async (tx) => {
      for (let second = 0; second < 80 * 60; second += 1) {
        const sampleDate = new Date(start.getTime() + second * 1000);
        const sustainedWake = second >= 60 * 60;
        const ppgGreen = sustainedWake
          ? 26_000 + (second % 7) * 180
          : spikeSeconds.has(second)
            ? 49_750
            : 16_500 + (second % 11) * 120;

        await tx.runAsync(
          heartInsert,
          second + 1,
          sustainedWake ? 62 : 58,
          formatTestSqliteDateTime(sampleDate),
          '1000,990,980',
          JSON.stringify({
            ppg_green: ppgGreen,
            skin_contact: 1,
            signal_quality: 3074,
            accel_gravity: sustainedWake ? awakeGravity : sleepingGravity,
          }),
        );
      }
    });

    await refreshDerivedData(adapter as never);

    const stageRows = await adapter.getAllAsync<{
      stage: string;
      start: string;
      end: string;
    }>(
      `
        SELECT stage, start, end
        FROM sleep_stage_segments
        ORDER BY start ASC
      `,
    );

    expect(stageRows.length).toBeGreaterThan(0);
    expect(stageRows.at(-1)?.stage).toBe('awake');
    expect(stageRows.slice(0, -1).every((row) => row.stage !== 'awake')).toBe(true);

    const repository = new SQLiteHealthRepository(adapter as never);
    const sleepHistory = await repository.getSleepHistory('14d');
    expect(['12:59 AM', '1:00 AM']).toContain(sleepHistory.sessions[0]?.wakeTime);
    expect(sleepHistory.sessions[0]?.timeInBedMinutes).toBeGreaterThan(
      sleepHistory.sessions[0]?.durationMinutes ?? 0,
    );

    adapter.close();
  });

  it('detects deep and rem sleep from realistic overnight ppg ranges instead of collapsing everything into light sleep', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    const start = new Date(2026, 3, 6, 0, 0, 0);
    const sleepingGravity: [number, number, number] = [0.08, -0.03, 0.99];
    const awakeGravityA: [number, number, number] = [-0.51, -0.78, 0.36];
    const awakeGravityB: [number, number, number] = [-0.25, -0.91, 0.29];

    await adapter.withExclusiveTransactionAsync(async (tx) => {
      let id = 1;

      for (let second = 0; second < 300 * 60; second += 5) {
        const sampleDate = new Date(start.getTime() + second * 1000);
        const minute = second / 60;
        const isDeep = minute < 90;
        const isLight = minute >= 90 && minute < 165;
        const isRem = minute >= 165 && minute < 210;
        const isAwake = minute >= 210;
        const ppgGreen = isDeep
          ? 17_500 + (id % 7) * 95
          : isLight
            ? 18_350 + (id % 7) * 85
            : isRem
              ? 19_250 + (id % 7) * 90
              : 26_400 + (id % 5) * 180;
        const bpm = isDeep ? 55 : isLight ? 58 : isRem ? 63 : 69;
        const rrIntervals = isDeep
          ? '1090,960,1110'
          : isLight
            ? '1005,995,1010'
            : isRem
              ? '955,960,950'
              : '870,860,865';
        const gravity = isAwake && id % 6 < 3 ? awakeGravityA : isAwake ? awakeGravityB : sleepingGravity;

        await tx.runAsync(
          heartInsert,
          id,
          bpm,
          formatTestSqliteDateTime(sampleDate),
          rrIntervals,
          JSON.stringify({
            ppg_green: ppgGreen,
            skin_contact: 1,
            signal_quality: 3074,
            accel_gravity: gravity,
          }),
        );
        id += 1;
      }
    });

    await refreshDerivedData(adapter as never);

    const stages = await adapter.getAllAsync<{ stage: string }>(
      `
        SELECT DISTINCT stage
        FROM sleep_stage_segments
        ORDER BY stage ASC
      `,
    );
    const stageSet = new Set(stages.map((row) => row.stage));

    expect(stageSet.has('deep')).toBe(true);
    expect(stageSet.has('rem')).toBe(true);

    const repository = new SQLiteHealthRepository(adapter as never);
    const sleepHistory = await repository.getSleepHistory('14d');

    expect(sleepHistory.sessions[0]?.deepMinutes).toBeGreaterThan(0);
    expect(sleepHistory.sessions[0]?.remMinutes).toBeGreaterThan(0);

    adapter.close();
  });

  it('smooths brief dense rem and deep bridges out of otherwise stable light sleep', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    const start = new Date(2026, 3, 6, 23, 0, 0);
    const sleepingGravity: [number, number, number] = [0.08, -0.03, 0.99];
    const awakeGravity: [number, number, number] = [-0.51, -0.78, 0.36];

    await adapter.withExclusiveTransactionAsync(async (tx) => {
      let id = 1;

      const writeSegment = async (
        durationMinutes: number,
        values: {
          bpm: number;
          rrIntervals: string;
          ppgBase: number;
          ppgStep: number;
          gravity: [number, number, number];
        },
      ) => {
        for (let second = 0; second < durationMinutes * 60; second += 5) {
          const sampleDate = new Date(start.getTime() + (id - 1) * 5000);
          await tx.runAsync(
            heartInsert,
            id,
            values.bpm,
            formatTestSqliteDateTime(sampleDate),
            values.rrIntervals,
            JSON.stringify({
              ppg_green: values.ppgBase + (id % 7) * values.ppgStep,
              skin_contact: 1,
              signal_quality: 3074,
              accel_gravity: values.gravity,
            }),
          );
          id += 1;
        }
      };

      await writeSegment(20, {
        bpm: 58,
        rrIntervals: '1005,995,1010',
        ppgBase: 18_250,
        ppgStep: 30,
        gravity: sleepingGravity,
      });
      await writeSegment(1, {
        bpm: 63,
        rrIntervals: '955,960,950',
        ppgBase: 19_150,
        ppgStep: 35,
        gravity: sleepingGravity,
      });
      await writeSegment(20, {
        bpm: 58,
        rrIntervals: '1005,995,1010',
        ppgBase: 18_260,
        ppgStep: 28,
        gravity: sleepingGravity,
      });
      await writeSegment(1, {
        bpm: 55,
        rrIntervals: '1090,960,1110',
        ppgBase: 17_420,
        ppgStep: 32,
        gravity: sleepingGravity,
      });
      await writeSegment(20, {
        bpm: 58,
        rrIntervals: '1005,995,1010',
        ppgBase: 18_240,
        ppgStep: 26,
        gravity: sleepingGravity,
      });
      await writeSegment(12, {
        bpm: 69,
        rrIntervals: '870,860,865',
        ppgBase: 26_300,
        ppgStep: 90,
        gravity: awakeGravity,
      });
    });

    await refreshDerivedData(adapter as never);

    const stageRows = await adapter.getAllAsync<{
      stage: string;
      start: string;
      end: string;
    }>(
      `
        SELECT stage, start, end
        FROM sleep_stage_segments
        ORDER BY start ASC
      `,
    );

    const shortSleepRuns = stageRows.filter((row) => {
      if (row.stage === 'awake') {
        return false;
      }

      const durationMinutes =
        (new Date(row.end.replace(' ', 'T')).getTime() - new Date(row.start.replace(' ', 'T')).getTime()) /
        60000;
      return durationMinutes < 2;
    });

    expect(shortSleepRuns).toHaveLength(0);
    expect(stageRows.at(-1)?.stage).toBe('awake');

    adapter.close();
  });

  it('keeps a sustained late wake block awake instead of alternating back into rem', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const heartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    const start = new Date(2026, 3, 7, 0, 0, 0);
    const sleepingGravity: [number, number, number] = [0.08, -0.03, 0.99];
    const wakeTransitionA: [number, number, number] = [-0.51, -0.78, 0.36];
    const wakeTransitionB: [number, number, number] = [-0.23, -0.91, 0.32];
    const quietWakeGravity: [number, number, number] = [-0.48, -0.64, 0.59];

    await adapter.withExclusiveTransactionAsync(async (tx) => {
      let id = 1;

      for (let second = 0; second < 240 * 60; second += 5) {
        const sampleDate = new Date(start.getTime() + second * 1000);
        const minute = second / 60;
        const isDeep = minute < 80;
        const isLight = minute >= 80 && minute < 140;
        const isRem = minute >= 140 && minute < 180;
        const wakeTransition = minute >= 180 && minute < 195;
        const quietWake = minute >= 195;
        const ppgGreen = isDeep
          ? 17_600 + (id % 7) * 90
          : isLight
            ? 18_350 + (id % 7) * 80
            : isRem
              ? 18_700 + (id % 7) * 70
              : 26_200 + (id % 5) * 170;
        const bpm = isDeep ? 55 : isLight ? 58 : isRem ? 59 : wakeTransition ? 74 : 68;
        const rrIntervals = isDeep
          ? '1090,960,1110'
          : isLight
            ? '1005,995,1010'
            : isRem
              ? '985,980,975'
              : '905,895,900';
        const gravity = wakeTransition
          ? id % 6 < 3
            ? wakeTransitionA
            : wakeTransitionB
          : quietWake
            ? quietWakeGravity
            : sleepingGravity;

        await tx.runAsync(
          heartInsert,
          id,
          bpm,
          formatTestSqliteDateTime(sampleDate),
          rrIntervals,
          JSON.stringify({
            ppg_green: ppgGreen,
            skin_contact: 1,
            signal_quality: 3074,
            accel_gravity: gravity,
          }),
        );
        id += 1;
      }
    });

    await refreshDerivedData(adapter as never);

    const stageRows = await adapter.getAllAsync<{
      stage: string;
      start: string;
      end: string;
    }>(
      `
        SELECT stage, start, end
        FROM sleep_stage_segments
        ORDER BY start ASC
      `,
    );
    const sustainedWakeIndex = stageRows.findIndex((row) => {
      if (row.stage !== 'awake') {
        return false;
      }

      const durationMinutes =
        (new Date(row.end.replace(' ', 'T')).getTime() - new Date(row.start.replace(' ', 'T')).getTime()) /
        60000;
      return durationMinutes >= 5;
    });

    expect(sustainedWakeIndex).toBeGreaterThanOrEqual(0);
    expect(stageRows.slice(sustainedWakeIndex + 1).some((row) => row.stage === 'rem')).toBe(false);

    const repository = new SQLiteHealthRepository(adapter as never);
    const sleepHistory = await repository.getSleepHistory('14d');
    expect(sleepHistory.sessions[0]?.timeInBedMinutes).toBeGreaterThan(
      sleepHistory.sessions[0]?.durationMinutes ?? 0,
    );

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

  it('ignores implausible max bpm placeholders when reading the intraday heart window', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await adapter.runAsync(
      `
        INSERT INTO heart_rate (id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      5,
      255,
      '2026-03-19 07:05:00',
      '',
      null,
      null,
      null,
      null,
    );
    await adapter.runAsync(
      `
        INSERT INTO heart_rate (id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      6,
      74,
      '2026-03-19 07:10:00',
      '910,920,930',
      null,
      null,
      null,
      '{"ppg_green":18000}',
    );

    const heart = await repository.getHeartHistory('14d');

    expect(heart.maxHr).toBe(74);
    expect(heart.averageHr).toBeLessThan(100);

    adapter.close();
  });

  it('repairs cached dashboard heart cards with implausible max bpm values', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await refreshDashboardSnapshot(adapter as never, 'full');
    const cached = await adapter.getFirstAsync<{ snapshot_json: string }>(
      `
        SELECT snapshot_json
        FROM dashboard_snapshot_cache
        WHERE id = 1
      `,
    );
    const snapshot = JSON.parse(cached?.snapshot_json ?? '{}');
    snapshot.heartCard.maxHr = 255;

    await adapter.runAsync(
      `
        UPDATE dashboard_snapshot_cache
        SET snapshot_json = ?
        WHERE id = 1
      `,
      JSON.stringify(snapshot),
    );

    repository.invalidateCaches('dashboard');
    const repaired = await repository.getDashboardSnapshot();

    expect(repaired.heartCard.maxHr).toBe(74);

    const persisted = await adapter.getFirstAsync<{ snapshot_json: string }>(
      `
        SELECT snapshot_json
        FROM dashboard_snapshot_cache
        WHERE id = 1
      `,
    );
    expect(JSON.parse(persisted?.snapshot_json ?? '{}').heartCard.maxHr).toBe(74);

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

  it('ignores implausible placeholder bpm values when rebuilding resting heart summaries', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertOvernightStillness(adapter, new Date(2026, 3, 3, 23, 0, 0), 0);
    await insertOvernightStillness(adapter, new Date(2026, 3, 4, 23, 0, 0), 1000);

    const invalidHeartInsert = `
      INSERT INTO heart_rate (id, bpm, time, rr_intervals, sensor_data, synced)
      VALUES (?, ?, ?, ?, ?, 0)
    `;
    await adapter.runAsync(invalidHeartInsert, 5001, 0, '2026-04-04 00:29:34', '', null);
    await adapter.runAsync(invalidHeartInsert, 5002, 255, '2026-04-04 00:29:35', '', null);
    await adapter.runAsync(invalidHeartInsert, 5003, 1, '2026-04-05 00:29:34', '', null);
    await adapter.runAsync(invalidHeartInsert, 5004, 254, '2026-04-05 00:29:35', '', null);

    await refreshDerivedData(adapter as never);

    const repository = new SQLiteHealthRepository(adapter as never);
    const heart = await repository.getHeartHistory('14d');

    expect(heart.restingHr).toBe(58);
    expect(heart.weeklyResting.filter((point) => point.value !== null).every((point) => point.value === 58)).toBe(true);

    const sleepCycles = await adapter.getAllAsync<{
      min_bpm: number;
      max_bpm: number;
    }>(
      `
        SELECT min_bpm, max_bpm
        FROM sleep_cycles
        ORDER BY start ASC
      `,
    );
    expect(sleepCycles).toHaveLength(2);
    expect(sleepCycles.every((row) => row.min_bpm === 58 && row.max_bpm === 58)).toBe(true);

    const heartDayStats = await adapter.getAllAsync<{
      day: string;
      min_bpm: number;
      max_bpm: number;
    }>(
      `
        SELECT day, min_bpm, max_bpm
        FROM heart_day_stats
        ORDER BY day ASC
      `,
    );
    expect(heartDayStats.length).toBeGreaterThan(0);
    expect(heartDayStats.every((row) => row.min_bpm === 58 && row.max_bpm === 58)).toBe(true);

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
