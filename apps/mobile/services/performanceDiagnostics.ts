import type { SQLiteDatabase } from 'expo-sqlite';

import { rebuildAggregateTablesForDebug, refreshDerivedData } from '@/data/sqlite/SQLiteHealthRepository';
import { fetchGraphQLHistoryOverview, fetchGraphQLTodayOverview } from '@/hooks/useGraphQLDashboardOverview';
import { fetchGraphQLDerivedRefreshState } from '@/hooks/useGraphQLDerivedRefreshState';
import { fetchGraphQLHeartHistory } from '@/hooks/useGraphQLHeartHistory';
import { fetchGraphQLSleepHistory } from '@/hooks/useGraphQLSleepHistory';
import { fetchGraphQLWellnessData } from '@/hooks/useGraphQLWellnessData';
import type {
  DerivedRefreshState,
  HeartHistoryData,
  HistoryOverview,
  HistoryRange,
  SleepHistoryData,
  TodayOverview,
  WellnessData,
} from '@/types/health';
import { formatSqliteDateTime } from '@/utils/dateTime';

type PerformanceDiagnosticValue = string | number | boolean | null;

export type PerformanceDiagnosticRunKind = 'full_sweep';
export type PerformanceDiagnosticRunStatus = 'success' | 'partial' | 'error';
export type PerformanceDiagnosticStepStatus = 'success' | 'not_applicable' | 'error';

export interface PerformanceDiagnosticStep {
  key: string;
  label: string;
  status: PerformanceDiagnosticStepStatus;
  elapsedMs: number | null;
  details: Record<string, PerformanceDiagnosticValue>;
}

export interface PerformanceDiagnosticRun {
  id: number;
  runKind: PerformanceDiagnosticRunKind;
  status: PerformanceDiagnosticRunStatus;
  startedAt: string;
  finishedAt: string;
  totalElapsedMs: number;
  appMode: 'development' | 'production';
  heartRowCount: number;
  derivedStatus: DerivedRefreshState['status'];
  derivedPendingFromTime: string | null;
  derivedPendingToTime: string | null;
  lastSyncStartedAt: string | null;
  lastSyncFinishedAt: string | null;
  lastSyncResult: 'success' | 'skipped' | 'error' | null;
  lastSyncImportedReadings: number | null;
  steps: PerformanceDiagnosticStep[];
}

interface PerformanceDiagnosticRunRow {
  id: number;
  run_kind: PerformanceDiagnosticRunKind;
  status: PerformanceDiagnosticRunStatus;
  started_at: string;
  finished_at: string;
  total_elapsed_ms: number;
  app_mode: 'development' | 'production';
  heart_row_count: number;
  derived_status: DerivedRefreshState['status'];
  derived_pending_from_time: string | null;
  derived_pending_to_time: string | null;
  last_sync_started_at: string | null;
  last_sync_finished_at: string | null;
  last_sync_result: 'success' | 'skipped' | 'error' | null;
  last_sync_imported_readings: number | null;
}

interface PerformanceDiagnosticStepRow {
  run_id: number;
  step_index: number;
  step_key: string;
  label: string;
  status: PerformanceDiagnosticStepStatus;
  elapsed_ms: number | null;
  details_json: string;
}

interface CountRow {
  value: number | null;
}

export interface RunFullPerformanceSweepParams {
  db: SQLiteDatabase;
  historyRange?: HistoryRange;
}

const PERFORMANCE_DIAGNOSTIC_RETENTION = 20;
const DEFAULT_HISTORY_RANGE: HistoryRange = '14d';
const APP_MODE =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'development' : 'production';

function serializeDetails(details: Record<string, PerformanceDiagnosticValue>) {
  return JSON.stringify(details);
}

function parseDetails(detailsJson: string | null | undefined) {
  if (!detailsJson) {
    return {} as Record<string, PerformanceDiagnosticValue>;
  }

  try {
    const parsed = JSON.parse(detailsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, PerformanceDiagnosticValue>;
    }
  } catch {
    return {};
  }

  return {};
}

function toRun(row: PerformanceDiagnosticRunRow, steps: PerformanceDiagnosticStep[]): PerformanceDiagnosticRun {
  return {
    id: row.id,
    runKind: row.run_kind,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalElapsedMs: row.total_elapsed_ms,
    appMode: row.app_mode,
    heartRowCount: row.heart_row_count,
    derivedStatus: row.derived_status,
    derivedPendingFromTime: row.derived_pending_from_time,
    derivedPendingToTime: row.derived_pending_to_time,
    lastSyncStartedAt: row.last_sync_started_at,
    lastSyncFinishedAt: row.last_sync_finished_at,
    lastSyncResult: row.last_sync_result,
    lastSyncImportedReadings: row.last_sync_imported_readings,
    steps,
  };
}

