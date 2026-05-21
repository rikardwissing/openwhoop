import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initializeDatabase } from '@/db/schema';
import { refreshDerivedData } from '@/data/sqlite/SQLiteHealthRepository';
import { fetchGraphQLSleepHistory } from '@/hooks/useGraphQLSleepHistory';

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

interface RawStageRow {
  stage: string;
  start: string;
  end: string;
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

function durationMsBetween(start: string, end: string) {
  return Math.max(0, new Date(end.replace(' ', 'T')).getTime() - new Date(start.replace(' ', 'T')).getTime());
}

function summarizeRawStageRows(rows: RawStageRow[]) {
  return rows.map((row) => ({
    stage: row.stage,
    start: row.start,
    end: row.end,
    seconds: Math.round(durationMsBetween(row.start, row.end) / 1000),
    minutes: Number((durationMsBetween(row.start, row.end) / 60000).toFixed(1)),
  }));
}

describe('sleep replay script', () => {
  jest.setTimeout(120000);

  it('rebuilds recent sleep sessions from a copied database and prints the results', async () => {
    const sourcePath = process.env.BTWEARABLE_DB_PATH || defaultDbPath();
    const replayLimit = parsePositiveInt(process.env.BTWEARABLE_REPLAY_LIMIT, 3);
    const requestedSleepId = process.env.BTWEARABLE_REPLAY_SLEEP_ID ?? null;

    expect(fs.existsSync(sourcePath)).toBe(true);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btwearable-sleep-replay-'));
    const dbCopy = path.join(tempDir, 'btwearable.db');
    fs.copyFileSync(sourcePath, dbCopy);

    const adapter = new NodeSqliteAdapter(new DatabaseSync(dbCopy));

    try {
      await initializeDatabase(adapter as never);
      await refreshDerivedData(adapter as never);

      const sleepHistory = await fetchGraphQLSleepHistory(adapter as never, '14d');
      const sessions = requestedSleepId
        ? sleepHistory.sessions.filter((session) => session.id === requestedSleepId)
        : sleepHistory.sessions.slice(0, replayLimit);

      expect(sessions.length).toBeGreaterThan(0);

      const replay = [];
      for (const session of sessions) {
        const rawStageRows = await adapter.getAllAsync<RawStageRow>(
          `
            SELECT stage, start, end
            FROM sleep_stage_segments
            WHERE sleep_id = ?
            ORDER BY start ASC
          `,
          session.id,
        );

        replay.push({
          id: session.id,
          dateLabel: session.dateLabel,
          bedtime: session.bedtime,
          wakeTime: session.wakeTime,
          durationMinutes: session.durationMinutes,
          timeInBedMinutes: session.timeInBedMinutes,
          efficiency: session.efficiency,
          remMinutes: session.remMinutes,
          deepMinutes: session.deepMinutes,
          summaryStages: session.stages,
          rawStageRows: summarizeRawStageRows(rawStageRows),
        });
      }

      console.log(
        JSON.stringify(
          {
            sourcePath,
            replayLimit,
            requestedSleepId,
            sessions: replay,
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
