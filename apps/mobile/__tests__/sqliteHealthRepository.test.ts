import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  inspectDatabaseMaintenance,
  inspectRequiredStartupMigration,
  runDatabaseMaintenance,
  runRequiredStartupMigration,
} from '@/db/maintenance';
import { DERIVED_DATA_SCHEMA_VERSION, initializeDatabase } from '@/db/schema';
import {
  SQLiteHealthRepository,
  clearDashboardAggregatesForDebug,
  markDerivedRefreshPending,
  processPendingDerivedRefresh as processPendingDerivedRefreshInternal,
  rebuildAggregateTablesForDebug,
  refreshDerivedData as refreshDerivedDataInternal,
  shouldRefreshDerivedData,
} from '@/data/sqlite/SQLiteHealthRepository';
import { generateSleepStageRecords } from '@/data/sqlite/sleepStages';
import { buildHeartCardDataFromWindow } from '@/utils/heartTimeline';
import {
  listRecentPerformanceDiagnosticRuns,
  runFullPerformanceSweep,
} from '@/services/performanceDiagnostics';

type SqlArg = string | number | null;

interface HeartRateInsertOptions {
  id?: number;
  bpm: number;
  time: string;
  rrIntervals: string;
  stress?: number | null;
  spo2?: number | null;
  skinTemp?: number | null;
  ppgGreen?: number | null;
  spo2Red?: number | null;
  spo2Ir?: number | null;
  skinTempRaw?: number | null;
  signalQuality?: number | null;
  skinContact?: number | null;
  accelGravity?: [number, number, number] | null;
}

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