function summarizeTodayOverview(overview: TodayOverview) {
  return {
    activities: overview.activitySummary.length,
    hasSleep: overview.sleepCard.score !== null,
    insights: overview.insights.length,
  } satisfies Record<string, PerformanceDiagnosticValue>;
}

function summarizeHistoryOverview(overview: HistoryOverview) {
  return {
    activities: overview.activitySummary.length,
    hasSleep: overview.sleepCard.score !== null,
    heartPoints: overview.heartCard.series.length,
    markers: overview.heartCard.markers.length,
  } satisfies Record<string, PerformanceDiagnosticValue>;
}

function summarizeSleepHistory(snapshot: SleepHistoryData) {
  return {
    sessions: snapshot.sessions.length,
    scorePoints: snapshot.scoreTrend.length,
    durationPoints: snapshot.durationTrend.length,
  } satisfies Record<string, PerformanceDiagnosticValue>;
}

function summarizeHeartHistory(snapshot: HeartHistoryData) {
  return {
    intradayPoints: snapshot.intraday.length,
    weeklyPoints: snapshot.weeklyResting.length,
    restingHr: snapshot.restingHr,
  } satisfies Record<string, PerformanceDiagnosticValue>;
}

function summarizeWellnessData(data: WellnessData) {
  return {
    activities: data.activities.length,
    stressPoints: data.stress.series.length,
    spo2Points: data.spo2.series.length,
    respiratoryRatePoints: data.respiratoryRate.series.length,
    recoveryPoints: data.recoveryIndex.series.length,
  } satisfies Record<string, PerformanceDiagnosticValue>;
}

async function countHeartRows(db: Pick<SQLiteDatabase, 'getFirstAsync'>) {
  const row = await db.getFirstAsync<CountRow>('SELECT COUNT(*) AS value FROM heart_rate');
  return row?.value ?? 0;
}

async function persistPerformanceDiagnosticRun(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  run: Omit<PerformanceDiagnosticRun, 'id'>,
) {
  const result = await db.runAsync(
    `
      INSERT INTO performance_diagnostic_runs (
        run_kind,
        status,
        started_at,
        finished_at,
        total_elapsed_ms,
        app_mode,
        heart_row_count,
        derived_status,
        derived_pending_from_time,
        derived_pending_to_time,
        last_sync_started_at,
        last_sync_finished_at,
        last_sync_result,
        last_sync_imported_readings
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    run.runKind,
    run.status,
    run.startedAt,
    run.finishedAt,
    run.totalElapsedMs,
    run.appMode,
    run.heartRowCount,
    run.derivedStatus,
    run.derivedPendingFromTime,
    run.derivedPendingToTime,
    run.lastSyncStartedAt,
    run.lastSyncFinishedAt,
    run.lastSyncResult,
    run.lastSyncImportedReadings,
  );

  const insertedId = Number(
    (result as { lastInsertRowId?: number | bigint; lastInsertRowid?: number | bigint }).lastInsertRowId ??
      (result as { lastInsertRowId?: number | bigint; lastInsertRowid?: number | bigint }).lastInsertRowid ??
      0,
  );

  if (Number.isFinite(insertedId) && insertedId > 0) {
    return insertedId;
  }

  const row = await db.getFirstAsync<{ id: number }>(
    `
      SELECT id
      FROM performance_diagnostic_runs
      ORDER BY id DESC
      LIMIT 1
    `,
  );
  return row?.id ?? 0;
}

async function persistPerformanceDiagnosticSteps(
  db: Pick<SQLiteDatabase, 'runAsync'>,
  runId: number,
  steps: readonly PerformanceDiagnosticStep[],
) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    await db.runAsync(
      `
        INSERT INTO performance_diagnostic_steps (
          run_id,
          step_index,
          step_key,
          label,
          status,
          elapsed_ms,
          details_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      runId,
      index,
      step.key,
      step.label,
      step.status,
      step.elapsedMs,
      serializeDetails(step.details),
    );
  }
}

async function trimPerformanceDiagnosticHistory(db: Pick<SQLiteDatabase, 'runAsync'>) {
  await db.runAsync(
    `
      DELETE FROM performance_diagnostic_runs
      WHERE id IN (
        SELECT id
        FROM performance_diagnostic_runs
        ORDER BY started_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `,
    PERFORMANCE_DIAGNOSTIC_RETENTION,
  );
}

async function recordPerformanceDiagnosticRun(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  run: Omit<PerformanceDiagnosticRun, 'id'>,
) {
  const runId = await persistPerformanceDiagnosticRun(db, run);
  await persistPerformanceDiagnosticSteps(db, runId, run.steps);
  await trimPerformanceDiagnosticHistory(db);

  return {
    ...run,
    id: runId,
  } satisfies PerformanceDiagnosticRun;
}

