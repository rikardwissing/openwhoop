import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initializeDatabase } from '@/db/schema';
import { refreshDerivedData } from '@/data/sqlite/SQLiteHealthRepository';

type SqlArg = string | number | null;

class NodeSqliteAdapter {
  constructor(private readonly db: DatabaseSync) {}

  async getFirstAsync<T>(sql: string, ...args: SqlArg[]) {
    return (this.db.prepare(sql).get(...args) as T | undefined) ?? null;
  }

  async getAllAsync<T>(sql: string, ...args: SqlArg[]) {
    return this.db.prepare(sql).all(...args) as T[];
  }

  async runAsync(sql: string, ...args: SqlArg[]) {
    return this.db.prepare(sql).run(...args);
  }

  async execAsync(sql: string) {
    this.db.exec(sql);
  }

  async withExclusiveTransactionAsync<T>(
    callback: (tx: Pick<NodeSqliteAdapter, 'runAsync' | 'execAsync'>) => Promise<T>,
  ) {
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

interface ActivityRow {
  period_id: string;
  start: string;
  end: string;
  activity: string;
  confidence: number | null;
  source: string | null;
  review_state: string | null;
}

interface LatestHeartRow {
  latest_time: string | null;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultDbPath() {
  const candidates = [
    path.resolve(process.cwd(), 'btwearable.db'),
    path.resolve(process.cwd(), '../btwearable.db'),
    path.resolve(process.cwd(), '../../btwearable.db'),
    path.resolve(__dirname, '../../btwearable.db'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatSqliteDateTime(date: Date) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  const second = `${date.getSeconds()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function durationMinutesBetween(start: string, end: string) {
  return Number(
    (
      Math.max(0, new Date(end.replace(' ', 'T')).getTime() - new Date(start.replace(' ', 'T')).getTime()) / 60000
    ).toFixed(1),
  );
}

describe('activity replay script', () => {
  jest.setTimeout(120000);

  it('rebuilds recent activity sessions from a copied database and prints the results', async () => {
    const sourcePath = process.env.BTWEARABLE_DB_PATH || defaultDbPath();
    const replayLimit = parsePositiveInt(process.env.BTWEARABLE_ACTIVITY_REPLAY_LIMIT, 12);
    const lookbackDays = parsePositiveInt(process.env.BTWEARABLE_ACTIVITY_LOOKBACK_DAYS, 7);

    expect(fs.existsSync(sourcePath)).toBe(true);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btwearable-activity-replay-'));
    const dbCopy = path.join(tempDir, 'btwearable.db');
    fs.copyFileSync(sourcePath, dbCopy);

    const adapter = new NodeSqliteAdapter(new DatabaseSync(dbCopy));

    try {
      await initializeDatabase(adapter as never);
      await refreshDerivedData(adapter as never);

      const latestHeart = await adapter.getFirstAsync<LatestHeartRow>(
        `
          SELECT MAX(time) AS latest_time
          FROM heart_rate
        `,
      );

      expect(latestHeart?.latest_time).toBeTruthy();
      const latestDate = new Date(latestHeart!.latest_time!.replace(' ', 'T'));
      const cutoff = formatSqliteDateTime(addDays(latestDate, -lookbackDays));

      const activities = await adapter.getAllAsync<ActivityRow>(
        `
          SELECT period_id, start, end, activity, confidence, source, review_state
          FROM activities
          WHERE end >= ?
          ORDER BY start DESC
          LIMIT ?
        `,
        cutoff,
        replayLimit,
      );

      console.log(
        JSON.stringify(
          {
            sourcePath,
            lookbackDays,
            replayLimit,
            latestHeartTime: latestHeart!.latest_time,
            activities: activities.map((activity) => ({
              ...activity,
              durationMinutes: durationMinutesBetween(activity.start, activity.end),
            })),
          },
          null,
          2,
        ),
      );
    } finally {
      adapter.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});