async function insertHeartRateRow(
  executor: Pick<NodeSqliteAdapter, 'runAsync'>,
  {
    id,
    bpm,
    time,
    rrIntervals,
    stress = null,
    spo2 = null,
    skinTemp = null,
    ppgGreen = null,
    spo2Red = null,
    spo2Ir = null,
    skinTempRaw = null,
    signalQuality = null,
    skinContact = null,
    accelGravity = null,
  }: HeartRateInsertOptions,
) {
  const accelGravityX = accelGravity?.[0] ?? null;
  const accelGravityY = accelGravity?.[1] ?? null;
  const accelGravityZ = accelGravity?.[2] ?? null;

  if (typeof id === 'number') {
    return executor.runAsync(
      `
        INSERT INTO heart_rate (
          id,
          bpm,
          time,
          rr_intervals,
          stress,
          spo2,
          skin_temp,
          ppg_green,
          spo2_red,
          spo2_ir,
          skin_temp_raw,
          signal_quality,
          skin_contact,
          accel_gravity_x,
          accel_gravity_y,
          accel_gravity_z
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      bpm,
      time,
      rrIntervals,
      stress,
      spo2,
      skinTemp,
      ppgGreen,
      spo2Red,
      spo2Ir,
      skinTempRaw,
      signalQuality,
      skinContact,
      accelGravityX,
      accelGravityY,
      accelGravityZ,
    );
  }

  return executor.runAsync(
    `
      INSERT INTO heart_rate (
        bpm,
        time,
        rr_intervals,
        stress,
        spo2,
        skin_temp,
        ppg_green,
        spo2_red,
        spo2_ir,
        skin_temp_raw,
        signal_quality,
        skin_contact,
        accel_gravity_x,
        accel_gravity_y,
        accel_gravity_z
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    bpm,
    time,
    rrIntervals,
    stress,
    spo2,
    skinTemp,
    ppgGreen,
    spo2Red,
    spo2Ir,
    skinTempRaw,
    signalQuality,
    skinContact,
    accelGravityX,
    accelGravityY,
    accelGravityZ,
  );
}

async function createRepositoryFixture() {
  const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
  await initializeDatabase(adapter as never);

  await insertHeartRateRow(adapter, {
    id: 1,
    bpm: 58,
    time: '2026-03-18 05:00:00',
    rrIntervals: '980,990,1000',
    stress: 3,
    spo2: 98,
    skinTemp: 33.2,
    ppgGreen: 12000,
  });
  await insertHeartRateRow(adapter, {
    id: 2,
    bpm: 62,
    time: '2026-03-18 05:05:00',
    rrIntervals: '970,980,995',
    stress: 4,
    spo2: 98,
    skinTemp: 33.4,
    ppgGreen: 15000,
  });
  await insertHeartRateRow(adapter, {
    id: 3,
    bpm: 72,
    time: '2026-03-19 06:55:00',
    rrIntervals: '920,930,940',
    stress: 5,
    spo2: 97,
    skinTemp: 33.8,
    ppgGreen: 21000,
  });
  await insertHeartRateRow(adapter, {
    id: 4,
    bpm: 76,
    time: '2026-03-19 07:00:00',
    rrIntervals: '900,910,920',
    stress: 6,
    spo2: 97,
    skinTemp: 34.1,
    ppgGreen: 24000,
  });

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

  await runRequiredStartupMigration(adapter as never);

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

async function refreshDerivedData(adapter: NodeSqliteAdapter) {
  await runRequiredStartupMigration(adapter as never);
  return refreshDerivedDataInternal(adapter as never);
}

async function processPendingDerivedRefresh(adapter: NodeSqliteAdapter) {
  await runRequiredStartupMigration(adapter as never);
  return processPendingDerivedRefreshInternal(adapter as never);
}

async function insertOvernightStillness(
  adapter: NodeSqliteAdapter,
  start: Date,
  idOffset = 0,
) {
  const gravity: [number, number, number] = [0.11, -0.02, 0.98];

  for (let index = 0; index < 60; index += 1) {
    const sampleDate = new Date(start.getTime() + index * 10 * 60000);
    const sleepEndsAt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 7, 0, 0);
    const skinContact = sampleDate < sleepEndsAt ? 1 : 0;
    await insertHeartRateRow(adapter, {
      id: idOffset + index + 1,
      bpm: 58,
      time: formatTestSqliteDateTime(sampleDate),
      rrIntervals: '1000,990,980',
      ppgGreen: 15000,
      skinContact,
      skinTempRaw: 830,
      accelGravity: gravity,
    });
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
  const gravity: [number, number, number] = [0.05, -0.01, 0.99];

  await adapter.withExclusiveTransactionAsync(async (tx) => {
    for (let index = 0; index < count; index += 1) {
      const sampleDate = new Date(start.getTime() + index * intervalMinutes * 60000);
      const bpm = 56 + (index % 18);
      const stress = 2 + (index % 6);
      const spo2 = 96 + (index % 3);
      const skinTemp = 33.1 + ((index % 5) * 0.1);

      await insertHeartRateRow(tx, {
        id: idOffset + index + 1,
        bpm,
        time: formatTestSqliteDateTime(sampleDate),
        rrIntervals: `${1020 - (index % 40)},${1005 - (index % 35)},${990 - (index % 30)}`,
        stress,
        spo2,
        skinTemp: Number(skinTemp.toFixed(1)),
        ppgGreen: 14_000 + ((index % 12) * 350),
        skinContact: 1,
        accelGravity: gravity,
      });
    }
  });
}

async function insertSingleWorkoutBoutDay(adapter: NodeSqliteAdapter) {
  const start = new Date(2026, 3, 2, 7, 0, 0);
  const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
  const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
  const activityGravityA: [number, number, number] = [0.35, -0.42, 0.84];
  const activityGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

  for (let minute = 0; minute < 12 * 60; minute += 1) {
    const sampleDate = new Date(start.getTime() + minute * 60000);
    const isWorkout = minute >= 180 && minute < 220;
    const gravity = isWorkout
      ? minute % 2 === 0
        ? activityGravityA
        : activityGravityB
      : minute % 2 === 0
        ? restGravityA
        : restGravityB;

    await insertHeartRateRow(adapter, {
      id: minute + 1,
      bpm: isWorkout ? 112 : 66,
      time: formatTestSqliteDateTime(sampleDate),
      rrIntervals: isWorkout ? '620,615,610' : '920,930,925',
      ppgGreen: isWorkout ? 19_900 : 18_000,
      signalQuality: 3074,
      skinContact: 1,
      accelGravity: gravity,
    });
  }

  return {
    overlapStart: new Date(2026, 3, 2, 10, 5, 0),
    overlapEnd: new Date(2026, 3, 2, 10, 35, 0),
  };
}

async function insertSingleBorderlineWalkBoutDay(
  adapter: NodeSqliteAdapter,
  options?: { start?: Date; idOffset?: number },
) {
  const start = options?.start ?? new Date(2026, 3, 7, 7, 0, 0);
  const idOffset = options?.idOffset ?? 0;
  const restGravityA: [number, number, number] = [0.15, -0.02, 0.97];
  const restGravityB: [number, number, number] = [0.162, -0.018, 0.968];
  const walkGravityA: [number, number, number] = [0.35, -0.42, 0.84];
  const walkGravityB: [number, number, number] = [-0.28, -0.81, 0.51];

  for (let minute = 0; minute < 4 * 60; minute += 1) {
    const sampleDate = new Date(start.getTime() + minute * 60000);
    const isWalk = minute >= 95 && minute < 114;
    const gravity = isWalk
      ? minute % 2 === 0
        ? walkGravityA
        : walkGravityB
      : minute % 2 === 0
        ? restGravityA
        : restGravityB;

    await insertHeartRateRow(adapter, {
      id: idOffset + minute + 1,
      bpm: isWalk ? 90 : 65,
      time: formatTestSqliteDateTime(sampleDate),
      rrIntervals: isWalk ? '672,668,664' : '920,930,925',
      ppgGreen: isWalk ? 19_400 : 18_000,
      signalQuality: 3074,
      skinContact: 1,
      accelGravity: gravity,
    });
  }

  return {
    expectedStart: new Date(start.getTime() + 95 * 60000),
    expectedEnd: new Date(start.getTime() + 113 * 60000),
  };
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
  it('reads pragma-backed database size inspection from SQLite row names', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));

    await initializeDatabase(adapter as never);
    await insertHeartRateRow(adapter, {
      bpm: 72,
      time: '2026-04-09 12:46:14',
      rrIntervals: '820,810',
      ppgGreen: 15000,
      spo2: 98,
      skinTemp: 33.6,
    });

    const inspection = await inspectDatabaseMaintenance(adapter as never);

    expect(inspection.pageCount).toBeGreaterThan(0);
    expect(inspection.pageSizeBytes).toBeGreaterThan(0);
    expect(inspection.sizeBytes).toBe(inspection.pageCount * inspection.pageSizeBytes);

    adapter.close();
  });

  it('runs explicit database maintenance to drop imu_data while preserving rows', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));

    await adapter.execAsync(`
      CREATE TABLE heart_rate (
        id INTEGER PRIMARY KEY NOT NULL,
        bpm INTEGER NOT NULL,
        time TEXT NOT NULL UNIQUE,
        rr_intervals TEXT NOT NULL,
        activity INTEGER,
        stress REAL,
        imu_data TEXT,
        synced INTEGER NOT NULL DEFAULT 0,
        sensor_data TEXT,
        spo2 REAL,
        skin_temp REAL
      );

      CREATE INDEX idx_heart_rate_time ON heart_rate(time);

      INSERT INTO heart_rate (id, bpm, time, rr_intervals, activity, stress, imu_data, synced, sensor_data, spo2, skin_temp)
      VALUES (1, 72, '2026-04-09 12:46:14', '820,810', 4, 5.5, '[{"legacy":true}]', 1, '{"ppg_green":15000}', 98, 33.6);
    `);

    await initializeDatabase(adapter as never);
    const maintenance = await runDatabaseMaintenance(adapter as never);

    const columns = await adapter.getAllAsync<{ name: string }>('PRAGMA table_info(heart_rate)');
    const row = await adapter.getFirstAsync<{
      id: number;
      bpm: number;
      time: string;
      rr_intervals: string;
      stress: number | null;
      ppg_green: number | null;
      spo2: number | null;
      skin_temp: number | null;
    }>(
      'SELECT id, bpm, time, rr_intervals, stress, ppg_green, spo2, skin_temp FROM heart_rate WHERE id = 1',
    );
    const indexes = await adapter.getAllAsync<{ name: string }>('PRAGMA index_list(heart_rate)');

    expect(columns.map((column) => column.name)).not.toContain('imu_data');
    expect(columns.map((column) => column.name)).not.toContain('activity');
    expect(columns.map((column) => column.name)).not.toContain('synced');
    expect(columns.map((column) => column.name)).not.toContain('sensor_data');
    expect(row).toEqual({
      id: 1,
      bpm: 72,
      time: '2026-04-09 12:46:14',
      rr_intervals: '820,810',
      stress: 5.5,
      ppg_green: 15000,
      spo2: 98,
      skin_temp: 33.6,
    });
    expect(maintenance.ran).toBe(true);
    expect(maintenance.rewroteHeartRateSchema).toBe(true);
    expect(indexes.map((index) => index.name)).not.toContain('idx_heart_rate_time');

    adapter.close();
  });

  it('backfills explicit heart sensor columns during startup migration and clears sensor_data', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));

    await adapter.execAsync(`
      CREATE TABLE heart_rate (
        id INTEGER PRIMARY KEY NOT NULL,
        bpm INTEGER NOT NULL,
        time TEXT NOT NULL UNIQUE,
        rr_intervals TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        sensor_data TEXT
      );
    `);
    await initializeDatabase(adapter as never);
    await adapter.runAsync(
      `
        INSERT INTO heart_rate (bpm, time, rr_intervals, synced, sensor_data)
        VALUES (?, ?, ?, ?, ?)
      `,
      72,
      '2026-04-09 12:46:14',
      '820,810',
      1,
      '{"ppg_green":15000,"spo2_red":5400,"spo2_ir":7800,"skin_temp_raw":312,"signal_quality":95,"skin_contact":1,"accel_gravity":[0.11,-0.02,0.98]}',
    );

    const inspection = await inspectRequiredStartupMigration(adapter as never);
    expect(inspection.needsMigration).toBe(true);
    expect(inspection.heartRateNeedsRewrite).toBe(true);
    expect(inspection.pendingSensorDataBackfillRows).toBe(1);

    const result = await runRequiredStartupMigration(adapter as never);
    const columns = await adapter.getAllAsync<{ name: string }>('PRAGMA table_info(heart_rate)');
    const row = await adapter.getFirstAsync<{
      ppg_green: number | null;
      spo2_red: number | null;
      spo2_ir: number | null;
      skin_temp_raw: number | null;
      signal_quality: number | null;
      skin_contact: number | null;
      accel_gravity_x: number | null;
      accel_gravity_y: number | null;
      accel_gravity_z: number | null;
    }>(
      `
        SELECT
          ppg_green,
          spo2_red,
          spo2_ir,
          skin_temp_raw,
          signal_quality,
          skin_contact,
          accel_gravity_x,
          accel_gravity_y,
          accel_gravity_z
        FROM heart_rate
        LIMIT 1
      `,
    );

    expect(result).toEqual({
      ran: true,
      rewroteHeartRateSchema: true,
      backfilledSensorDataRows: 1,
    });
    expect(columns.map((column) => column.name)).not.toContain('sensor_data');
    expect(columns.map((column) => column.name)).not.toContain('synced');
    expect(row).toEqual({
      ppg_green: 15000,
      spo2_red: 5400,
      spo2_ir: 7800,
      skin_temp_raw: 312,
      signal_quality: 95,
      skin_contact: 1,
      accel_gravity_x: 0.11,
      accel_gravity_y: -0.02,
      accel_gravity_z: 0.98,
    });

    adapter.close();
  });

  it('reads explicit heart sensor columns when sensor_data is absent', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertHeartRateRow(adapter, {
      bpm: 72,
      time: '2026-04-09 12:46:14',
      rrIntervals: '820,810',
      ppgGreen: 15000,
      spo2Red: 5400,
      spo2Ir: 8120,
      skinTempRaw: 312,
      signalQuality: 95,
      skinContact: 1,
      accelGravity: [0.11, -0.02, 0.98],
    });

    const repository = new SQLiteHealthRepository(adapter as never) as unknown as {
      loadAllHeartRows: () => Promise<Array<{
        sensorData: {
          ppg_green?: number;
          spo2_red?: number;
          spo2_ir?: number;
          skin_temp_raw?: number;
          signal_quality?: number;
          skin_contact?: number;
          accel_gravity?: [number, number, number];
        } | null;
        gravity: [number, number, number] | null;
        ppgGreen: number | null;
        signalQuality: number | null;
        skinContact: number | null;
      }>>;
    };
    const [row] = await repository.loadAllHeartRows();

    expect(row?.ppgGreen).toBe(15000);
    expect(row?.signalQuality).toBe(95);
    expect(row?.skinContact).toBe(1);
    expect(row?.gravity).toEqual([0.11, -0.02, 0.98]);
    expect(row?.sensorData).toMatchObject({
      ppg_green: 15000,
      spo2_red: 5400,
      spo2_ir: 8120,
      skin_temp_raw: 312,
      signal_quality: 95,
      skin_contact: 1,
      accel_gravity: [0.11, -0.02, 0.98],
    });

    adapter.close();
  });

  it('creates manual activities that survive derived refreshes and appear in wellness data', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    const manualId = await repository.createManualActivity(
      'Nap',
      new Date('2026-03-19T12:30:00'),
      new Date('2026-03-19T13:00:00'),
    );

    const beforeRefresh = await repository.getWellnessData('14d');
    expect(beforeRefresh.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: manualId,
          title: 'Nap',
          source: 'manual',
          reviewState: 'confirmed',
        }),
      ]),
    );

    await refreshDerivedData(adapter as never);
    repository.invalidateCaches(['dashboard', 'sleep', 'wellness', 'trends']);

    const storedManualRows = await adapter.getAllAsync<{
      start: string;
      end: string;
      activity: string;
      confidence: number | null;
      source: string;
      review_state: string;
    }>(
      `
        SELECT start, end, activity, confidence, source, review_state
        FROM activities
        WHERE source = 'manual'
        ORDER BY start ASC
      `,
    );

    expect(storedManualRows).toEqual([
      {
        start: '2026-03-19 12:30:00',
        end: '2026-03-19 13:00:00',
        activity: 'Nap',
        confidence: null,
        source: 'manual',
        review_state: 'confirmed',
      },
    ]);

    const afterRefresh = await repository.getWellnessData('14d');
    expect(afterRefresh.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: manualId,
          title: 'Nap',
          confidence: null,
          source: 'manual',
          reviewState: 'confirmed',
        }),
      ]),
    );

    adapter.close();
  });

  it('creates manual sleeps that survive derived refreshes and appear in history heart markers', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    const manualSleepId = await repository.createManualSleep(
      new Date('2026-03-18T04:55:00'),
      new Date('2026-03-18T05:10:00'),
    );

    const beforeRefresh = await repository.getHistoryOverview('2026-03-18');
    expect(beforeRefresh.heartCard.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: manualSleepId,
          kind: 'sleep',
          label: 'Sleep',
        }),
      ]),
    );

    await refreshDerivedData(adapter as never);
    repository.invalidateCaches(['dashboard', 'sleep', 'wellness', 'trends']);

    const storedManualRows = await adapter.getAllAsync<{
      sleep_id: string;
      start: string;
      end: string;
      source: string;
      review_state: string;
    }>(
      `
        SELECT sleep_id, start, end, source, review_state
        FROM sleep_cycles
        WHERE sleep_id = '2026-03-18'
      `,
    );

    expect(storedManualRows).toEqual([
      {
        sleep_id: '2026-03-18',
        start: '2026-03-18 04:55:00',
        end: '2026-03-18 05:10:00',
        source: 'manual',
        review_state: 'confirmed',
      },
    ]);

    const afterRefresh = await repository.getHistoryOverview('2026-03-18');
    expect(afterRefresh.heartCard.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: manualSleepId,
          kind: 'sleep',
          label: 'Sleep',
        }),
      ]),
    );

    adapter.close();
  });

  it('updates detected sleeps into manual sleeps that survive derived refreshes', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await repository.updateSleep(
      'sleep-2026-03-19',
      new Date('2026-03-18T23:05:00'),
      new Date('2026-03-19T06:55:00'),
    );

    const beforeRefresh = await repository.getHistoryOverview('2026-03-19');
    expect(beforeRefresh.heartCard.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sleep-2026-03-19',
          kind: 'sleep',
          label: 'Sleep',
        }),
      ]),
    );

    await refreshDerivedData(adapter as never);
    repository.invalidateCaches(['dashboard', 'sleep', 'wellness', 'trends']);

    const storedRows = await adapter.getAllAsync<{
      start: string;
      end: string;
      source: string;
      review_state: string;
    }>(
      `
        SELECT start, end, source, review_state
        FROM sleep_cycles
        WHERE sleep_id = '2026-03-19'
      `,
    );

    expect(storedRows).toEqual([
      {
        start: '2026-03-18 23:05:00',
        end: '2026-03-19 06:55:00',
        source: 'manual',
        review_state: 'confirmed',
      },
    ]);

    const afterRefresh = await repository.getHistoryOverview('2026-03-19');
    expect(afterRefresh.heartCard.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sleep-2026-03-19',
          kind: 'sleep',
          label: 'Sleep',
        }),
      ]),
    );

    adapter.close();
  });

  it('rescored history sleep sections include unstaged gaps inside the sleep span', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await adapter.runAsync(
      `
        UPDATE sleep_cycles
        SET score = 92
        WHERE sleep_id = '2026-03-19'
      `,
    );
    await adapter.runAsync(
      `
        DELETE FROM sleep_stage_segments
        WHERE sleep_id = '2026-03-19'
      `,
    );

    const stageInsert = `
      INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
      VALUES (?, ?, ?, ?, ?)
    `;
    await adapter.runAsync(stageInsert, '2026-03-19', '2026-03-18 23:00:00', '2026-03-19 02:00:00', 'deep', 1);
    await adapter.runAsync(stageInsert, '2026-03-19', '2026-03-19 02:00:00', '2026-03-19 02:10:00', 'awake', 1);
    await adapter.runAsync(stageInsert, '2026-03-19', '2026-03-19 02:30:00', '2026-03-19 07:00:00', 'light', 1);

    repository.invalidateCaches(['dashboard', 'sleep']);

    const sleepHistory = await repository.getSleepHistory('14d');
    expect(sleepHistory.headlineScore).toBeCloseTo((470 / 480) * 100, 5);
    expect(sleepHistory.sessions[0]?.score).toBeCloseTo((470 / 480) * 100, 5);

    const overview = await repository.getHistoryOverview('2026-03-19');
    expect(overview.sleepCard.score).toBeCloseTo((470 / 480) * 100, 5);
    expect(overview.sleepCard.durationMinutes).toBe(470);
    expect(overview.sleepCard.timeInBedMinutes).toBe(480);
    expect(overview.sleepCard.stages.reduce((sum, stage) => sum + stage.minutes, 0)).toBe(480);

    const sleepMarker = overview.heartCard.markers.find((marker) => marker.id === 'sleep-2026-03-19');
    expect(sleepMarker?.details?.score).toBeCloseTo((470 / 480) * 100, 5);
    expect((sleepMarker?.details?.stages ?? []).reduce((sum, stage) => sum + stage.minutes, 0)).toBe(480);

    adapter.close();
  });

  it('skips redetected sleep artifacts when a sleep was manualized for the same day', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertOvernightStillness(adapter, new Date(2026, 3, 1, 23, 0, 0));
    await refreshDerivedData(adapter as never);

    const detectedSleep = await adapter.getFirstAsync<{ sleep_id: string }>(
      `
        SELECT sleep_id
        FROM sleep_cycles
        ORDER BY start ASC
        LIMIT 1
      `,
    );

    expect(detectedSleep?.sleep_id).toBe('2026-04-02');

    const repository = new SQLiteHealthRepository(adapter as never);
    await repository.updateSleep(
      'sleep-2026-04-02',
      new Date('2026-04-01T23:10:00'),
      new Date('2026-04-02T06:55:00'),
    );

    await expect(refreshDerivedData(adapter as never)).resolves.toBeUndefined();

    await markDerivedRefreshPending(adapter as never, '2026-04-01 23:00:00', '2026-04-02 07:00:00');
    await expect(processPendingDerivedRefresh(adapter as never)).resolves.toBe(true);

    const storedRows = await adapter.getAllAsync<{
      start: string;
      end: string;
      source: string;
      review_state: string;
    }>(
      `
        SELECT start, end, source, review_state
        FROM sleep_cycles
        WHERE sleep_id = '2026-04-02'
      `,
    );

    expect(storedRows).toEqual([
      {
        start: '2026-04-01 23:10:00',
        end: '2026-04-02 06:55:00',
        source: 'manual',
        review_state: 'confirmed',
      },
    ]);

    const stageCount = await adapter.getFirstAsync<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM sleep_stage_segments
        WHERE sleep_id = '2026-04-02'
      `,
    );
    expect(stageCount?.count ?? 0).toBeGreaterThan(0);

    repository.invalidateCaches(['dashboard', 'sleep', 'wellness', 'trends']);
    const overview = await repository.getHistoryOverview('2026-04-02');
    expect(overview.heartCard.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sleep-2026-04-02',
          kind: 'sleep',
          label: 'Sleep',
        }),
      ]),
    );

    adapter.close();
  });

  it('confirms and relabels detected activities while preserving them across derived refreshes', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await adapter.runAsync(
      `
        INSERT INTO activities (period_id, start, end, activity, synced, confidence, source, review_state)
        VALUES (?, ?, ?, ?, 0, ?, 'detected', 'none')
      `,
      'activity-1',
      '2026-03-19 06:50:00',
      '2026-03-19 07:00:00',
      'Activity',
      0.72,
    );

    await repository.confirmActivity('activity-1');
    await repository.relabelActivity('activity-1', 'Workout');

    const beforeRefresh = await repository.getWellnessData('14d');
    expect(beforeRefresh.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'activity-1',
          title: 'Workout',
          confidence: 0.72,
          source: 'detected',
          reviewState: 'relabelled',
        }),
      ]),
    );

    await refreshDerivedData(adapter as never);
    repository.invalidateCaches(['dashboard', 'sleep', 'wellness', 'trends']);

    const storedRows = await adapter.getAllAsync<{
      activity: string;
      confidence: number | null;
      source: string;
      review_state: string;
    }>(
      `
        SELECT activity, confidence, source, review_state
        FROM activities
        WHERE id = 1
      `,
    );

    expect(storedRows).toEqual([
      {
        activity: 'Workout',
        confidence: 0.72,
        source: 'detected',
        review_state: 'relabelled',
      },
    ]);

    const afterRefresh = await repository.getWellnessData('14d');
    expect(afterRefresh.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'activity-1',
          title: 'Workout',
          confidence: 0.72,
          source: 'detected',
          reviewState: 'relabelled',
        }),
      ]),
    );

    adapter.close();
  });

  it('dismisses activities so they stay hidden from wellness data across derived refreshes', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await adapter.runAsync(
      `
        INSERT INTO activities (period_id, start, end, activity, synced, source, review_state)
        VALUES (?, ?, ?, ?, 0, 'detected', 'none')
      `,
      'activity-1',
      '2026-03-19 06:50:00',
      '2026-03-19 07:00:00',
      'Activity',
    );

    await repository.dismissActivity('activity-1');

    const beforeRefresh = await repository.getWellnessData('14d');
    expect(beforeRefresh.activities.some((activity) => activity.id === 'activity-1')).toBe(false);

    await refreshDerivedData(adapter as never);
    repository.invalidateCaches(['dashboard', 'sleep', 'wellness', 'trends']);

    const storedRows = await adapter.getAllAsync<{
      review_state: string;
    }>(
      `
        SELECT review_state
        FROM activities
        WHERE id = 1
      `,
    );

    expect(storedRows).toEqual([
      {
        review_state: 'dismissed',
      },
    ]);

    const afterRefresh = await repository.getWellnessData('14d');
    expect(afterRefresh.activities.some((activity) => activity.id === 'activity-1')).toBe(false);

    adapter.close();
  });

  it('rescans activities after clearing unconfirmed detected rows first', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);
    await insertSingleWorkoutBoutDay(adapter);
    await refreshDerivedData(adapter as never);

    const repository = new SQLiteHealthRepository(adapter as never);
    const beforeRescan = await adapter.getAllAsync<{
      source: string;
      review_state: string;
    }>(
      `
        SELECT source, review_state
        FROM activities
        ORDER BY start ASC
      `,
    );

    const result = await repository.rescanActivities();

    const afterRescan = await adapter.getAllAsync<{
      source: string;
      review_state: string;
    }>(
      `
        SELECT source, review_state
        FROM activities
        ORDER BY start ASC
      `,
    );

    expect(beforeRescan).toHaveLength(1);
    expect(beforeRescan[0]).toEqual({
      source: 'detected',
      review_state: 'none',
    });
    expect(result).toEqual({
      removedUnconfirmedActivities: 1,
    });
    expect(afterRescan).toHaveLength(1);
    expect(afterRescan[0]).toEqual({
      source: 'detected',
      review_state: 'none',
    });

    adapter.close();
  });

  it('suppresses freshly detected activities when a reviewed overlap already exists', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const repository = new SQLiteHealthRepository(adapter as never);
    const { overlapStart, overlapEnd } = await insertSingleWorkoutBoutDay(adapter);

    await repository.createManualActivity('Workout', overlapStart, overlapEnd);
    await refreshDerivedData(adapter as never);

    const activities = await adapter.getAllAsync<{
      start: string;
      end: string;
      activity: string;
      source: string;
      review_state: string;
    }>(
      `
        SELECT start, end, activity, source, review_state
        FROM activities
        ORDER BY start ASC
      `,
    );

    expect(activities).toEqual([
      {
        start: '2026-04-02 10:05:00',
        end: '2026-04-02 10:35:00',
        activity: 'Workout',
        source: 'manual',
        review_state: 'confirmed',
      },
    ]);

    adapter.close();
  });

  it('suppresses freshly detected activities when a dismissed overlap already exists', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const repository = new SQLiteHealthRepository(adapter as never);
    const { overlapStart, overlapEnd } = await insertSingleWorkoutBoutDay(adapter);

    await adapter.runAsync(
      `
        INSERT INTO activities (period_id, start, end, activity, synced, confidence, source, review_state)
        VALUES (?, ?, ?, ?, 0, ?, 'detected', 'none')
      `,
      'dismissed-seed',
      formatTestSqliteDateTime(overlapStart),
      formatTestSqliteDateTime(overlapEnd),
      'Workout',
      0.2,
    );
    await repository.dismissActivity('activity-1');
    await refreshDerivedData(adapter as never);

    const activities = await adapter.getAllAsync<{
      start: string;
      end: string;
      activity: string;
      source: string;
      review_state: string;
    }>(
      `
        SELECT start, end, activity, source, review_state
        FROM activities
        ORDER BY start ASC
      `,
    );

    expect(activities).toEqual([
      {
        start: '2026-04-02 10:05:00',
        end: '2026-04-02 10:35:00',
        activity: 'Workout',
        source: 'detected',
        review_state: 'dismissed',
      },
    ]);

    adapter.close();
  });

  it('personalizes walk retention thresholds by daypart from confirmed activity history', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    for (let index = 0; index < 5; index += 1) {
      const start = new Date(2026, 3, 1 + index, 8, 0, 0);
      const end = new Date(start.getTime() + 18 * 60_000);

      await adapter.runAsync(
        `
          INSERT INTO activities (period_id, start, end, activity, synced, source, review_state)
          VALUES (?, ?, ?, ?, 0, 'manual', 'confirmed')
        `,
        `manual-walk-${index}`,
        formatTestSqliteDateTime(start),
        formatTestSqliteDateTime(end),
        'Walk',
      );
    }

    const morningWalk = await insertSingleBorderlineWalkBoutDay(adapter, {
      start: new Date(2026, 3, 7, 7, 0, 0),
      idOffset: 2000,
    });
    const eveningWalk = await insertSingleBorderlineWalkBoutDay(adapter, {
      start: new Date(2026, 3, 7, 17, 0, 0),
      idOffset: 4000,
    });

    await refreshDerivedData(adapter as never);

    const personalizationRows = await adapter.getAllAsync<{
      activity_kind: string;
      daypart: string;
      positive_count: number;
      negative_count: number;
      min_duration_minutes: number;
      min_confidence: number;
    }>(
      `
        SELECT activity_kind, daypart, positive_count, negative_count, min_duration_minutes, min_confidence
        FROM activity_personalization
        WHERE activity_kind = 'Walk' AND daypart IN ('all', 'morning', 'evening')
        ORDER BY daypart ASC
      `,
    );
    const detectedRows = await adapter.getAllAsync<{
      start: string;
      end: string;
      activity: string;
      source: string;
      review_state: string;
    }>(
      `
        SELECT start, end, activity, source, review_state
        FROM activities
        WHERE source = 'detected'
        ORDER BY start ASC
      `,
    );

    expect(personalizationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activity_kind: 'Walk',
          daypart: 'all',
          positive_count: 5,
          negative_count: 0,
          min_duration_minutes: 18,
          min_confidence: 0.7,
        }),
        expect.objectContaining({
          activity_kind: 'Walk',
          daypart: 'morning',
          positive_count: 5,
          negative_count: 0,
          min_duration_minutes: 18,
          min_confidence: 0.7,
        }),
        expect.objectContaining({
          activity_kind: 'Walk',
          daypart: 'evening',
          positive_count: 0,
          negative_count: 0,
          min_duration_minutes: 20,
          min_confidence: 0.75,
        }),
      ]),
    );
    expect(detectedRows).toHaveLength(1);
    expect(detectedRows[0]).toMatchObject({
      start: formatTestSqliteDateTime(morningWalk.expectedStart),
      activity: 'Walk',
      source: 'detected',
      review_state: 'none',
    });
    expect(new Date(detectedRows[0]!.end.replace(' ', 'T')).getTime()).toBeGreaterThanOrEqual(morningWalk.expectedEnd.getTime());
    expect(detectedRows[0]?.start).not.toBe(formatTestSqliteDateTime(eveningWalk.expectedStart));

    adapter.close();
  });

  it('skips derived refresh when derived state matches the source history', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertHeartRateRow(adapter, {
      id: 1,
      bpm: 60,
      time: '2026-03-20 06:00:00',
      rrIntervals: '1000,990,980',
    });
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

    await insertHeartRateRow(adapter, {
      id: 1,
      bpm: 60,
      time: '2026-03-20 06:00:00',
      rrIntervals: '1000,990,980',
    });

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

  it('rebuilds aggregate tables without touching the removed legacy overview cache', async () => {
    const { adapter } = await createRepositoryFixture();

    await clearDashboardAggregatesForDebug(adapter as never);

    await expect(rebuildAggregateTablesForDebug(adapter as never)).resolves.toBe(true);

    const aggregateCounts = await adapter.getFirstAsync<{
      heart_days: number;
      generic_bucket_rows: number;
      heart_bucket_detail_rows: number;
      has_global: number;
      wellness_days: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*) FROM heart_day_stats) AS heart_days,
          (SELECT COUNT(*) FROM intraday_metric_buckets WHERE metric_key = 'heart_bpm' AND bucket_seconds = 300) AS generic_bucket_rows,
          (SELECT COUNT(*) FROM heart_intraday_bucket_details WHERE bucket_seconds = 300) AS heart_bucket_detail_rows,
          (SELECT COUNT(*) FROM heart_global_stats) AS has_global,
          (SELECT COUNT(*) FROM wellness_day_stats) AS wellness_days
      `,
    );

    expect(aggregateCounts?.heart_days).toBe(2);
    expect(aggregateCounts?.generic_bucket_rows).toBeGreaterThan(0);
    expect(aggregateCounts?.heart_bucket_detail_rows).toBe(aggregateCounts?.generic_bucket_rows);
    expect(aggregateCounts?.has_global).toBe(1);
    expect(aggregateCounts?.wellness_days).toBe(2);

    adapter.close();
  });

  it('records a persisted full performance sweep with step history', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    const run = await runFullPerformanceSweep({
      db: adapter as never,
      repository,
    });

    expect(run.runKind).toBe('full_sweep');
    expect(run.id).toBeGreaterThan(0);
    expect(run.steps.some((step) => step.key === 'derived.full.rebuild')).toBe(true);
    expect(run.steps.some((step) => step.key === 'today.read.cold')).toBe(true);
    expect(run.steps.some((step) => step.key === 'history.read.cold')).toBe(true);
    expect(run.steps.some((step) => step.key === 'aggregates.rebuild')).toBe(true);
    expect(run.steps.some((step) => step.key === 'dashboard.snapshot.warm')).toBe(false);

    const recentRuns = await listRecentPerformanceDiagnosticRuns(adapter as never, 5);
    expect(recentRuns).toHaveLength(1);
    expect(recentRuns[0]?.id).toBe(run.id);
    expect(recentRuns[0]?.lastSyncImportedReadings).toBeNull();
    expect(recentRuns[0]?.steps.map((step) => step.key)).toEqual(
      expect.arrayContaining([
        'derived.full.rebuild',
        'today.read.warm',
        'today.read.cold',
        'history.read.warm',
        'history.read.cold',
        'aggregates.rebuild',
      ]),
    );

    adapter.close();
  });

  it('does not extend overnight sleep through off-body stillness after waking', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const start = new Date(2026, 3, 1, 23, 0, 0);
    const gravity: [number, number, number] = [0.11, -0.02, 0.98];

    for (let index = 0; index < 60; index += 1) {
      const sampleDate = new Date(start.getTime() + index * 10 * 60000);
      const skinContact = sampleDate < new Date(2026, 3, 2, 7, 0, 0) ? 1 : 0;
      await insertHeartRateRow(adapter, {
        id: index + 1,
        bpm: 58,
        time: formatTestSqliteDateTime(sampleDate),
        rrIntervals: '1000,990,980',
        ppgGreen: 15000,
        skinContact: skinContact,
        accelGravity: gravity,
      });
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

  it('does not turn an entire waking day into a single generic activity when only one short movement bout exists', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertSingleWorkoutBoutDay(adapter);

    await refreshDerivedData(adapter as never);

    const activities = await adapter.getAllAsync<{
      start: string;
      end: string;
      activity: string;
      confidence: number | null;
      source: string;
      review_state: string;
    }>(
      `
        SELECT start, end, activity, confidence, source, review_state
        FROM activities
        ORDER BY start ASC
      `,
    );

    expect(activities).toHaveLength(1);
    expect(['Activity', 'Walk', 'Workout']).toContain(activities[0]?.activity);
    expect(activities[0]?.confidence).toBeGreaterThan(0);
    expect(activities[0]?.confidence).toBeLessThanOrEqual(1);
    expect(activities[0]?.source).toBe('detected');
    expect(activities[0]?.review_state).toBe('none');

    const durationMinutes =
      (new Date(activities[0]!.end.replace(' ', 'T')).getTime() - new Date(activities[0]!.start.replace(' ', 'T')).getTime()) /
      60000;
    expect(durationMinutes).toBeGreaterThanOrEqual(30);
    expect(durationMinutes).toBeLessThan(120);

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

    const gravity: [number, number, number] = [0.05, -0.01, 0.99];

    await adapter.withExclusiveTransactionAsync(async (tx) => {
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        const sampleDate = new Date(2026, 3, 3, 0, index, 0);
        await insertHeartRateRow(tx, {
          id: index + 1,
          bpm: sample.bpm,
          time: formatTestSqliteDateTime(sampleDate),
          rrIntervals: sample.rr.join(','),
          ppgGreen: 15_000 + ((index % 10) * 400),
          spo2Red: 12_000 + index,
          spo2Ir: 14_000 + index,
          skinTempRaw: 830,
          skinContact: 1,
          accelGravity: gravity,
        });
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

    const start = new Date(2026, 3, 4, 0, 20, 0);
    const gravity: [number, number, number] = [0.11, -0.02, 0.98];

    for (let index = 0; index < 90; index += 1) {
      const sampleDate = new Date(start.getTime() + index * 5 * 60000);
      const isTrailingWake = sampleDate >= new Date(2026, 3, 4, 4, 30, 0);
      await insertHeartRateRow(adapter, {
        id: index + 1,
        bpm: isTrailingWake ? 66 : 58,
        time: formatTestSqliteDateTime(sampleDate),
        rrIntervals: '1000,990,980',
        ppgGreen: isTrailingWake ? 25000 : 15000,
        skinContact: 1,
        accelGravity: gravity,
      });
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
    expect(sleepHistory.durationMinutes).toBe(250);
    expect(sleepHistory.timeInBedMinutes).toBe(445);
    expect(sleepHistory.sessions[0]).toMatchObject({
      wakeTime: '4:30 AM',
      durationMinutes: 250,
      timeInBedMinutes: 445,
    });
    expect(sleepHistory.sessions[0]?.efficiency).toBeCloseTo((250 / 445) * 100, 5);

    adapter.close();
  });

  it('counts unstaged gaps inside the sleep span toward time asleep and time in bed', async () => {
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
      '2026-04-05 01:00:00',
      54,
      64,
      58,
      40,
      56,
      48,
      86,
    );

    const stageInsert = `
      INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
      VALUES (?, ?, ?, ?, ?)
    `;
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:00:00', '2026-04-05 00:20:00', 'light', 1);
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:20:00', '2026-04-05 00:30:00', 'awake', 1);
    await adapter.runAsync(stageInsert, '2026-04-05', '2026-04-05 00:40:00', '2026-04-05 01:00:00', 'deep', 1);

    const repository = new SQLiteHealthRepository(adapter as never);
    const sleepHistory = await repository.getSleepHistory('14d');

    expect(sleepHistory.durationMinutes).toBe(50);
    expect(sleepHistory.timeInBedMinutes).toBe(60);
    expect(sleepHistory.headlineScore).toBeCloseTo((50 / 480) * 100, 5);
    expect(sleepHistory.sessions[0]).toMatchObject({
      wakeTime: '1:00 AM',
      durationMinutes: 50,
      timeInBedMinutes: 60,
    });
    expect(sleepHistory.sessions[0]?.score).toBeCloseTo((50 / 480) * 100, 5);
    expect(sleepHistory.sessions[0]?.efficiency).toBeCloseTo((50 / 60) * 100, 5);
    expect((sleepHistory.sessions[0]?.stages ?? []).reduce((sum, stage) => sum + stage.minutes, 0)).toBe(60);

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

        await insertHeartRateRow(tx, {
          id: second + 1,
          bpm: sustainedWake ? 62 : 58,
          time: formatTestSqliteDateTime(sampleDate),
          rrIntervals: '1000,990,980',
          ppgGreen,
          signalQuality: 3074,
          skinContact: 1,
          accelGravity: sustainedWake ? awakeGravity : sleepingGravity,
        });
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
    expect(['12:58 AM', '12:59 AM', '1:00 AM']).toContain(sleepHistory.sessions[0]?.wakeTime);
    expect(sleepHistory.sessions[0]?.timeInBedMinutes).toBeGreaterThan(
      sleepHistory.sessions[0]?.durationMinutes ?? 0,
    );

    adapter.close();
  });

  it('detects deep and rem sleep from realistic overnight ppg ranges instead of collapsing everything into light sleep', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

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

        await insertHeartRateRow(tx, {
          id,
          bpm,
          time: formatTestSqliteDateTime(sampleDate),
          rrIntervals,
          ppgGreen,
          signalQuality: 3074,
          skinContact: 1,
          accelGravity: gravity,
        });
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
          await insertHeartRateRow(tx, {
            id,
            bpm: values.bpm,
            time: formatTestSqliteDateTime(sampleDate),
            rrIntervals: values.rrIntervals,
            ppgGreen: values.ppgBase + (id % 7) * values.ppgStep,
            signalQuality: 3074,
            skinContact: 1,
            accelGravity: values.gravity,
          });
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

    expect(shortSleepRuns).toHaveLength(1);
    expect(shortSleepRuns[0]).toMatchObject({
      stage: 'deep',
      start: '2026-04-06 23:58:15',
      end: '2026-04-07 00:00:10',
    });
    expect(stageRows.at(-1)?.stage).toBe('awake');

    adapter.close();
  });

  it('collapses repeated late wake bursts and short sleep bridges into a single wake transition cluster', () => {
    const start = new Date(2026, 3, 9, 0, 0, 0);
    const sleepingGravity: [number, number, number] = [0.08, -0.03, 0.99];
    const wakeGravityA: [number, number, number] = [-0.51, -0.78, 0.36];
    const wakeGravityB: [number, number, number] = [-0.23, -0.91, 0.32];
    const rows: Array<{
      date: Date;
      bpm: number;
      rr: number[];
      ppgGreen: number | null;
      gravity: [number, number, number] | null;
      skinContact: number | null;
      signalQuality: number | null;
    }> = [];

    const pushSegment = (
      durationMinutes: number,
      values: {
        bpm: number;
        rr: number[];
        ppgBase: number;
        ppgStep: number;
        gravity: [number, number, number];
        skinContact: number;
      },
    ) => {
      const sampleCount = durationMinutes * 12;
      for (let index = 0; index < sampleCount; index += 1) {
        rows.push({
          date: new Date(start.getTime() + rows.length * 5000),
          bpm: values.bpm,
          rr: values.rr,
          ppgGreen: values.ppgBase + ((rows.length % 7) * values.ppgStep),
          gravity: index % 2 === 0 ? values.gravity : values.gravity,
          skinContact: values.skinContact,
          signalQuality: 3074,
        });
      }
    };

    pushSegment(70, {
      bpm: 60,
      rr: [985, 980, 975],
      ppgBase: 19_050,
      ppgStep: 45,
      gravity: sleepingGravity,
      skinContact: 1,
    });
    pushSegment(1.5, {
      bpm: 78,
      rr: [905, 895, 900],
      ppgBase: 19_250,
      ppgStep: 55,
      gravity: wakeGravityA,
      skinContact: 0,
    });
    pushSegment(1, {
      bpm: 66,
      rr: [980, 975, 970],
      ppgBase: 18_250,
      ppgStep: 30,
      gravity: sleepingGravity,
      skinContact: 1,
    });
    pushSegment(2.5, {
      bpm: 68,
      rr: [970, 965, 960],
      ppgBase: 19_000,
      ppgStep: 35,
      gravity: sleepingGravity,
      skinContact: 1,
    });
    pushSegment(2, {
      bpm: 64,
      rr: [995, 990, 985],
      ppgBase: 18_200,
      ppgStep: 28,
      gravity: sleepingGravity,
      skinContact: 1,
    });
    pushSegment(0.5, {
      bpm: 74,
      rr: [910, 900, 905],
      ppgBase: 19_100,
      ppgStep: 40,
      gravity: wakeGravityB,
      skinContact: 0,
    });
    pushSegment(0.5, {
      bpm: 67,
      rr: [965, 960, 955],
      ppgBase: 18_900,
      ppgStep: 30,
      gravity: sleepingGravity,
      skinContact: 1,
    });
    pushSegment(0.5, {
      bpm: 64,
      rr: [995, 990, 985],
      ppgBase: 18_250,
      ppgStep: 25,
      gravity: sleepingGravity,
      skinContact: 1,
    });
    pushSegment(2.5, {
      bpm: 76,
      rr: [905, 895, 900],
      ppgBase: 19_350,
      ppgStep: 45,
      gravity: wakeGravityA,
      skinContact: 0,
    });
    pushSegment(14, {
      bpm: 62,
      rr: [980, 975, 970],
      ppgBase: 19_050,
      ppgStep: 40,
      gravity: sleepingGravity,
      skinContact: 1,
    });

    const records = generateSleepStageRecords(rows);
    const minutesFromStart = (date: Date) => (date.getTime() - start.getTime()) / 60000;
    const awakeCluster = records.find((record) => (
      record.stage === 'awake' &&
      minutesFromStart(record.start) <= 77.1 &&
      minutesFromStart(record.end) >= 94.5
    ));

    expect(awakeCluster).toBeDefined();
    expect(records.some((record) => (
      record.stage !== 'awake' &&
      minutesFromStart(record.start) >= 78 &&
      minutesFromStart(record.end) <= 95
    ))).toBe(false);
  });

  it('keeps a sustained late wake block awake instead of alternating back into rem', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

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

        await insertHeartRateRow(tx, {
          id,
          bpm,
          time: formatTestSqliteDateTime(sampleDate),
          rrIntervals,
          ppgGreen,
          signalQuality: 3074,
          skinContact: 1,
          accelGravity: gravity,
        });
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

  it('keeps a sustained late wake block awake through a short terminal sleepy tail', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const start = new Date(2026, 3, 8, 0, 0, 0);
    const sleepingGravity: [number, number, number] = [0.08, -0.03, 0.99];
    const wakeTransitionA: [number, number, number] = [-0.51, -0.78, 0.36];
    const wakeTransitionB: [number, number, number] = [-0.23, -0.91, 0.32];
    const quietWakeGravity: [number, number, number] = [-0.48, -0.64, 0.59];

    await adapter.withExclusiveTransactionAsync(async (tx) => {
      let id = 1;

      for (let second = 0; second < 243 * 60; second += 5) {
        const sampleDate = new Date(start.getTime() + second * 1000);
        const minute = second / 60;
        const isDeep = minute < 80;
        const isLight = minute >= 80 && minute < 140;
        const isRem = minute >= 140 && minute < 180;
        const wakeTransition = minute >= 180 && minute < 195;
        const quietWake = minute >= 195 && minute < 240;
        const sleepyTail = minute >= 240;
        const ppgGreen = isDeep
          ? 17_600 + (id % 7) * 90
          : isLight
            ? 18_350 + (id % 7) * 80
            : isRem
              ? 18_700 + (id % 7) * 70
              : wakeTransition || quietWake
                ? 26_200 + (id % 5) * 170
                : 18_550 + (id % 7) * 65;
        const bpm = isDeep ? 55 : isLight ? 58 : isRem ? 59 : wakeTransition ? 74 : quietWake ? 68 : 61;
        const rrIntervals = isDeep
          ? '1090,960,1110'
          : isLight
            ? '1005,995,1010'
            : isRem
              ? '985,980,975'
              : wakeTransition || quietWake
                ? '905,895,900'
                : '980,975,970';
        const gravity = wakeTransition
          ? id % 6 < 3
            ? wakeTransitionA
            : wakeTransitionB
          : quietWake
            ? quietWakeGravity
            : sleepingGravity;

        await insertHeartRateRow(tx, {
          id,
          bpm,
          time: formatTestSqliteDateTime(sampleDate),
          rrIntervals,
          ppgGreen,
          signalQuality: 3074,
          skinContact: 1,
          accelGravity: gravity,
        });
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
      return durationMinutes >= 15;
    });

    expect(sustainedWakeIndex).toBeGreaterThanOrEqual(0);
    expect(stageRows.slice(sustainedWakeIndex + 1).every((row) => row.stage === 'awake')).toBe(true);
    expect(stageRows.at(-1)?.stage).toBe('awake');

    adapter.close();
  });

  it('loads bundled overviews from btwearable.db on startup', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 3, 7, 12, 0, 0));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btwearable-db-'));
    const source = path.resolve(process.cwd(), 'assets/databases/btwearable.db');
    const databaseCopy = path.join(tempDir, 'btwearable.db');
    fs.copyFileSync(source, databaseCopy);

    const adapter = new NodeSqliteAdapter(new DatabaseSync(databaseCopy));

    try {
      await initializeDatabase(adapter as never);
      await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(false);

      const repository = new SQLiteHealthRepository(adapter as never);
      const [todayOverview, sleep, heart, wellness] = await Promise.all([
        repository.getTodayOverview(),
        repository.getSleepHistory('14d'),
        repository.getHeartHistory('14d'),
        repository.getWellnessData('14d'),
      ]);
      const historyOverview = await repository.getHistoryOverview(todayOverview.day.dayKey);

      expect(todayOverview.day.dayKey.length).toBeGreaterThan(0);
      expect(historyOverview.heartCard.series.length).toBeGreaterThan(0);
      expect(sleep.sessions.length).toBeGreaterThan(0);
      expect(heart.intraday.length).toBeGreaterThan(0);
      expect(wellness.activities.length).toBeGreaterThan(0);
    } finally {
      adapter.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
      jest.useRealTimers();
    }
  });

  it('keeps the seeded April 8 rebuild from exploding into many short low-confidence daytime activities', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btwearable-seeded-activity-'));
    const source = path.resolve(process.cwd(), 'assets/databases/btwearable.db');
    const databaseCopy = path.join(tempDir, 'btwearable.db');
    fs.copyFileSync(source, databaseCopy);

    const adapter = new NodeSqliteAdapter(new DatabaseSync(databaseCopy));

    try {
      await initializeDatabase(adapter as never);
      await refreshDerivedData(adapter as never);

      const activities = await adapter.getAllAsync<{
        start: string;
        end: string;
        activity: string;
        confidence: number | null;
      }>(
        `
          SELECT start, end, activity, confidence
          FROM activities
          WHERE substr(start, 1, 10) = '2026-04-08'
          ORDER BY start ASC
        `,
      );

      expect(activities.length).toBeLessThanOrEqual(4);
      expect(activities.every((activity) => {
        const durationMinutes = Number((
          (new Date(activity.end.replace(' ', 'T')).getTime() - new Date(activity.start.replace(' ', 'T')).getTime()) /
          60000
        ).toFixed(1));
        const confidence = activity.confidence ?? 0;

        if (activity.activity === 'Workout') {
          return durationMinutes >= 15 && confidence >= 0.75;
        }

        return durationMinutes >= 20 && confidence >= 0.7;
      })).toBe(true);
    } finally {
      adapter.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads larger synthetic overviews without triggering a derived rebuild', async () => {
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
    const [todayOverview, sleep, heart, wellness] = await Promise.all([
      repository.getTodayOverview(),
      repository.getSleepHistory('14d'),
      repository.getHeartHistory('14d'),
      repository.getWellnessData('14d'),
    ]);
    const historyOverview = await repository.getHistoryOverview(todayOverview.day.dayKey);
    const elapsedMs = Date.now() - startedAt;

    expect(todayOverview.day.dayKey.length).toBeGreaterThan(0);
    expect(historyOverview.heartCard.series.length).toBeGreaterThan(0);
    expect(sleep.sessions).toHaveLength(0);
    expect(heart.intraday.length).toBeGreaterThan(0);
    expect(wellness.activities).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(5_000);

    adapter.close();
  });

  it('loads the today overview without querying the removed legacy cache table', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    const overview = await repository.getTodayOverview();

    expect(overview.greeting.length).toBeGreaterThan(0);
    expect(overview.day.dayKey.length).toBeGreaterThan(0);
    expect(overview.sleepCard).toBeDefined();
    expect(Array.isArray(overview.activitySummary)).toBe(true);
    expect('heartCard' in (overview as unknown as object)).toBe(false);
    expect(
      adapter.calls.some((sql) => sql.includes('FROM dashboard_snapshot_cache')),
    ).toBe(false);

    adapter.close();
  });

  it('uses bounded heart queries when loading the history overview', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await repository.getHistoryOverview('2026-03-19');

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
          sql.includes('ppg_green') &&
          sql.includes('ORDER BY time ASC') &&
          !sql.includes('WHERE time >= ?'),
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
          sql.includes('ppg_green') &&
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

    await repository.getWellnessData('14d');

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
          sql.includes('ppg_green') &&
          sql.includes('WHERE time >= ?'),
      ),
    ).toBe(false);

    adapter.close();
  });

  it('does not block overview reads when derived refresh is pending', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await markDerivedRefreshPending(adapter as never, '2026-03-19 06:55:00', '2026-03-19 07:00:00');
    adapter.calls.length = 0;

    const overview = await repository.getTodayOverview();

    expect(overview.day.dayKey.length).toBeGreaterThan(0);
    expect(adapter.calls.some((sql) => sql.includes('UPDATE heart_rate SET stress'))).toBe(false);

    adapter.close();
  });

  it('builds the curated health trends board and leaves baseline-driven metrics empty until enough nights exist', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    const trends = await repository.getTrendData('14d');

    expect(trends.primaryMetrics.map((metric) => metric.id)).toEqual([
      'recovery',
      'hrv',
      'restingHr',
      'sleepScore',
    ]);
    expect(trends.secondaryMetrics.map((metric) => metric.id)).toEqual([
      'sleepDuration',
      'sleepConsistency',
      'stress',
      'skinTemperatureDeviation',
    ]);
    expect(trends.primaryMetrics.find((metric) => metric.id === 'hrv')).toMatchObject({
      latest: 53,
      unit: 'ms',
      hasPartialData: true,
    });
    expect(trends.secondaryMetrics.find((metric) => metric.id === 'sleepDuration')).toMatchObject({
      latest: 8,
      unit: 'h',
    });
    expect(trends.secondaryMetrics.find((metric) => metric.id === 'sleepConsistency')).toMatchObject({
      latest: null,
      missingReason: 'More nights are needed before sleep consistency can be scored.',
    });
    expect(trends.secondaryMetrics.find((metric) => metric.id === 'skinTemperatureDeviation')).toMatchObject({
      latest: null,
      missingReason: 'A few nights of temperature data are needed before baseline shifts can be tracked.',
    });

    adapter.close();
  });

  it('ignores implausible max bpm placeholders when reading the intraday heart window', async () => {
    const { adapter, repository } = await createRepositoryFixture();

    await insertHeartRateRow(adapter, {
      id: 5,
      bpm: 255,
      time: '2026-03-19 07:05:00',
      rrIntervals: '',
    });
    await insertHeartRateRow(adapter, {
      id: 6,
      bpm: 74,
      time: '2026-03-19 07:10:00',
      rrIntervals: '910,920,930',
      ppgGreen: 18000,
    });

    const heart = await repository.getHeartHistory('14d');

    expect(heart.maxHr).toBe(74);
    expect(heart.averageHr).toBeLessThan(100);

    adapter.close();
  });

  it('preserves missing intraday buckets as null chart points', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    await insertHeartRateRow(adapter, {
      id: 1,
      bpm: 70,
      time: '2026-03-20 01:00:00',
      rrIntervals: '1000,990,980',
    });
    await insertHeartRateRow(adapter, {
      id: 2,
      bpm: 72,
      time: '2026-03-20 01:05:00',
      rrIntervals: '1000,990,980',
    });
    await insertHeartRateRow(adapter, {
      id: 3,
      bpm: 78,
      time: '2026-03-20 04:00:00',
      rrIntervals: '1000,990,980',
    });
    await insertHeartRateRow(adapter, {
      id: 4,
      bpm: 80,
      time: '2026-03-20 04:05:00',
      rrIntervals: '1000,990,980',
    });
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

    await insertHeartRateRow(adapter, {
      id: 5001,
      bpm: 0,
      time: '2026-04-04 00:29:34',
      rrIntervals: '',
    });
    await insertHeartRateRow(adapter, {
      id: 5002,
      bpm: 255,
      time: '2026-04-04 00:29:35',
      rrIntervals: '',
    });
    await insertHeartRateRow(adapter, {
      id: 5003,
      bpm: 1,
      time: '2026-04-05 00:29:34',
      rrIntervals: '',
    });
    await insertHeartRateRow(adapter, {
      id: 5004,
      bpm: 254,
      time: '2026-04-05 00:29:35',
      rrIntervals: '',
    });

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

  it('builds 30-second focused heart detail buckets for a 20-minute activity window', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const start = new Date(2026, 3, 23, 8, 0, 0, 0);
    await insertSyntheticHeartSeries(adapter, {
      count: 241,
      start,
      intervalMinutes: 5 / 60,
    });

    const repository = new SQLiteHealthRepository(adapter as never);
    const detail = await repository.getFocusedHeartDetail({
      id: 'activity-short-run',
      kind: 'activity',
      label: 'Workout',
      timeLabel: '8:00 - 8:20',
      startFraction: 0.3,
      endFraction: 0.5,
      startTimeMs: start.getTime(),
      endTimeMs: start.getTime() + 20 * 60_000,
      details: {
        durationMinutes: 20,
        reviewState: 'confirmed',
        source: 'manual',
      },
    });

    expect(detail.pointIntervalMinutes).toBe(0.5);
    expect(detail.series).toHaveLength(41);
    expect(detail.marker.startFraction).toBe(0);
    expect(detail.marker.endFraction).toBe(1);
    expect(detail.series[0]?.label).toBe('8:00 AM');
    expect(detail.series[1]?.label).toBe('8:00:30 AM');

    adapter.close();
  });

  it('builds denser 7-day dashboard heart timelines for tighter zoom presets', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const start = new Date(2026, 3, 16, 0, 0, 0, 0);
    await insertSyntheticHeartSeries(adapter, {
      count: 10_081,
      start,
      intervalMinutes: 1,
    });

    adapter.calls.length = 0;

    const repository = new SQLiteHealthRepository(adapter as never);
    const overview = await repository.getDashboardHeartTimeline('7d');
    const zoomed = await repository.getDashboardHeartTimeline('7d', { bucketMinutes: 1 });

    expect(overview.pointIntervalMinutes).toBe(5);
    expect(overview.series).toHaveLength(2017);
    expect(zoomed.pointIntervalMinutes).toBe(1);
    expect(zoomed.series).toHaveLength(10_081);
    expect(zoomed.series.length).toBeGreaterThan(overview.series.length);

    adapter.close();
  });

  it('fetches a reusable raw heart window that can be bucketed at multiple sizes', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const start = new Date(2026, 3, 16, 0, 0, 0, 0);
    await insertSyntheticHeartSeries(adapter, {
      count: 10_081,
      start,
      intervalMinutes: 1,
    });

    const repository = new SQLiteHealthRepository(adapter as never);
    const window = await repository.getDashboardHeartTimelineWindow('7d');

    expect(window.samples).toHaveLength(10_081);
    expect(Array.isArray(window.markers)).toBe(true);

    const oneMinuteTimeline = buildHeartCardDataFromWindow(window, 1);
    const twoMinuteTimeline = buildHeartCardDataFromWindow(window, 2);

    expect(oneMinuteTimeline.pointIntervalMinutes).toBe(1);
    expect(twoMinuteTimeline.pointIntervalMinutes).toBe(2);
    expect(oneMinuteTimeline.series.length).toBeGreaterThan(twoMinuteTimeline.series.length);

    adapter.close();
  });

  it('reuses the raw heart window when switching between custom dashboard bucket sizes', async () => {
    const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
    await initializeDatabase(adapter as never);

    const start = new Date(2026, 3, 16, 0, 0, 0, 0);
    await insertSyntheticHeartSeries(adapter, {
      count: 10_081,
      start,
      intervalMinutes: 1,
    });

    const repository = new SQLiteHealthRepository(adapter as never);
    await repository.getDashboardHeartTimeline('7d', { bucketMinutes: 1 });

    const rawWindowQueriesAfterFirstCall = adapter.calls.filter(
      (sql) =>
        sql.includes('SELECT bpm, time') &&
        sql.includes('FROM heart_rate') &&
        sql.includes('WHERE time >= ? AND time <= ?') &&
        sql.includes('ORDER BY time ASC'),
    ).length;

    await repository.getDashboardHeartTimeline('7d', { bucketMinutes: 2 });

    const heartTimelineWindowCache = (repository as unknown as {
      heartTimelineWindowCache: Map<string, unknown>;
    }).heartTimelineWindowCache;

    expect(heartTimelineWindowCache.size).toBe(1);

    const rawWindowQueriesAfterSecondCall = adapter.calls.filter(
      (sql) =>
        sql.includes('SELECT bpm, time') &&
        sql.includes('FROM heart_rate') &&
        sql.includes('WHERE time >= ? AND time <= ?') &&
        sql.includes('ORDER BY time ASC'),
    ).length;

    expect(rawWindowQueriesAfterSecondCall).toBe(rawWindowQueriesAfterFirstCall);

    adapter.close();
  });
});