async function measureReadStep<T>(
  steps: PerformanceDiagnosticStep[],
  key: string,
  label: string,
  read: () => Promise<T>,
  summarize: (result: T) => Record<string, PerformanceDiagnosticValue>,
) {
  const startedAt = Date.now();

  try {
    const result = await read();
    steps.push({
      key,
      label,
      status: 'success',
      elapsedMs: Date.now() - startedAt,
      details: summarize(result),
    });
    return result;
  } catch (error) {
    steps.push({
      key,
      label,
      status: 'error',
      elapsedMs: Date.now() - startedAt,
      details: {
        error: error instanceof Error ? error.message : 'Step failed.',
      },
    });
    throw error;
  }
}

async function measureBooleanStep(
  steps: PerformanceDiagnosticStep[],
  key: string,
  label: string,
  run: () => Promise<boolean>,
) {
  const startedAt = Date.now();

  try {
    const result = await run();
    steps.push({
      key,
      label,
      status: result ? 'success' : 'not_applicable',
      elapsedMs: Date.now() - startedAt,
      details: {
        result,
      },
    });
    return result;
  } catch (error) {
    steps.push({
      key,
      label,
      status: 'error',
      elapsedMs: Date.now() - startedAt,
      details: {
        error: error instanceof Error ? error.message : 'Step failed.',
      },
    });
    throw error;
  }
}

async function primeWarmRead<T>(read: () => Promise<T>) {
  await read();
}

async function runRepeatedReadPair<T>(params: {
  steps: PerformanceDiagnosticStep[];
  warmKey: string;
  warmLabel: string;
  coldKey: string;
  coldLabel: string;
  read: () => Promise<T>;
  summarize: (result: T) => Record<string, PerformanceDiagnosticValue>;
}) {
  await primeWarmRead(params.read);
  await measureReadStep(params.steps, params.warmKey, params.warmLabel, params.read, params.summarize);
  await measureReadStep(params.steps, params.coldKey, params.coldLabel, params.read, params.summarize);
}

