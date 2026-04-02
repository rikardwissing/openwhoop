import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initializeDatabase } from '@/db/schema';
import {
  SQLiteHealthRepository,
  refreshDerivedData,
  shouldRefreshDerivedData,
} from '@/data/sqlite/SQLiteHealthRepository';

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
      VALUES (1, 1, 4, '2026-03-19 07:05:00')
    `,
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
        VALUES (1, 1, 1, '2026-03-20 06:05:00')
      `,
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
        SET derived_schema_version = 1, source_heart_count = 99
        WHERE id = 1
      `,
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

  it('loads seeded snapshots without triggering a derived rebuild on startup', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btwearable-seed-'));
    const source = path.resolve(process.cwd(), 'assets/databases/btwearable-seed.db');
    const seedCopy = path.join(tempDir, 'btwearable-seed.db');
    fs.copyFileSync(source, seedCopy);

    const adapter = new NodeSqliteAdapter(new DatabaseSync(seedCopy));
    await initializeDatabase(adapter as never);
    await expect(shouldRefreshDerivedData(adapter as never)).resolves.toBe(false);

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
        VALUES (1, 1, 4, '2026-03-20 04:10:00')
      `,
    );

    const repository = new SQLiteHealthRepository(adapter as never);
    const heart = await repository.getHeartHistory('14d');

    expect(heart.intraday.find((point) => point.label === '1 AM')?.value).toBe(70);
    expect(heart.intraday.find((point) => point.label === '1:10 AM')?.value).toBeNull();
    expect(heart.intraday.find((point) => point.label === '4 AM')?.value).toBe(78);

    adapter.close();
  });
});