export async function runFullPerformanceSweep({
  db,
  historyRange = DEFAULT_HISTORY_RANGE,
}: RunFullPerformanceSweepParams): Promise<PerformanceDiagnosticRun> {
  const startedAtDate = new Date();
  const startedAt = formatSqliteDateTime(startedAtDate);
  const steps: PerformanceDiagnosticStep[] = [];
  const heartRowCount = await countHeartRows(db);
  const derivedState = await fetchGraphQLDerivedRefreshState(db);
  let latestDayKey: string | null = null;

  try {
    await measureBooleanStep(
      steps,
      'derived.full.rebuild',
      'Full derived data rebuild',
      async () => {
        if (heartRowCount === 0) {
          return false;
        }

        await refreshDerivedData(db);
        return true;
      },
    );

    await runRepeatedReadPair({
      steps,
      warmKey: 'today.read.warm',
      warmLabel: 'Today overview first repeat read',
      coldKey: 'today.read.cold',
      coldLabel: 'Today overview second repeat read',
      read: async () => {
        const overview = await fetchGraphQLTodayOverview(db);
        latestDayKey = overview.day.dayKey;
        return overview;
      },
      summarize: summarizeTodayOverview,
    });

    const historyDayKey = latestDayKey ?? (await fetchGraphQLTodayOverview(db)).day.dayKey;

    await runRepeatedReadPair({
      steps,
      warmKey: 'history.read.warm',
      warmLabel: 'History overview first repeat read',
      coldKey: 'history.read.cold',
      coldLabel: 'History overview second repeat read',
      read: () => fetchGraphQLHistoryOverview(db, historyDayKey),
      summarize: summarizeHistoryOverview,
    });

    await runRepeatedReadPair({
      steps,
      warmKey: 'sleep.read.warm',
      warmLabel: 'Sleep first repeat read',
      coldKey: 'sleep.read.cold',
      coldLabel: 'Sleep second repeat read',
      read: () => fetchGraphQLSleepHistory(db, historyRange),
      summarize: summarizeSleepHistory,
    });

    await runRepeatedReadPair({
      steps,
      warmKey: 'heart.read.warm',
      warmLabel: 'Heart first repeat read',
      coldKey: 'heart.read.cold',
      coldLabel: 'Heart second repeat read',
      read: () => fetchGraphQLHeartHistory(db, historyRange),
      summarize: summarizeHeartHistory,
    });

    await runRepeatedReadPair({
      steps,
      warmKey: 'wellness.read.warm',
      warmLabel: 'Wellness first repeat read',
      coldKey: 'wellness.read.cold',
      coldLabel: 'Wellness second repeat read',
      read: () => fetchGraphQLWellnessData(db, historyRange),
      summarize: summarizeWellnessData,
    });

    await measureBooleanStep(
      steps,
      'aggregates.rebuild',
      'Aggregate table rebuild',
      () => rebuildAggregateTablesForDebug(db),
    );

    await measureReadStep(
      steps,
      'today.read.after_aggregate',
      'Today overview read after aggregate rebuild',
      () => fetchGraphQLTodayOverview(db),
      summarizeTodayOverview,
    );
    await measureReadStep(
      steps,
      'history.read.after_aggregate',
      'History overview read after aggregate rebuild',
      () => fetchGraphQLHistoryOverview(db, historyDayKey),
      summarizeHistoryOverview,
    );
    await measureReadStep(
      steps,
      'heart.read.after_aggregate',
      'Heart read after aggregate rebuild',
      () => fetchGraphQLHeartHistory(db, historyRange),
      summarizeHeartHistory,
    );
    await measureReadStep(
      steps,
      'wellness.read.after_aggregate',
      'Wellness read after aggregate rebuild',
      () => fetchGraphQLWellnessData(db, historyRange),
      summarizeWellnessData,
    );

    const finishedAt = formatSqliteDateTime(new Date());
    const run: Omit<PerformanceDiagnosticRun, 'id'> = {
      runKind: 'full_sweep',
      status:
        heartRowCount === 0 || steps.some((step) => step.status === 'not_applicable')
          ? 'partial'
          : 'success',
      startedAt,
      finishedAt,
      totalElapsedMs: Date.now() - startedAtDate.getTime(),
      appMode: APP_MODE,
      heartRowCount,
      derivedStatus: derivedState.status,
      derivedPendingFromTime: derivedState.pendingFromTime,
      derivedPendingToTime: derivedState.pendingToTime,
      lastSyncStartedAt: null,
      lastSyncFinishedAt: null,
      lastSyncResult: null,
      lastSyncImportedReadings: null,
      steps,
    };

    return recordPerformanceDiagnosticRun(db, run);
  } catch (error) {
    const finishedAt = formatSqliteDateTime(new Date());
    const run: Omit<PerformanceDiagnosticRun, 'id'> = {
      runKind: 'full_sweep',
      status: 'error',
      startedAt,
      finishedAt,
      totalElapsedMs: Date.now() - startedAtDate.getTime(),
      appMode: APP_MODE,
      heartRowCount,
      derivedStatus: derivedState.status,
      derivedPendingFromTime: derivedState.pendingFromTime,
      derivedPendingToTime: derivedState.pendingToTime,
      lastSyncStartedAt: null,
      lastSyncFinishedAt: null,
      lastSyncResult: null,
      lastSyncImportedReadings: null,
      steps: [
        ...steps,
        {
          key: 'run.error',
          label: 'Sweep failure',
          status: 'error',
          elapsedMs: null,
          details: {
            error: error instanceof Error ? error.message : 'Sweep failed.',
          },
        },
      ],
    };

    await recordPerformanceDiagnosticRun(db, run);
    throw error;
  }
}

export async function listRecentPerformanceDiagnosticRuns(
  db: Pick<SQLiteDatabase, 'getAllAsync'>,
  limit = 5,
): Promise<PerformanceDiagnosticRun[]> {
  const runRows = await db.getAllAsync<PerformanceDiagnosticRunRow>(
    `
      SELECT
        id,
        run_kind,
        status,
        started_at,
        finished_at,
        total_elapsed_ms,
        app_mode,
        heart_row_count,
        derived_status,
        derived_pending_from_time,
        derived_pending_to_time,
        last_sync_started_at,
        last_sync_finished_at,
        last_sync_result,
        last_sync_imported_readings
      FROM performance_diagnostic_runs
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `,
    limit,
  );

  if (runRows.length === 0) {
    return [];
  }

  const placeholders = runRows.map(() => '?').join(', ');
  const stepRows = await db.getAllAsync<PerformanceDiagnosticStepRow>(
    `
      SELECT
        run_id,
        step_index,
        step_key,
        label,
        status,
        elapsed_ms,
        details_json
      FROM performance_diagnostic_steps
      WHERE run_id IN (${placeholders})
      ORDER BY run_id DESC, step_index ASC
    `,
    ...runRows.map((row) => row.id),
  );

  const stepsByRunId = new Map<number, PerformanceDiagnosticStep[]>();
  for (const row of stepRows) {
    const list = stepsByRunId.get(row.run_id) ?? [];
    list.push({
      key: row.step_key,
      label: row.label,
      status: row.status,
      elapsedMs: row.elapsed_ms,
      details: parseDetails(row.details_json),
    });
    stepsByRunId.set(row.run_id, list);
  }

  return runRows.map((row) => toRun(row, stepsByRunId.get(row.id) ?? []));
}
