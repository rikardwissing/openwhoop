import type { SQLiteDatabase } from 'expo-sqlite';

import type { HealthCacheScope, HealthRepository } from '@/data/HealthRepository';
import { generateSleepStageRecords, isAwakePpgValue } from '@/data/sqlite/sleepStages';
import { DERIVED_DATA_SCHEMA_VERSION } from '@/db/schema';
import type {
  ActivitySummary,
  DerivedRefreshState,
  DashboardSnapshot,
  HeartHistorySnapshot,
  HistoryRange,
  MetricSeries,
  RecoveryBreakdown,
  SleepCardSnapshot,
  SleepHistorySnapshot,
  SleepPlanSnapshot,
  SleepSession,
  SleepStage,
  SleepStageSegment,
  TrendPoint,
  WellnessSnapshot,
} from '@/types/health';
import { addMinutes, dateKey, formatAxisTime, formatClock, formatClockMinutes, formatLongDate, formatShortDate, formatSqliteDateTime, hoursBetween, minutesBetween, parseSqliteDateTime } from '@/utils/dateTime';
import { describeRecovery, describeSleepScore, formatMetricNumber } from '@/utils/formatters';
import {
  filterPlausibleRecordedBpms,
  isPlausibleRecordedBpm,
  MAX_PLAUSIBLE_RECORDED_BPM,
  MIN_PLAUSIBLE_RECORDED_BPM,
  sanitizeRecordedBpm,
  sustainedPeakBpm,
} from '@/utils/heartRate';
import { clamp, mean, median, stdDev } from '@/utils/math';
import { BASE_SLEEP_NEED_MINUTES, SLEEP_TARGET_STEP_MINUTES, applyNapCreditToSleepDebt, calculateOptimalBedtimeMinutes, calculateSleepDebtMinutes, calculateSleepNeedMinutes, normalizeClockMinutes, roundClockMinutes } from '@/utils/sleepPlan';

const NO_HISTORY_REASON = 'No local history yet. Sync the wearable from Settings to unlock this view.';
const NO_SLEEP_REASON = 'No overnight sleep has been detected yet. Leave the wearable on long enough for a full sleep window.';
const LIMITED_SENSOR_REASON = 'The wearable has not collected enough samples for this signal yet.';

const GRAVITY_STILL_THRESHOLD = 0.01;
const GRAVITY_WINDOW_MINUTES = 15;
const GRAVITY_STILL_FRACTION = 0.7;
const GRAVITY_MAX_GAP_MINUTES = 20;
const MIN_SLEEP_DURATION_MINUTES = 60;
const MAX_SLEEP_PAUSE_MINUTES = 60;
const ACTIVITY_CHANGE_THRESHOLD_MINUTES = 15;
const MAX_TRANSIENT_AWAKE_STAGE_MINUTES = 1;
const MAX_FRAGMENTED_SUMMARY_STAGE_MINUTES = 2;
const STRESS_WINDOW = 120;
const SPO2_WINDOW = 30;
const DEFAULT_TARGET_WAKE_MINUTES = 7 * 60 + 30;
const RECENT_WAKE_INFERENCE_DAYS = 7;
const DASHBOARD_HEART_BUCKET_MINUTES = 5;
const HEART_INTRADAY_BUCKET_MINUTES = 5;

const SHOULD_LOG_MOBILE_PERF =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  (typeof process === 'undefined' || process.env.NODE_ENV !== 'test');

type ActivityKind = 'sleep' | 'active';

interface SensorDataRow {
  ppg_green?: number;
  ppg_red_ir?: number;
  spo2_red?: number;
  spo2_ir?: number;
  skin_temp_raw?: number;
  ambient_light?: number;
  led_drive_1?: number;
  led_drive_2?: number;
  resp_rate_raw?: number;
  signal_quality?: number;
  skin_contact?: number;
  accel_gravity?: [number, number, number];
}

interface HeartRateQueryRow {
  id: number;
  bpm: number;
  time: string;
  rr_intervals: string;
  stress: number | null;
  spo2: number | null;
  skin_temp: number | null;
  sensor_data: string | null;
}

interface HeartRateRecord {
  id: number;
  bpm: number;
  time: string;
  date: Date;
  rr: number[];
  stress: number | null;
  spo2: number | null;
  skinTemp: number | null;
  sensorData: SensorDataRow | null;
  skinContact: number | null;
  gravity: [number, number, number] | null;
  ppgGreen: number | null;
}

interface HeartRateSampleRow {
  bpm: number;
  time: string;
}

interface HeartRateSample {
  bpm: number;
  time: string;
  date: Date;
}

interface WellnessMetricDayAggregateRow {
  day: string;
  avg_stress: number | null;
  avg_spo2: number | null;
  avg_skin_temp: number | null;
}

interface WellnessMetricSummaryRow {
  stress_count: number;
  avg_stress: number | null;
  latest_stress: number | null;
  spo2_count: number;
  avg_spo2: number | null;
  latest_spo2: number | null;
  skin_temp_count: number;
  avg_skin_temp: number | null;
  latest_skin_temp: number | null;
}

interface WellnessDayStatRow {
  day: string;
  stress_count: number;
  avg_stress: number | null;
  spo2_count: number;
  avg_spo2: number | null;
  skin_temp_count: number;
  avg_skin_temp: number | null;
}

interface HeartIntradayBucketRow {
  bucket_start: string;
  sample_count: number;
  avg_bpm: number;
  first_bpm: number;
  second_bpm: number | null;
  penultimate_bpm: number | null;
  last_bpm: number;
  max_triplet_avg: number | null;
}

interface BucketedHeartWindow {
  latestHeartDate: Date | null;
  intradayStart: Date | null;
  rawRowCount: number;
  bucketSamples: HeartRateSample[];
  averageBpm: number | null;
  sustainedPeakBpm: number | null;
}

interface SleepCycleRow {
  id: string;
  sleep_id: string;
  start: string;
  end: string;
  min_bpm: number;
  max_bpm: number;
  avg_bpm: number;
  min_hrv: number;
  max_hrv: number;
  avg_hrv: number;
  avg_skin_temp: number | null;
  score: number | null;
}

interface SleepCycleRecord {
  id: string;
  sleepId: string;
  start: Date;
  end: Date;
  inBedEnd: Date | null;
  minBpm: number;
  maxBpm: number;
  avgBpm: number;
  minHrv: number;
  maxHrv: number;
  avgHrv: number;
  avgSkinTemp: number | null;
  score: number | null;
  asleepMinutes: number | null;
}

interface ActivityRow {
  id: number;
  period_id: string;
  start: string;
  end: string;
  activity: string;
}

interface ActivityRecord {
  id: string;
  periodId: string;
  start: Date;
  end: Date;
  activity: 'Activity' | 'Nap';
}

interface SleepStageRow {
  id: number;
  sleep_id: string;
  start: string;
  end: string;
  stage: SleepStage;
  is_estimated: number;
}

interface SleepStageRecord {
  sleepId: string;
  start: Date;
  end: Date;
  stage: SleepStage;
  isEstimated: boolean;
}

interface SleepStageSummary {
  stages: SleepStageSegment[];
  timeAsleepMinutes: number;
  timeInBedMinutes: number;
  remMinutes: number;
  deepMinutes: number;
  start: Date;
  end: Date;
  inBedEnd: Date;
}

interface DeviceStateRow {
  id: string;
  name: string | null;
  last_seen_at: string | null;
  last_synced_at: string | null;
  firmware: string | null;
  battery_percent: number | null;
  charging_status: string | null;
  body_status: string | null;
  sync_error: string | null;
}

interface SleepPreferenceRow {
  target_wake_minutes: number;
  alarm_enabled: number | null;
}

interface SleepPreferences {
  targetWakeMinutes: number;
  alarmEnabled: boolean;
}

interface DerivedDataStateRow {
  derived_schema_version: number;
  source_heart_count: number;
  refreshed_at: string;
  rebuild_status: 'idle' | 'pending' | 'processing' | 'error';
  pending_from_time: string | null;
  pending_to_time: string | null;
  last_processed_from_time: string | null;
  last_processed_to_time: string | null;
  last_error: string | null;
}

interface TimeRow {
  time: string;
}

interface LatestHeartRow {
  time: string;
  stress: number | null;
}

interface HeartTimeBoundsRow {
  min_time: string | null;
  max_time: string | null;
}

interface NumberRow {
  bpm: number;
}

interface NullableNumberRow {
  value: number | null;
}

interface DailyMinimaRow {
  day: string;
  min_bpm: number;
}

interface HeartDayStatRow {
  day: string;
  min_bpm: number;
  avg_bpm: number;
  max_bpm: number;
  strain_score: number | null;
}

interface HeartDayStatRecord {
  day: string;
  minBpm: number;
  avgBpm: number;
  maxBpm: number;
  strainScore: number | null;
}

interface HeartGlobalStatsRow {
  observed_peak_bpm: number | null;
  latest_heart_time: string | null;
  latest_stress: number | null;
}

interface HeartIntradayBucketStateRow {
  source_heart_count: number;
  source_last_heart_time: string | null;
  refreshed_at: string;
}

interface DashboardSnapshotCacheRow {
  snapshot_json: string;
  snapshot_kind: 'full' | 'post_sync_heart_only';
  built_at: string;
  source_heart_count: number;
  source_last_heart_time: string | null;
  derived_refreshed_at: string | null;
  last_error: string | null;
}

interface DetectedPeriod {
  activity: ActivityKind;
  start: Date;
  end: Date;
  durationMinutes: number;
}

interface PreparedDataBundle {
  heartRows: HeartRateRecord[];
  sleepCycles: SleepCycleRecord[];
  activities: ActivityRecord[];
  sleepStages: SleepStageRecord[];
  deviceState: DeviceStateRow | null;
}

interface HeartMetricUpdate {
  id: number;
  stress: number | null;
  spo2: number | null;
  skinTemp: number | null;
}

interface RollingStressValue {
  id: number;
  value: number;
  bin: number;
}

interface RollingStressOccurrenceQueue {
  ids: number[];
  start: number;
}

interface RollingStressState {
  count: number;
  nextId: number;
  binCounts: Map<number, number>;
  binOccurrences: Map<number, RollingStressOccurrenceQueue>;
  minDeque: RollingStressValue[];
  minStart: number;
  maxDeque: RollingStressValue[];
  maxStart: number;
}

interface RowStressContribution {
  rawRrLength: number;
  rrValues: RollingStressValue[];
  fallbackValue: RollingStressValue | null;
}

type PerformanceLogValue = string | number | boolean | null;

function logMobilePerf(label: string, startedAt: number, details?: Record<string, PerformanceLogValue>) {
  if (!SHOULD_LOG_MOBILE_PERF) {
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  const suffix = details
    ? Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
    : '';
  console.info(`[mobile-perf] ${label} ${elapsedMs}ms${suffix ? ` ${suffix}` : ''}`);
}

function logMobilePerfError(label: string, error: unknown, details?: Record<string, PerformanceLogValue>) {
  if (!SHOULD_LOG_MOBILE_PERF) {
    return;
  }

  const suffix = details
    ? Object.entries(details)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mobile-perf] ${label} error=${message}${suffix ? ` ${suffix}` : ''}`);
}

const aggregateAccessLocks = new WeakMap<object, Promise<void>>();
const HEART_METRIC_UPDATE_BATCH_SIZE = 200;

async function withAggregateAccessLock<T>(db: SQLiteDatabase, callback: () => Promise<T>): Promise<T> {
  const key = db as object;
  const previous = aggregateAccessLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(callback);
  const settled = next.then(
    () => {},
    () => {},
  );

  aggregateAccessLocks.set(key, settled);

  try {
    return await next;
  } finally {
    if (aggregateAccessLocks.get(key) === settled) {
      aggregateAccessLocks.delete(key);
    }
  }
}

async function withAggregateMutationLock<T>(db: SQLiteDatabase, callback: () => Promise<T>): Promise<T> {
  return withAggregateAccessLock(db, callback);
}

async function withAggregateReadLock<T>(db: SQLiteDatabase, callback: () => Promise<T>): Promise<T> {
  return withAggregateAccessLock(db, callback);
}

async function waitForAggregateMutations(db: SQLiteDatabase) {
  const pending = aggregateAccessLocks.get(db as object);
  if (pending) {
    await pending.catch(() => {});
  }
}

function parseRrIntervals(value: string): number[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part > 0);
}

function parseSensorData(value: string | null): SensorDataRow | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as SensorDataRow;
  } catch {
    return null;
  }
}

function toHeartRateRecord(row: HeartRateQueryRow): HeartRateRecord {
  const sensorData = parseSensorData(row.sensor_data);

  return {
    id: row.id,
    bpm: row.bpm,
    time: row.time,
    date: parseSqliteDateTime(row.time),
    rr: parseRrIntervals(row.rr_intervals),
    stress: row.stress,
    spo2: row.spo2,
    skinTemp: row.skin_temp,
    sensorData,
    skinContact: sensorData?.skin_contact ?? null,
    gravity: sensorData?.accel_gravity ?? null,
    ppgGreen: sensorData?.ppg_green ?? null,
  };
}

function toHeartRateSample(row: HeartRateSampleRow): HeartRateSample {
  return {
    bpm: row.bpm,
    time: row.time,
    date: parseSqliteDateTime(row.time),
  };
}

function toSleepCycleRecord(row: SleepCycleRow): SleepCycleRecord {
  return {
    id: row.id,
    sleepId: row.sleep_id,
    start: parseSqliteDateTime(row.start),
    end: parseSqliteDateTime(row.end),
    inBedEnd: null,
    minBpm: row.min_bpm,
    maxBpm: row.max_bpm,
    avgBpm: row.avg_bpm,
    minHrv: row.min_hrv,
    maxHrv: row.max_hrv,
    avgHrv: row.avg_hrv,
    avgSkinTemp: row.avg_skin_temp,
    score: row.score,
    asleepMinutes: null,
  };
}

function toActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: `${row.activity}-${row.start}`,
    periodId: row.period_id,
    start: parseSqliteDateTime(row.start),
    end: parseSqliteDateTime(row.end),
    activity: row.activity === 'Nap' ? 'Nap' : 'Activity',
  };
}

function toHeartDayStatRecord(row: HeartDayStatRow): HeartDayStatRecord {
  return {
    day: row.day,
    minBpm: row.min_bpm,
    avgBpm: row.avg_bpm,
    maxBpm: row.max_bpm,
    strainScore: row.strain_score,
  };
}

function toSleepStageRecord(row: SleepStageRow): SleepStageRecord {
  return {
    sleepId: row.sleep_id,
    start: parseSqliteDateTime(row.start),
    end: parseSqliteDateTime(row.end),
    stage: row.stage,
    isEstimated: row.is_estimated === 1,
  };
}

function greetingForHour(hour: number): string {
  if (hour < 12) {
    return 'Good morning';
  }

  if (hour < 18) {
    return 'Good afternoon';
  }

  return 'Good evening';
}

function rangeDays(range: HistoryRange): number {
  switch (range) {
    case '24h':
      return 1;
    case '7d':
      return 7;
    case '14d':
      return 14;
    case '30d':
      return 30;
  }
}

function relativeDelta(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null || baseline === 0) {
    return null;
  }

  return (current - baseline) / baseline;
}

function rrToRmssd(rr: number[]): number | null {
  if (rr.length < 2) {
    return null;
  }

  const diffs = rr.slice(1).map((value, index) => (value - rr[index]) ** 2);
  return Math.sqrt(mean(diffs));
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function trendValues(points: TrendPoint[]): number[] {
  return points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
}

function buildFilledDailySeries(
  range: HistoryRange,
  endDate: Date,
  valueForDay: (dayKey: string) => number | null,
): TrendPoint[] {
  const end = startOfDay(endDate);
  const days = rangeDays(range);

  return Array.from({ length: days }, (_, index) => {
    const offset = days - 1 - index;
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    return {
      label: formatShortDate(date),
      value: valueForDay(dateKey(date)),
    };
  });
}

function createTimeBuckets<T extends { bpm: number; date: Date }>(
  points: T[],
  bucketMinutes: number,
  startDate?: Date,
  endDate?: Date,
): TrendPoint[] {
  if (points.length === 0) {
    return [];
  }

  const bucketMs = bucketMinutes * 60000;
  const buckets = new Map<number, T[]>();

  for (const point of points) {
    const bucketStart = Math.floor(point.date.getTime() / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart);

    if (bucket) {
      bucket.push(point);
      continue;
    }

    buckets.set(bucketStart, [point]);
  }

  const firstBucket = Math.floor((startDate?.getTime() ?? points[0]!.date.getTime()) / bucketMs) * bucketMs;
  const lastBucket =
    Math.floor((endDate?.getTime() ?? points.at(-1)!.date.getTime()) / bucketMs) * bucketMs;
  const series: TrendPoint[] = [];

  for (let bucketStart = firstBucket; bucketStart <= lastBucket; bucketStart += bucketMs) {
    const bucket = buckets.get(bucketStart);
    const bucketSummary = bucket ? summarizeHeartRows(bucket) : null;
    series.push({
      label: formatAxisTime(new Date(bucketStart)),
      value: bucketSummary ? Math.round(bucketSummary.average) : null,
    });
  }

  return series;
}

function detectFromGravity(history: HeartRateRecord[]): DetectedPeriod[] {
  if (history.length < 2) {
    return [];
  }

  const deltas: number[] = [0];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1].gravity;
    const current = history[index].gravity;

    if (!previous || !current) {
      deltas.push(Number.MAX_VALUE);
      continue;
    }

    const dx = previous[0] - current[0];
    const dy = previous[1] - current[1];
    const dz = previous[2] - current[2];
    deltas.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  const intervals = history
    .slice(1)
    .map((record, index) => (record.date.getTime() - history[index].date.getTime()) / 1000)
    .filter((seconds) => seconds > 0 && seconds < 300)
    .sort((left, right) => left - right);

  const medianInterval = intervals.length === 0 ? 60 : intervals[Math.floor(intervals.length / 2)];
  const windowSize = Math.max(3, Math.floor((GRAVITY_WINDOW_MINUTES * 60) / Math.max(1, medianInterval)));
  const halfWindow = Math.floor(windowSize / 2);
  const stillPrefixCounts = new Array<number>(deltas.length + 1).fill(0);

  for (let index = 0; index < deltas.length; index += 1) {
    stillPrefixCounts[index + 1] = stillPrefixCounts[index] + (deltas[index] < GRAVITY_STILL_THRESHOLD ? 1 : 0);
  }

  const classified = history.map((row, index) => {
    const start = Math.max(0, index - halfWindow);
    const end = Math.min(deltas.length, index + halfWindow + 1);
    const stillCount = stillPrefixCounts[end] - stillPrefixCounts[start];
    return stillCount / Math.max(1, end - start) >= GRAVITY_STILL_FRACTION && row.skinContact !== 0;
  });
  const periods: DetectedPeriod[] = [];
  let runStart = 0;

  for (let index = 1; index <= history.length; index += 1) {
    const endOfData = index === history.length;
    const classChange = !endOfData && classified[index] !== classified[runStart];
    const gapBreak = !endOfData && minutesBetween(history[index - 1].date, history[index].date) > GRAVITY_MAX_GAP_MINUTES;

    if (endOfData || classChange || gapBreak) {
      periods.push({
        activity: classified[runStart] ? 'sleep' : 'active',
        start: history[runStart].date,
        end: history[index - 1].date,
        durationMinutes: minutesBetween(history[runStart].date, history[index - 1].date),
      });

      if (!endOfData) {
        runStart = index;
      }
    }
  }

  return filterAndMergePeriods(periods);
}

function filterAndMergePeriods(periods: DetectedPeriod[]): DetectedPeriod[] {
  if (periods.length === 0) {
    return [];
  }

  const merged: DetectedPeriod[] = [];
  let index = 0;

  while (index < periods.length) {
    const current = periods[index];

    if (current.durationMinutes < ACTIVITY_CHANGE_THRESHOLD_MINUTES) {
      if (index > 0 && index + 1 < periods.length && periods[index - 1].activity === periods[index + 1].activity && merged.length > 0) {
        const previous = merged.pop()!;
        merged.push({
          activity: previous.activity,
          start: previous.start,
          end: periods[index + 1].end,
          durationMinutes: minutesBetween(previous.start, periods[index + 1].end),
        });
        index += 2;
        continue;
      }

      if (index + 1 < periods.length) {
        periods[index + 1] = {
          activity: periods[index + 1].activity,
          start: current.start,
          end: periods[index + 1].end,
          durationMinutes: minutesBetween(current.start, periods[index + 1].end),
        };
        index += 1;
        continue;
      }

      if (merged.length > 0) {
        const previous = merged.pop()!;
        merged.push({
          activity: previous.activity,
          start: previous.start,
          end: current.end,
          durationMinutes: minutesBetween(previous.start, current.end),
        });
      }
    } else {
      merged.push(current);
    }

    index += 1;
  }

  return merged;
}

function mergeNearbySleepPeriods(periods: DetectedPeriod[]): DetectedPeriod[] {
  const sorted = [...periods].sort((left, right) => left.start.getTime() - right.start.getTime());
  const merged: DetectedPeriod[] = [];

  for (const period of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.activity === 'sleep' && minutesBetween(previous.end, period.start) < MAX_SLEEP_PAUSE_MINUTES) {
      previous.end = period.end;
      previous.durationMinutes = minutesBetween(previous.start, previous.end);
      continue;
    }

    merged.push({ ...period });
  }

  return merged;
}

function selectSleepAndNapPeriods(periods: DetectedPeriod[]) {
  const grouped = new Map<string, DetectedPeriod[]>();

  for (const period of periods) {
    const key = dateKey(period.end);
    grouped.set(key, [...(grouped.get(key) ?? []), period]);
  }

  const sleeps: DetectedPeriod[] = [];
  const naps: DetectedPeriod[] = [];

  for (const group of grouped.values()) {
    const longest = [...group].sort((left, right) => right.durationMinutes - left.durationMinutes)[0];

    for (const period of group) {
      if (period.start.getTime() === longest.start.getTime() && period.end.getTime() === longest.end.getTime()) {
        sleeps.push(period);
      } else {
        naps.push(period);
      }
    }
  }

  sleeps.sort((left, right) => left.start.getTime() - right.start.getTime());
  naps.sort((left, right) => left.start.getTime() - right.start.getTime());
  return { sleeps, naps };
}

function rowsInRange<T extends { date: Date }>(rows: T[], start: Date, end: Date): T[] {
  return rows.filter((row) => row.date >= start && row.date <= end);
}

function calculateRollingHrv(rr: number[]): number[] {
  const cleaned = rr.filter((value) => value > 0);
  const values: number[] = [];

  for (let index = 0; index + 300 <= cleaned.length; index += 1) {
    const window = cleaned.slice(index, index + 300);
    const rmssd = rrToRmssd(window);
    if (rmssd !== null) {
      values.push(Math.round(rmssd));
    }
  }

  return values;
}

function summarizeNumbers(values: readonly number[]) {
  if (values.length === 0) {
    return null;
  }

  let min = values[0]!;
  let max = values[0]!;
  let total = 0;

  for (const value of values) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
    total += value;
  }

  return {
    min,
    max,
    average: total / values.length,
  };
}

function summarizeHeartRows<T extends { bpm: number }>(rows: readonly T[]) {
  let min = 0;
  let max = 0;
  let total = 0;
  let count = 0;

  for (const row of rows) {
    const bpm = sanitizeRecordedBpm(row.bpm);
    if (bpm === null) {
      continue;
    }

    if (count === 0) {
      min = bpm;
      max = bpm;
      total = bpm;
      count = 1;
      continue;
    }

    if (bpm < min) {
      min = bpm;
    }
    if (bpm > max) {
      max = bpm;
    }
    total += bpm;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  return {
    min,
    max,
    average: total / count,
  };
}

function buildSleepCycle(period: DetectedPeriod, rows: HeartRateRecord[]): SleepCycleRecord | null {
  const windowRows = rowsInRange(rows, period.start, period.end);
  if (windowRows.length === 0) {
    return null;
  }

  const initialSleepId = dateKey(period.end);
  const initialStageRows = buildSleepStageRows(initialSleepId, windowRows);
  const adjustedEnd = trimTrailingAwakeEnd(initialStageRows, period.end);
  const trimmedRows = filterRowsForSleepEnd(windowRows, adjustedEnd);

  if (trimmedRows.length === 0) {
    return null;
  }

  const rr = trimmedRows.flatMap((row) => row.rr);
  const hrvValues = calculateRollingHrv(rr);
  const tempValues = trimmedRows
    .map((row) => resolvedSkinTemp(row))
    .filter((value): value is number => value !== null);
  const sleepId = dateKey(adjustedEnd);
  const trimmedStageRows = buildSleepStageRows(sleepId, trimmedRows);
  const bpmSummary = summarizeHeartRows(trimmedRows);
  const hrvSummary = summarizeNumbers(hrvValues);

  if (!bpmSummary) {
    return null;
  }

  return {
    id: sleepId,
    sleepId,
    start: period.start,
    end: adjustedEnd,
    inBedEnd: period.end,
    minBpm: bpmSummary.min,
    maxBpm: bpmSummary.max,
    avgBpm: Math.round(bpmSummary.average),
    minHrv: hrvSummary?.min ?? 0,
    maxHrv: hrvSummary?.max ?? 0,
    avgHrv: hrvSummary ? Math.round(hrvSummary.average) : 0,
    avgSkinTemp: tempValues.length > 0 ? mean(tempValues) : null,
    score: null,
    asleepMinutes: trimmedStageRows.length === 0 ? minutesBetween(period.start, adjustedEnd) : calculateTimeAsleepMinutes(trimmedStageRows),
  };
}

function napCreditHours(naps: ActivityRecord[]): number {
  return naps.reduce((sum, nap) => {
    const minutes = minutesBetween(nap.start, nap.end);
    const fullCredit = Math.min(minutes, 90);
    const overflow = Math.max(0, minutes - 90);
    return sum + (fullCredit * 0.7 + overflow * 0.3) / 60;
  }, 0);
}

function scoreSleepCycles(sleeps: SleepCycleRecord[], naps: ActivityRecord[]): SleepCycleRecord[] {
  const scored: SleepCycleRecord[] = [];

  for (const sleep of sleeps) {
    const recentNaps = naps.filter((nap) => nap.activity === 'Nap' && nap.start >= new Date((scored.at(-1)?.end ?? new Date(sleep.start.getTime() - 86400000)).getTime()) && nap.end <= sleep.start);
    const needMinutes = calculateSleepNeedMinutes(
      scored.map((priorSleep) => priorSleep.asleepMinutes ?? minutesBetween(priorSleep.start, priorSleep.end)),
    );
    const effectiveSleepMinutes = (sleep.asleepMinutes ?? minutesBetween(sleep.start, sleep.end)) + Math.round(napCreditHours(recentNaps) * 60);
    scored.push({
      ...sleep,
      score: clamp((effectiveSleepMinutes / needMinutes) * 100, 0, 100),
    });
  }

  return scored;
}

function minutesForClock(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function inferTargetWakeMinutes(sleeps: SleepCycleRecord[]) {
  const wakeTimes = sleeps.slice(-RECENT_WAKE_INFERENCE_DAYS).map((sleep) => minutesForClock(sleep.end));
  if (wakeTimes.length === 0) {
    return DEFAULT_TARGET_WAKE_MINUTES;
  }

  return roundClockMinutes(mean(wakeTimes), SLEEP_TARGET_STEP_MINUTES);
}

async function loadSleepPreferences(db: SQLiteDatabase, sleeps: SleepCycleRecord[]): Promise<SleepPreferences> {
  const row = await db.getFirstAsync<SleepPreferenceRow>(
    'SELECT target_wake_minutes, alarm_enabled FROM sleep_preferences WHERE id = 1 LIMIT 1',
  );

  const targetWakeMinutes = row
    ? roundClockMinutes(row.target_wake_minutes, SLEEP_TARGET_STEP_MINUTES)
    : inferTargetWakeMinutes(sleeps);

  return {
    targetWakeMinutes,
    alarmEnabled: row?.alarm_enabled === 1,
  };
}

async function persistSleepPreferences(db: SQLiteDatabase, preferences: SleepPreferences) {
  await db.runAsync(
    `
      INSERT INTO sleep_preferences (id, target_wake_minutes, alarm_enabled, alarm_minutes, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_wake_minutes = excluded.target_wake_minutes,
        alarm_enabled = excluded.alarm_enabled,
        alarm_minutes = excluded.alarm_minutes,
        updated_at = excluded.updated_at
    `,
    preferences.targetWakeMinutes,
    preferences.alarmEnabled ? 1 : 0,
    preferences.targetWakeMinutes,
    formatSqliteDateTime(new Date()),
  );
}

function buildSleepPlanSnapshot(
  preferences: SleepPreferences,
  sleeps: SleepCycleRecord[],
  activities: ActivityRecord[],
  now = new Date(),
): SleepPlanSnapshot {
  const latestSleep = sleeps.at(-1) ?? null;
  const recentSleepDurations = sleeps.map((sleep) => sleep.asleepMinutes ?? minutesBetween(sleep.start, sleep.end));
  const rawSleepDebtMinutes = calculateSleepDebtMinutes(recentSleepDurations);
  const napWindowStart = latestSleep?.end ?? new Date(now.getTime() - 24 * 3600000);
  const napCreditMinutes = Math.round(
    napCreditHours(
      activities.filter(
        (activity) => activity.activity === 'Nap' && activity.start >= napWindowStart && activity.end <= now,
      ),
    ) * 60,
  );
  const sleepDebtMinutes = applyNapCreditToSleepDebt(rawSleepDebtMinutes, napCreditMinutes);
  const sleepNeedMinutes = BASE_SLEEP_NEED_MINUTES + sleepDebtMinutes;
  const optimalBedtimeMinutes = calculateOptimalBedtimeMinutes(preferences.targetWakeMinutes, sleepNeedMinutes);

  return {
    targetWakeMinutes: preferences.targetWakeMinutes,
    targetWakeTime: formatClockMinutes(preferences.targetWakeMinutes),
    optimalBedtimeMinutes,
    optimalBedtime: formatClockMinutes(optimalBedtimeMinutes),
    sleepNeedMinutes,
    sleepDebtMinutes,
    napCreditMinutes,
    alarmEnabled: preferences.alarmEnabled,
  };
}

function buildStageSegments(sleep: SleepCycleRecord, rows: HeartRateRecord[]): SleepStageRecord[] {
  return buildSleepStageRows(sleep.sleepId, rowsInRange(rows, sleep.start, sleep.inBedEnd ?? sleep.end));
}

function filterRowsForSleepEnd(rows: readonly HeartRateRecord[], sleepEnd: Date) {
  const sleepEndMs = sleepEnd.getTime();

  return rows.filter((row) => {
    const rowTime = row.date.getTime();

    if (rowTime < sleepEndMs) {
      return true;
    }

    if (rowTime > sleepEndMs) {
      return false;
    }

    return row.ppgGreen === null || !isAwakePpgValue(row.ppgGreen);
  });
}

function exactMinutesBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 60000);
}

function buildSleepStageRows(sleepId: string, rows: readonly HeartRateRecord[]): SleepStageRecord[] {
  return generateSleepStageRecords(rows.map((row) => ({
    date: row.date,
    bpm: row.bpm,
    rr: row.rr,
    ppgGreen: row.ppgGreen,
    gravity: row.gravity,
    skinContact: row.skinContact,
    signalQuality: row.sensorData?.signal_quality ?? null,
  }))).map((record) => ({
    sleepId,
    start: record.start,
    end: record.end,
    stage: record.stage,
    isEstimated: record.isEstimated,
  }));
}

function trimTrailingAwakeEnd(records: readonly SleepStageRecord[], fallbackEnd: Date): Date {
  if (records.length === 0) {
    return fallbackEnd;
  }

  let trailingAwakeMinutes = 0;
  let trailingAwakeStart: Date | null = null;
  let index = records.length - 1;

  while (index >= 0 && records[index].stage === 'awake') {
    trailingAwakeMinutes += exactMinutesBetween(records[index].start, records[index].end);
    trailingAwakeStart = records[index].start;
    index -= 1;
  }

  if (trailingAwakeStart && trailingAwakeMinutes >= ACTIVITY_CHANGE_THRESHOLD_MINUTES && index >= 0) {
    return trailingAwakeStart;
  }

  return fallbackEnd;
}

function calculateTimeAsleepMinutes(records: readonly SleepStageRecord[]): number {
  const totalMinutes = records.reduce((sum, record) => (
    record.stage === 'awake'
      ? sum
      : sum + exactMinutesBetween(record.start, record.end)
  ), 0);

  return Math.max(0, Math.round(totalMinutes));
}

function buildActivityRecords(periods: DetectedPeriod[], sleeps: SleepCycleRecord[]): ActivityRecord[] {
  return periods
    .filter((period) => period.activity === 'active' && period.durationMinutes >= ACTIVITY_CHANGE_THRESHOLD_MINUTES)
    .filter((period) => !sleeps.some((sleep) => period.start <= sleep.end && period.end >= sleep.start))
    .map((period) => ({
      id: `activity-${period.start.toISOString()}`,
      periodId: dateKey(period.end),
      start: period.start,
      end: period.end,
      activity: 'Activity' as const,
    }));
}

function buildNapActivities(periods: DetectedPeriod[]): ActivityRecord[] {
  return periods.map((period) => ({
    id: `nap-${period.start.toISOString()}`,
    periodId: dateKey(period.end),
    start: period.start,
    end: period.end,
    activity: 'Nap' as const,
  }));
}

function sampleDurationMinutes<T extends { date: Date }>(rows: T[]): number {
  if (rows.length < 2) {
    return 1 / 60;
  }

  const durationMs = rows[1].date.getTime() - rows[0].date.getTime();
  return durationMs <= 0 ? 1 / 60 : durationMs / 60000;
}

function zoneWeight(bpm: number, restingHr: number, hrReserve: number): number {
  const pct = ((bpm - restingHr) / hrReserve) * 100;

  if (pct >= 90) {
    return 5;
  }
  if (pct >= 80) {
    return 4;
  }
  if (pct >= 70) {
    return 3;
  }
  if (pct >= 60) {
    return 2;
  }
  if (pct >= 50) {
    return 1;
  }

  return 0;
}

function calculateStrain<T extends { bpm: number; date: Date }>(rows: T[], maxHr: number, restingHr: number): number | null {
  if (rows.length < 600 || maxHr <= restingHr) {
    return null;
  }

  const duration = sampleDurationMinutes(rows);
  const reserve = maxHr - restingHr;
  const trimp = rows.reduce((sum, row) => sum + duration * zoneWeight(row.bpm, restingHr, reserve), 0);

  if (trimp <= 0) {
    return 0;
  }

  return Math.round((21 * Math.log(trimp + 1) / Math.log(7201)) * 100) / 100;
}

function estimateCalories<T extends { bpm: number; date: Date }>(rows: T[], maxHr: number, restingHr: number): number | null {
  if (rows.length < 2 || maxHr <= restingHr) {
    return null;
  }

  const metByZone = [1.8, 4, 6, 8.5, 10.5, 12];
  const duration = sampleDurationMinutes(rows);
  const reserve = maxHr - restingHr;

  const calories = rows.reduce((sum, row) => {
    const zone = zoneWeight(row.bpm, restingHr, reserve);
    const met = metByZone[zone];
    return sum + met * 3.5 * 75 / 200 * duration;
  }, 0);

  return Math.round(calories);
}

function createRollingStressState(): RollingStressState {
  return {
    count: 0,
    nextId: 0,
    binCounts: new Map<number, number>(),
    binOccurrences: new Map<number, RollingStressOccurrenceQueue>(),
    minDeque: [],
    minStart: 0,
    maxDeque: [],
    maxStart: 0,
  };
}

function compactRollingStressDeque(state: RollingStressState, key: 'minDeque' | 'maxDeque', startKey: 'minStart' | 'maxStart') {
  if (state[startKey] > 64 && state[startKey] * 2 >= state[key].length) {
    state[key] = state[key].slice(state[startKey]);
    state[startKey] = 0;
  }
}

function compactRollingStressOccurrenceQueue(queue: RollingStressOccurrenceQueue) {
  if (queue.start > 64 && queue.start * 2 >= queue.ids.length) {
    queue.ids = queue.ids.slice(queue.start);
    queue.start = 0;
  }
}

function appendRollingStressValue(state: RollingStressState, value: number): RollingStressValue {
  const ref = {
    id: state.nextId,
    value,
    bin: Math.floor(value / 50),
  };
  state.nextId += 1;
  state.count += 1;

  while (state.minDeque.length > state.minStart && state.minDeque[state.minDeque.length - 1]!.value > value) {
    state.minDeque.pop();
  }
  state.minDeque.push(ref);

  while (state.maxDeque.length > state.maxStart && state.maxDeque[state.maxDeque.length - 1]!.value < value) {
    state.maxDeque.pop();
  }
  state.maxDeque.push(ref);

  state.binCounts.set(ref.bin, (state.binCounts.get(ref.bin) ?? 0) + 1);
  const occurrences = state.binOccurrences.get(ref.bin) ?? {
    ids: [],
    start: 0,
  };
  occurrences.ids.push(ref.id);
  state.binOccurrences.set(ref.bin, occurrences);

  return ref;
}

function removeRollingStressValue(state: RollingStressState, ref: RollingStressValue) {
  state.count -= 1;

  const nextBinCount = (state.binCounts.get(ref.bin) ?? 0) - 1;
  if (nextBinCount <= 0) {
    state.binCounts.delete(ref.bin);
  } else {
    state.binCounts.set(ref.bin, nextBinCount);
  }

  const occurrences = state.binOccurrences.get(ref.bin);
  if (occurrences) {
    while (occurrences.start < occurrences.ids.length && occurrences.ids[occurrences.start]! < ref.id) {
      occurrences.start += 1;
    }
    if (occurrences.start < occurrences.ids.length && occurrences.ids[occurrences.start] === ref.id) {
      occurrences.start += 1;
    }

    if (occurrences.start >= occurrences.ids.length) {
      state.binOccurrences.delete(ref.bin);
    } else {
      compactRollingStressOccurrenceQueue(occurrences);
    }
  }

  if (state.minStart < state.minDeque.length && state.minDeque[state.minStart]!.id === ref.id) {
    state.minStart += 1;
    compactRollingStressDeque(state, 'minDeque', 'minStart');
  }

  if (state.maxStart < state.maxDeque.length && state.maxDeque[state.maxStart]!.id === ref.id) {
    state.maxStart += 1;
    compactRollingStressDeque(state, 'maxDeque', 'maxStart');
  }
}

function resolveRollingStressMode(state: RollingStressState) {
  let modeBin = 0;
  let modeFreq = 0;
  let modeReachedAt = Number.POSITIVE_INFINITY;

  for (const [bin, frequency] of state.binCounts) {
    if (frequency <= 0) {
      continue;
    }

    const occurrences = state.binOccurrences.get(bin);
    if (!occurrences) {
      continue;
    }

    const reachedAt = occurrences.ids[occurrences.start + frequency - 1] ?? Number.POSITIVE_INFINITY;
    if (frequency > modeFreq || (frequency === modeFreq && reachedAt < modeReachedAt)) {
      modeBin = bin;
      modeFreq = frequency;
      modeReachedAt = reachedAt;
    }
  }

  return {
    modeBin,
    modeFreq,
  };
}

function calculateStressScoreFromRollingState(state: RollingStressState): number | null {
  if (state.count < STRESS_WINDOW) {
    return null;
  }

  const min = state.minDeque[state.minStart]?.value;
  const max = state.maxDeque[state.maxStart]?.value;
  if (min === undefined || max === undefined) {
    return null;
  }

  const variabilityRange = (max - min) / 1000;
  if (variabilityRange < 0.0001) {
    return 10;
  }

  const { modeBin, modeFreq } = resolveRollingStressMode(state);
  const mode = modeBin * 50 + 25;
  const aMode = modeFreq / state.count * 100;
  return Math.min(10, Math.round((aMode / (2 * variabilityRange * mode / 1000)) * 100) / 100);
}

function calculateStressScoreForRange(
  heartRows: HeartRateRecord[],
  startIndex: number,
  endIndex: number,
): number | null {
  if (endIndex - startIndex < STRESS_WINDOW) {
    return null;
  }

  const rrState = createRollingStressState();
  const fallbackState = createRollingStressState();
  let realRrLength = 0;

  for (let index = startIndex; index < endIndex; index += 1) {
    const row = heartRows[index];
    realRrLength += row.rr.length;

    for (const value of row.rr) {
      if (value > 0) {
        appendRollingStressValue(rrState, value);
      }
    }

    const fallbackValue = Math.round((60 / row.bpm) * 1000);
    if (fallbackValue > 0) {
      appendRollingStressValue(fallbackState, fallbackValue);
    }
  }

  return realRrLength >= STRESS_WINDOW
    ? calculateStressScoreFromRollingState(rrState)
    : calculateStressScoreFromRollingState(fallbackState);
}

function calculateStressScore(window: HeartRateRecord[]): number | null {
  return calculateStressScoreForRange(window, 0, window.length);
}

function calculateSpo2ScoreFromState(
  windowLength: number,
  validCount: number,
  sumRed: number,
  sumRedSquares: number,
  sumIr: number,
  sumIrSquares: number,
): number | null {
  if (windowLength < SPO2_WINDOW || validCount < SPO2_WINDOW) {
    return null;
  }

  const meanRed = sumRed / validCount;
  const meanIr = sumIr / validCount;
  if (meanRed < 1 || meanIr < 1) {
    return null;
  }

  const redVariance = Math.max(0, sumRedSquares / validCount - meanRed * meanRed);
  const irVariance = Math.max(0, sumIrSquares / validCount - meanIr * meanIr);
  const acRed = Math.sqrt(redVariance);
  const acIr = Math.sqrt(irVariance);
  if (acRed < 0.001 || acIr < 0.001) {
    return null;
  }

  const ratio = (acRed / meanRed) / (acIr / meanIr);
  return clamp(110 - 25 * ratio, 70, 100);
}

function calculateSpo2Score(window: HeartRateRecord[]): number | null {
  if (window.length < SPO2_WINDOW) {
    return null;
  }

  let validCount = 0;
  let sumRed = 0;
  let sumRedSquares = 0;
  let sumIr = 0;
  let sumIrSquares = 0;

  for (const row of window) {
    const red = row.sensorData?.spo2_red ?? 0;
    const ir = row.sensorData?.spo2_ir ?? 0;
    if (red <= 0 || ir <= 0) {
      continue;
    }

    validCount += 1;
    sumRed += red;
    sumRedSquares += red * red;
    sumIr += ir;
    sumIrSquares += ir * ir;
  }

  return calculateSpo2ScoreFromState(
    window.length,
    validCount,
    sumRed,
    sumRedSquares,
    sumIr,
    sumIrSquares,
  );
}

function calculateSkinTempValue(row: HeartRateRecord): number | null {
  const raw = row.sensorData?.skin_temp_raw ?? 0;
  if (raw < 100) {
    return null;
  }

  return raw * 0.04;
}

function resolvedSkinTemp(row: HeartRateRecord): number | null {
  return row.skinTemp ?? calculateSkinTempValue(row);
}

function personalizeRestingHr(sleeps: SleepCycleRecord[], dailyMinima: number[]): number {
  const lastFourteen = sleeps
    .slice(-14)
    .map((sleep) => sanitizeRecordedBpm(sleep.minBpm))
    .filter((value): value is number => value !== null);
  const sleepMedian = median(lastFourteen);
  if (sleepMedian !== null) {
    return Math.round(sleepMedian);
  }

  const latestSleep = sleeps.at(-1);
  const latestSleepMinBpm = latestSleep ? sanitizeRecordedBpm(latestSleep.minBpm) : null;
  if (latestSleepMinBpm !== null) {
    return latestSleepMinBpm;
  }

  const dailyMedian = median(filterPlausibleRecordedBpms(dailyMinima));
  return dailyMedian === null ? 50 : Math.round(dailyMedian);
}

function personalizeMaxHr(bpms: number[], restingHr: number): number {
  const observed = (sustainedPeakBpm(filterPlausibleRecordedBpms(bpms)) ?? 175) + 5;
  return clamp(Math.max(observed, restingHr + 100), 180, 205);
}

function personalizeMaxHrFromObservedPeak(observedPeakBpm: number | null, restingHr: number): number {
  const observed = (sanitizeRecordedBpm(observedPeakBpm) ?? 175) + 5;
  return clamp(Math.max(observed, restingHr + 100), 180, 205);
}

function buildEmptyDashboardSnapshot(now: Date, deviceState: DeviceStateRow | null): DashboardSnapshot {
  return {
    greeting: greetingForHour(now.getHours()),
    dateLabel: formatLongDate(now),
    recovery: {
      score: null,
      label: 'Waiting',
      caption: 'Recovery',
      isEstimated: true,
      missingReason: NO_HISTORY_REASON,
    },
    summaryStats: [
      { label: 'HRV', value: '-- ms', accent: 'green', missingReason: NO_HISTORY_REASON },
      { label: 'RHR', value: '-- bpm', accent: 'cyan', missingReason: NO_HISTORY_REASON },
      { label: 'Sleep', value: '--', accent: 'violet', missingReason: NO_SLEEP_REASON },
    ],
    heartCard: {
      restingHr: null,
      averageHr: null,
      maxHr: null,
      series: [],
      missingReason: NO_HISTORY_REASON,
    },
    sleepCard: {
      score: null,
      durationMinutes: null,
      timeInBedMinutes: null,
      stages: [],
      startLabel: '--',
      middleLabel: '--',
      endLabel: '--',
      isEstimated: true,
      missingReason: NO_SLEEP_REASON,
    },
    strainCard: {
      score: null,
      label: 'Waiting',
      series: [],
      isEstimated: true,
      missingReason: NO_HISTORY_REASON,
    },
    lastSyncLabel: deviceState?.last_synced_at ?? 'Local seed loaded',
  };
}

function dashboardSyncLabel(deviceState: DeviceStateRow | null): string {
  return deviceState?.last_synced_at
    ? `Last sync ${formatClock(parseSqliteDateTime(deviceState.last_synced_at))}`
    : 'Local seed loaded';
}

function groupByDay<T extends { date: Date }>(rows: T[]): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = dateKey(row.date);
    const current = grouped.get(key);
    if (current) {
      current.push(row);
      continue;
    }

    grouped.set(key, [row]);
  }
  return [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

function estimateRecoveryScore(
  latestSleep: SleepCycleRecord | null,
  sleeps: SleepCycleRecord[],
  heartRows: HeartRateRecord[],
): { score: number | null; breakdown: RecoveryBreakdown; isEstimated: boolean; missingReason?: string } {
  if (heartRows.length === 0) {
    return {
      score: null,
      isEstimated: true,
      missingReason: NO_HISTORY_REASON,
      breakdown: {
        sleepScore: null,
        hrvComponent: null,
        rhrComponent: null,
        stressComponent: null,
        tempComponent: null,
      },
    };
  }

  const priorSleeps = sleeps.slice(-15, -1);
  const hrvBaseline = median(priorSleeps.map((sleep) => sleep.avgHrv).filter((value) => value > 0));
  const rhrBaseline = median(
    priorSleeps
      .map((sleep) => sanitizeRecordedBpm(sleep.minBpm))
      .filter((value): value is number => value !== null),
  );
  const tempBaseline = median(
    priorSleeps
      .map((sleep) => averageTemperatureForRange(heartRows, sleep.start, sleep.end))
      .filter((value): value is number => value !== null),
  );

  const latestStress = latestValue(heartRows.map((row) => row.stress).filter((value): value is number => value !== null));
  const latestTemp = latestSleep ? averageTemperatureForRange(heartRows, latestSleep.start, latestSleep.end) : null;
  const tempDelta = latestTemp !== null && tempBaseline !== null ? latestTemp - tempBaseline : null;

  const breakdown: RecoveryBreakdown = {
    sleepScore: latestSleep?.score ?? null,
    hrvComponent: relativeDelta(latestSleep?.avgHrv ?? null, hrvBaseline),
    rhrComponent: relativeDelta(latestSleep ? sanitizeRecordedBpm(latestSleep.minBpm) : null, rhrBaseline),
    stressComponent: latestStress !== null ? clamp(100 - latestStress * 10, 0, 100) : null,
    tempComponent: tempDelta !== null ? clamp(100 - Math.abs(tempDelta) * 50, 0, 100) : null,
  };

  const weighted: Array<[number, number]> = [];

  if (breakdown.sleepScore !== null) {
    weighted.push([breakdown.sleepScore, 0.35]);
  }
  if (breakdown.hrvComponent !== null) {
    weighted.push([clamp(70 + breakdown.hrvComponent * 100, 0, 100), 0.25]);
  }
  if (breakdown.rhrComponent !== null) {
    weighted.push([clamp(70 - breakdown.rhrComponent * 100, 0, 100), 0.2]);
  }
  if (breakdown.stressComponent !== null) {
    weighted.push([breakdown.stressComponent, 0.1]);
  }
  if (breakdown.tempComponent !== null) {
    weighted.push([breakdown.tempComponent, 0.1]);
  }

  if (weighted.length === 0) {
    return {
      score: null,
      isEstimated: true,
      missingReason: NO_SLEEP_REASON,
      breakdown,
    };
  }

  const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  const score = weighted.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;

  return {
    score: Math.round(score),
    isEstimated: true,
    breakdown,
  };
}

function averageTemperatureForRange(rows: HeartRateRecord[], start: Date, end: Date): number | null {
  const values = rowsInRange(rows, start, end)
    .map((row) => resolvedSkinTemp(row))
    .filter((value): value is number => value !== null);

  return values.length === 0 ? null : mean(values);
}

function latestValue(values: number[]): number | null {
  return values.length === 0 ? null : values.at(-1) ?? null;
}

function estimateRecoveryScoreFromSleeps(
  latestSleep: SleepCycleRecord | null,
  sleeps: SleepCycleRecord[],
  latestStress: number | null,
): { score: number | null; breakdown: RecoveryBreakdown; isEstimated: boolean; missingReason?: string } {
  const priorSleeps = sleeps.slice(-15, -1);
  const hrvBaseline = median(priorSleeps.map((sleep) => sleep.avgHrv).filter((value) => value > 0));
  const rhrBaseline = median(
    priorSleeps
      .map((sleep) => sanitizeRecordedBpm(sleep.minBpm))
      .filter((value): value is number => value !== null),
  );
  const tempBaseline = median(
    priorSleeps
      .map((sleep) => sleep.avgSkinTemp)
      .filter((value): value is number => value !== null),
  );
  const latestTemp = latestSleep?.avgSkinTemp ?? null;
  const tempDelta = latestTemp !== null && tempBaseline !== null ? latestTemp - tempBaseline : null;

  const breakdown: RecoveryBreakdown = {
    sleepScore: latestSleep?.score ?? null,
    hrvComponent: relativeDelta(latestSleep?.avgHrv ?? null, hrvBaseline),
    rhrComponent: relativeDelta(latestSleep ? sanitizeRecordedBpm(latestSleep.minBpm) : null, rhrBaseline),
    stressComponent: latestStress !== null ? clamp(100 - latestStress * 10, 0, 100) : null,
    tempComponent: tempDelta !== null ? clamp(100 - Math.abs(tempDelta) * 50, 0, 100) : null,
  };

  const weighted: Array<[number, number]> = [];

  if (breakdown.sleepScore !== null) {
    weighted.push([breakdown.sleepScore, 0.35]);
  }
  if (breakdown.hrvComponent !== null) {
    weighted.push([clamp(70 + breakdown.hrvComponent * 100, 0, 100), 0.25]);
  }
  if (breakdown.rhrComponent !== null) {
    weighted.push([clamp(70 - breakdown.rhrComponent * 100, 0, 100), 0.2]);
  }
  if (breakdown.stressComponent !== null) {
    weighted.push([breakdown.stressComponent, 0.1]);
  }
  if (breakdown.tempComponent !== null) {
    weighted.push([breakdown.tempComponent, 0.1]);
  }

  if (weighted.length === 0) {
    return {
      score: null,
      isEstimated: true,
      missingReason: NO_SLEEP_REASON,
      breakdown,
    };
  }

  const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  const score = weighted.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;

  return {
    score: Math.round(score),
    isEstimated: true,
    breakdown,
  };
}

function buildHeartDayStatsFromRows<T extends { bpm: number; date: Date }>(
  heartRows: T[],
  restingHr: number,
  maxHr: number,
): HeartDayStatRecord[] {
  return groupByDay(heartRows).flatMap(([day, rows]) => {
    const validRows = rows.filter((row) => sanitizeRecordedBpm(row.bpm) !== null);
    const summary = summarizeHeartRows(validRows);
    if (!summary) {
      return [];
    }

    return [{
      day,
      minBpm: summary.min,
      avgBpm: summary.average,
      maxBpm: summary.max,
      strainScore: calculateStrain(validRows, maxHr, restingHr),
    }];
  });
}

function buildDailyTrend<T extends { date: Date }>(range: HistoryRange, rows: T[], accessor: (rows: T[]) => number | null): TrendPoint[] {
  if (rows.length === 0) {
    return [];
  }

  const grouped = new Map(groupByDay(rows));
  const endDate = rows.at(-1)?.date ?? new Date();

  return buildFilledDailySeries(range, endDate, (day) => {
    const items = grouped.get(day);
    return items ? accessor(items) : null;
  });
}

function buildWellnessMetricSeries(options: {
  title: string;
  unit: string;
  accent: MetricSeries['accent'];
  detail: string;
  digits?: number;
  endDate: Date;
  range: HistoryRange;
  latest: number | null;
  average: number | null;
  count: number;
  recentValues: readonly number[];
  valuesByDay: ReadonlyMap<string, number | null>;
}): MetricSeries {
  const digits = options.digits ?? 0;
  const baseline = options.recentValues.length < 2 ? null : options.recentValues.at(-1) ?? null;
  const delta = options.latest === null || baseline === null ? null : options.latest - baseline;

  return {
    title: options.title,
    latest: options.latest === null ? null : Number(options.latest.toFixed(digits)),
    average: options.average === null ? null : Number(options.average.toFixed(digits)),
    delta: delta === null ? null : Number(delta.toFixed(digits)),
    unit: options.unit,
    detail: options.latest === null ? LIMITED_SENSOR_REASON : options.detail,
    accent: options.accent,
    hasPartialData: options.count < 14,
    series: buildFilledDailySeries(options.range, options.endDate, (day) => options.valuesByDay.get(day) ?? null),
    isEstimated: false,
    missingReason: options.latest === null ? LIMITED_SENSOR_REASON : null,
  };
}

function isTransientAwakeStage(records: readonly SleepStageRecord[], index: number) {
  const record = records[index];
  if (!record || record.stage !== 'awake') {
    return false;
  }

  const previous = records[index - 1];
  const next = records[index + 1];
  if (!previous || !next || previous.stage === 'awake' || next.stage === 'awake') {
    return false;
  }

  if (previous.stage !== next.stage) {
    return false;
  }

  return exactMinutesBetween(record.start, record.end) <= MAX_TRANSIENT_AWAKE_STAGE_MINUTES;
}

function mergeAdjacentSleepStageSummaries(
  segments: readonly { stage: SleepStage; exactMinutes: number }[],
) {
  const merged: Array<{ stage: SleepStage; exactMinutes: number }> = [];

  for (const segment of segments) {
    if (segment.exactMinutes <= 0) {
      continue;
    }

    const previous = merged.at(-1);
    if (previous?.stage === segment.stage) {
      previous.exactMinutes += segment.exactMinutes;
      continue;
    }

    merged.push({
      stage: segment.stage,
      exactMinutes: segment.exactMinutes,
    });
  }

  return merged;
}

function chooseSummaryStageAbsorptionTarget(
  segments: readonly { stage: SleepStage; exactMinutes: number }[],
  previousIndex: number | null,
  nextIndex: number | null,
) {
  if (previousIndex === null) {
    return nextIndex;
  }

  if (nextIndex === null) {
    return previousIndex;
  }

  const previous = segments[previousIndex];
  const next = segments[nextIndex];
  if (previous.stage === next.stage) {
    return previousIndex;
  }

  if (previous.stage === 'awake' && next.stage !== 'awake') {
    return nextIndex;
  }

  if (next.stage === 'awake' && previous.stage !== 'awake') {
    return previousIndex;
  }

  return next.exactMinutes > previous.exactMinutes ? nextIndex : previousIndex;
}

function simplifySleepStageSummaries(
  segments: readonly { stage: SleepStage; exactMinutes: number }[],
) {
  const simplified = segments.map((segment) => ({
    stage: segment.stage,
    exactMinutes: segment.exactMinutes,
  }));

  for (let index = 0; index < simplified.length; index += 1) {
    const segment = simplified[index];
    if (segment.exactMinutes <= 0 || segment.exactMinutes > MAX_FRAGMENTED_SUMMARY_STAGE_MINUTES) {
      continue;
    }

    let previousIndex: number | null = null;
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      if (simplified[candidate].exactMinutes > 0) {
        previousIndex = candidate;
        break;
      }
    }

    let nextIndex: number | null = null;
    for (let candidate = index + 1; candidate < simplified.length; candidate += 1) {
      if (simplified[candidate].exactMinutes > 0) {
        nextIndex = candidate;
        break;
      }
    }

    const targetIndex = chooseSummaryStageAbsorptionTarget(simplified, previousIndex, nextIndex);
    if (targetIndex === null) {
      continue;
    }

    simplified[targetIndex].exactMinutes += segment.exactMinutes;
    segment.exactMinutes = 0;
  }

  return mergeAdjacentSleepStageSummaries(simplified);
}

function aggregateSleepStages(records: SleepStageRecord[]): SleepStageSegment[] {
  const merged: Array<{ stage: SleepStage; exactMinutes: number }> = [];

  for (let index = 0; index < records.length; index += 1) {
    if (isTransientAwakeStage(records, index)) {
      continue;
    }

    const record = records[index];
    const exactMinutes = exactMinutesBetween(record.start, record.end);
    if (exactMinutes <= 0) {
      continue;
    }

    const previous = merged.at(-1);
    if (previous?.stage === record.stage) {
      previous.exactMinutes += exactMinutes;
      continue;
    }

    merged.push({
      stage: record.stage,
      exactMinutes,
    });
  }

  return simplifySleepStageSummaries(merged).map((segment) => ({
    stage: segment.stage,
    minutes: Math.max(1, Math.round(segment.exactMinutes)),
  }));
}

function summarizeSleepStages(
  records: readonly SleepStageRecord[],
  start: Date,
  end: Date,
): SleepStageSummary {
  const inBedEnd = records.at(-1)?.end ?? end;
  const sleepEnd = trimTrailingAwakeEnd(records, inBedEnd);
  const visibleRecords = records.filter((record) => record.start.getTime() < sleepEnd.getTime());
  const stages = aggregateSleepStages([...visibleRecords]);
  const timeInBedMinutes = Math.max(0, Math.round(exactMinutesBetween(start, inBedEnd)));

  if (records.length === 0) {
    return {
      stages,
      timeAsleepMinutes: timeInBedMinutes,
      timeInBedMinutes,
      remMinutes: 0,
      deepMinutes: 0,
      start,
      end,
      inBedEnd,
    };
  }

  const timeAsleepMinutes = Math.min(timeInBedMinutes, calculateTimeAsleepMinutes(visibleRecords));
  const remMinutes = Math.round(
    visibleRecords.reduce((sum, record) => (
      record.stage === 'rem' ? sum + exactMinutesBetween(record.start, record.end) : sum
    ), 0),
  );
  const deepMinutes = Math.round(
    visibleRecords.reduce((sum, record) => (
      record.stage === 'deep' ? sum + exactMinutesBetween(record.start, record.end) : sum
    ), 0),
  );

  return {
    stages,
    timeAsleepMinutes,
    timeInBedMinutes,
    remMinutes,
    deepMinutes,
    start,
    end: sleepEnd,
    inBedEnd,
  };
}

function axisLabelForMidpoint(start: Date, end: Date): string {
  return formatAxisTime(new Date((start.getTime() + end.getTime()) / 2));
}

async function loadPreparedData(db: SQLiteDatabase): Promise<PreparedDataBundle> {
  const [heartRows, sleepRows, activityRows, stageRows, deviceRows] = await Promise.all([
    db.getAllAsync<HeartRateQueryRow>('SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data FROM heart_rate ORDER BY time ASC'),
    db.getAllAsync<SleepCycleRow>('SELECT id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, avg_skin_temp, score FROM sleep_cycles ORDER BY start ASC'),
    db.getAllAsync<ActivityRow>('SELECT id, period_id, start, end, activity FROM activities ORDER BY start ASC'),
    db.getAllAsync<SleepStageRow>('SELECT id, sleep_id, start, end, stage, is_estimated FROM sleep_stage_segments ORDER BY start ASC'),
    db.getAllAsync<DeviceStateRow>('SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, charging_status, body_status, sync_error FROM device_state ORDER BY last_synced_at DESC LIMIT 1'),
  ]);

  return {
    heartRows: heartRows.map(toHeartRateRecord),
    sleepCycles: sleepRows.map(toSleepCycleRecord),
    activities: activityRows.map(toActivityRecord),
    sleepStages: stageRows.map(toSleepStageRecord),
    deviceState: deviceRows[0] ?? null,
  };
}

function buildInClause(values: readonly string[]) {
  return values.map(() => '?').join(', ');
}

async function queryHeartRows(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<HeartRateQueryRow>(sql, ...args)).map(toHeartRateRecord);
}

async function queryHeartSampleRows(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return db.getAllAsync<HeartRateSampleRow>(sql, ...args);
}

async function queryHeartSamples(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await queryHeartSampleRows(db, sql, args)).map(toHeartRateSample);
}

async function querySleepCycles(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<SleepCycleRow>(sql, ...args)).map(toSleepCycleRecord);
}

async function queryActivities(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<ActivityRow>(sql, ...args)).map(toActivityRecord);
}

async function querySleepStages(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<SleepStageRow>(sql, ...args)).map(toSleepStageRecord);
}

type TransactionWriter = Pick<SQLiteDatabase, 'runAsync' | 'execAsync'>;

async function withExclusiveTransaction(
  db: SQLiteDatabase,
  callback: (tx: TransactionWriter) => Promise<void>,
) {
  if (typeof db.withExclusiveTransactionAsync === 'function') {
    await db.withExclusiveTransactionAsync(async (tx) => {
      await callback(tx);
    });
    return;
  }

  await callback(db);
}

async function countHeartRows(db: SQLiteDatabase) {
  const counts = await db.getFirstAsync<{
    heart_count: number;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM heart_rate) AS heart_count
  `);

  return counts?.heart_count ?? 0;
}

async function loadDerivedDataStateRow(db: SQLiteDatabase) {
  return db.getFirstAsync<DerivedDataStateRow>(
    `
      SELECT
        derived_schema_version,
        source_heart_count,
        refreshed_at,
        rebuild_status,
        pending_from_time,
        pending_to_time,
        last_processed_from_time,
        last_processed_to_time,
        last_error
      FROM derived_data_state
      WHERE id = 1
      LIMIT 1
    `,
  );
}

async function persistDerivedDataStateRow(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  patch: Partial<DerivedDataStateRow>,
) {
  const current = await loadDerivedDataStateRow(db as SQLiteDatabase);
  const next: DerivedDataStateRow = {
    derived_schema_version: current?.derived_schema_version ?? DERIVED_DATA_SCHEMA_VERSION,
    source_heart_count: current?.source_heart_count ?? 0,
    refreshed_at: current?.refreshed_at ?? formatSqliteDateTime(new Date(0)),
    rebuild_status: current?.rebuild_status ?? 'idle',
    pending_from_time: current?.pending_from_time ?? null,
    pending_to_time: current?.pending_to_time ?? null,
    last_processed_from_time: current?.last_processed_from_time ?? null,
    last_processed_to_time: current?.last_processed_to_time ?? null,
    last_error: current?.last_error ?? null,
    ...patch,
  };

  await db.runAsync(
    `
      INSERT INTO derived_data_state (
        id,
        derived_schema_version,
        source_heart_count,
        refreshed_at,
        rebuild_status,
        pending_from_time,
        pending_to_time,
        last_processed_from_time,
        last_processed_to_time,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        derived_schema_version = excluded.derived_schema_version,
        source_heart_count = excluded.source_heart_count,
        refreshed_at = excluded.refreshed_at,
        rebuild_status = excluded.rebuild_status,
        pending_from_time = excluded.pending_from_time,
        pending_to_time = excluded.pending_to_time,
        last_processed_from_time = excluded.last_processed_from_time,
        last_processed_to_time = excluded.last_processed_to_time,
        last_error = excluded.last_error
    `,
    1,
    next.derived_schema_version,
    next.source_heart_count,
    next.refreshed_at,
    next.rebuild_status,
    next.pending_from_time,
    next.pending_to_time,
    next.last_processed_from_time,
    next.last_processed_to_time,
    next.last_error,
  );
}

async function loadDashboardSnapshotCacheRow(db: SQLiteDatabase) {
  return db.getFirstAsync<DashboardSnapshotCacheRow>(
    `
      SELECT
        snapshot_json,
        snapshot_kind,
        built_at,
        source_heart_count,
        source_last_heart_time,
        derived_refreshed_at,
        last_error
      FROM dashboard_snapshot_cache
      WHERE id = 1
      LIMIT 1
    `,
  );
}

async function persistDashboardSnapshotCacheRow(
  db: Pick<SQLiteDatabase, 'runAsync'>,
  row: DashboardSnapshotCacheRow,
) {
  await db.runAsync(
    `
      INSERT INTO dashboard_snapshot_cache (
        id,
        snapshot_json,
        snapshot_kind,
        built_at,
        source_heart_count,
        source_last_heart_time,
        derived_refreshed_at,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        snapshot_kind = excluded.snapshot_kind,
        built_at = excluded.built_at,
        source_heart_count = excluded.source_heart_count,
        source_last_heart_time = excluded.source_last_heart_time,
        derived_refreshed_at = excluded.derived_refreshed_at,
        last_error = excluded.last_error
    `,
    1,
    row.snapshot_json,
    row.snapshot_kind,
    row.built_at,
    row.source_heart_count,
    row.source_last_heart_time,
    row.derived_refreshed_at,
    row.last_error,
  );
}

async function loadHeartGlobalStatsRow(db: SQLiteDatabase) {
  return db.getFirstAsync<HeartGlobalStatsRow>(
    `
      SELECT observed_peak_bpm, latest_heart_time, latest_stress
      FROM heart_global_stats
      WHERE id = 1
      LIMIT 1
    `,
  );
}

async function persistHeartGlobalStatsRow(
  db: Pick<SQLiteDatabase, 'runAsync'>,
  row: HeartGlobalStatsRow,
) {
  await db.runAsync(
    `
      INSERT INTO heart_global_stats (id, observed_peak_bpm, latest_heart_time, latest_stress)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_peak_bpm = excluded.observed_peak_bpm,
        latest_heart_time = excluded.latest_heart_time,
        latest_stress = excluded.latest_stress
    `,
    1,
    row.observed_peak_bpm,
    row.latest_heart_time,
    row.latest_stress,
  );
}

async function loadHeartIntradayBucketStateRow(db: SQLiteDatabase) {
  return db.getFirstAsync<HeartIntradayBucketStateRow>(
    `
      SELECT source_heart_count, source_last_heart_time, refreshed_at
      FROM heart_intraday_bucket_state
      WHERE id = 1
      LIMIT 1
    `,
  );
}

async function persistHeartIntradayBucketStateRow(
  db: Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>,
  patch: Partial<HeartIntradayBucketStateRow>,
) {
  const current = await loadHeartIntradayBucketStateRow(db as SQLiteDatabase);
  const next: HeartIntradayBucketStateRow = {
    source_heart_count: current?.source_heart_count ?? 0,
    source_last_heart_time: current?.source_last_heart_time ?? null,
    refreshed_at: current?.refreshed_at ?? formatSqliteDateTime(new Date(0)),
    ...patch,
  };

  await db.runAsync(
    `
      INSERT INTO heart_intraday_bucket_state (id, source_heart_count, source_last_heart_time, refreshed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_heart_count = excluded.source_heart_count,
        source_last_heart_time = excluded.source_last_heart_time,
        refreshed_at = excluded.refreshed_at
    `,
    1,
    next.source_heart_count,
    next.source_last_heart_time,
    next.refreshed_at,
  );
}

function parseDashboardSnapshot(snapshotJson: string): DashboardSnapshot | null {
  try {
    return JSON.parse(snapshotJson) as DashboardSnapshot;
  } catch {
    return null;
  }
}

function normalizeTimeRange(fromTime: string, toTime: string) {
  return fromTime <= toTime
    ? { fromTime, toTime }
    : { fromTime: toTime, toTime: fromTime };
}

function bucketStartForSqliteTime(value: string, bucketMinutes = DASHBOARD_HEART_BUCKET_MINUTES) {
  const minute = Number.parseInt(value.slice(14, 16), 10);
  const bucketMinute = minute - (minute % bucketMinutes);
  return `${value.slice(0, 14)}${`${bucketMinute}`.padStart(2, '0')}:00`;
}

function bucketStartForDate(date: Date, bucketMinutes = DASHBOARD_HEART_BUCKET_MINUTES) {
  return bucketStartForSqliteTime(formatSqliteDateTime(date), bucketMinutes);
}

function bucketEndExclusive(bucketStart: string, bucketMinutes = DASHBOARD_HEART_BUCKET_MINUTES) {
  return formatSqliteDateTime(addMinutes(parseSqliteDateTime(bucketStart), bucketMinutes));
}

function summarizeIntradayBucketRows(
  bucketStart: string,
  rows: readonly HeartRateSampleRow[],
): HeartIntradayBucketRow | null {
  const validRows = rows.filter((row) => sanitizeRecordedBpm(row.bpm) !== null);
  if (validRows.length === 0) {
    return null;
  }

  let total = 0;
  let maxTripletAvg: number | null = null;

  for (let index = 0; index < validRows.length; index += 1) {
    total += validRows[index].bpm;

    if (index + 2 < validRows.length) {
      const tripletAvg = (validRows[index].bpm + validRows[index + 1].bpm + validRows[index + 2].bpm) / 3;
      maxTripletAvg = maxTripletAvg === null || tripletAvg > maxTripletAvg ? tripletAvg : maxTripletAvg;
    }
  }

  return {
    bucket_start: bucketStart,
    sample_count: validRows.length,
    avg_bpm: total / validRows.length,
    first_bpm: validRows[0]!.bpm,
    second_bpm: validRows.length > 1 ? validRows[1]!.bpm : null,
    penultimate_bpm: validRows.length > 1 ? validRows[validRows.length - 2]!.bpm : null,
    last_bpm: validRows[validRows.length - 1]!.bpm,
    max_triplet_avg: maxTripletAvg,
  };
}

function buildIntradayBucketRows(
  rows: readonly HeartRateSampleRow[],
  bucketMinutes = DASHBOARD_HEART_BUCKET_MINUTES,
) {
  const grouped = new Map<string, HeartRateSampleRow[]>();

  for (const row of rows) {
    const bucketStart = bucketStartForSqliteTime(row.time, bucketMinutes);
    const bucketRows = grouped.get(bucketStart);

    if (bucketRows) {
      bucketRows.push(row);
      continue;
    }

    grouped.set(bucketStart, [row]);
  }

  return [...grouped.entries()].flatMap(([bucketStart, bucketRows]) => {
    const summary = summarizeIntradayBucketRows(bucketStart, bucketRows);
    return summary ? [summary] : [];
  });
}

function summarizeBucketWindow(rows: readonly HeartIntradayBucketRow[]) {
  const rawRowCount = totalBucketSampleCount(rows);
  const weightedAverageBpm =
    rawRowCount === 0
      ? null
      : Math.round(
          rows.reduce((sum, row) => sum + row.avg_bpm * row.sample_count, 0) / rawRowCount,
        );

  return {
    rawRowCount,
    bucketSamples: rows.map(toHeartIntradayBucketSample),
    averageBpm: weightedAverageBpm,
    sustainedPeakBpm: sustainedPeakBpmFromBucketRows(rows),
  } satisfies Omit<BucketedHeartWindow, 'latestHeartDate' | 'intradayStart'>;
}

async function hasInvalidRecordedBpmRowsInRange(db: SQLiteDatabase, fromTime: string, toTime: string) {
  const row = await db.getFirstAsync<NullableNumberRow>(
    `
      SELECT COUNT(*) AS value
      FROM heart_rate
      WHERE time >= ? AND time <= ? AND (bpm < ? OR bpm > ?)
    `,
    fromTime,
    toTime,
    MIN_PLAUSIBLE_RECORDED_BPM,
    MAX_PLAUSIBLE_RECORDED_BPM,
  );

  return (row?.value ?? 0) > 0;
}

function shouldRepairCachedHeartCard(snapshot: DashboardSnapshot) {
  return (
    (snapshot.heartCard.maxHr !== null && !isPlausibleRecordedBpm(snapshot.heartCard.maxHr)) ||
    (snapshot.heartCard.averageHr !== null && !isPlausibleRecordedBpm(snapshot.heartCard.averageHr))
  );
}

function toHeartIntradayBucketSample(row: HeartIntradayBucketRow): HeartRateSample {
  return {
    bpm: row.avg_bpm,
    time: row.bucket_start,
    date: parseSqliteDateTime(row.bucket_start),
  };
}

function sustainedPeakBpmFromBucketRows(rows: readonly HeartIntradayBucketRow[]): number | null {
  let totalCount = 0;
  let bestSingle: number | null = null;
  let bestPair: number | null = null;
  let bestTriplet: number | null = null;
  let trailingBpms: number[] = [];

  for (const row of rows) {
    totalCount += row.sample_count;
    bestSingle = bestSingle === null ? row.first_bpm : Math.max(bestSingle, row.first_bpm, row.last_bpm);

    if (trailingBpms.length >= 1) {
      const pairAvg = (trailingBpms[trailingBpms.length - 1]! + row.first_bpm) / 2;
      bestPair = bestPair === null || pairAvg > bestPair ? pairAvg : bestPair;
    }

    if (row.sample_count >= 2 && row.second_bpm !== null) {
      const pairAvg = (row.first_bpm + row.second_bpm) / 2;
      bestPair = bestPair === null || pairAvg > bestPair ? pairAvg : bestPair;
    }

    if (trailingBpms.length >= 2) {
      const tripletAvg = (
        trailingBpms[trailingBpms.length - 2]! +
        trailingBpms[trailingBpms.length - 1]! +
        row.first_bpm
      ) / 3;
      bestTriplet = bestTriplet === null || tripletAvg > bestTriplet ? tripletAvg : bestTriplet;
    }

    if (trailingBpms.length >= 1 && row.sample_count >= 2 && row.second_bpm !== null) {
      const tripletAvg = (trailingBpms[trailingBpms.length - 1]! + row.first_bpm + row.second_bpm) / 3;
      bestTriplet = bestTriplet === null || tripletAvg > bestTriplet ? tripletAvg : bestTriplet;
    }

    if (row.max_triplet_avg !== null) {
      bestTriplet = bestTriplet === null || row.max_triplet_avg > bestTriplet ? row.max_triplet_avg : bestTriplet;
    }

    if (row.sample_count === 1) {
      trailingBpms = [...trailingBpms.slice(-1), row.last_bpm];
    } else {
      trailingBpms = [row.penultimate_bpm ?? row.first_bpm, row.last_bpm];
    }
  }

  if (totalCount === 0) {
    return null;
  }

  if (totalCount === 1) {
    return bestSingle === null ? null : Math.round(bestSingle);
  }

  if (totalCount === 2) {
    return bestPair === null ? null : Math.round(bestPair);
  }

  if (bestTriplet !== null) {
    return Math.round(bestTriplet);
  }

  if (bestPair !== null) {
    return Math.round(bestPair);
  }

  return bestSingle === null ? null : Math.round(bestSingle);
}

function totalBucketSampleCount(rows: readonly HeartIntradayBucketRow[]) {
  return rows.reduce((sum, row) => sum + row.sample_count, 0);
}

function calculateStrainFromBucketRows(
  rows: readonly HeartIntradayBucketRow[],
  maxHr: number,
  restingHr: number,
  durationMinutes: number,
): number | null {
  const sampleCount = totalBucketSampleCount(rows);
  if (sampleCount < 600 || maxHr <= restingHr || durationMinutes <= 0) {
    return null;
  }

  const reserve = maxHr - restingHr;
  const sampleDuration = durationMinutes / Math.max(sampleCount, 1);
  const trimp = rows.reduce(
    (sum, row) => sum + row.sample_count * sampleDuration * zoneWeight(row.avg_bpm, restingHr, reserve),
    0,
  );

  if (trimp <= 0) {
    return 0;
  }

  return Math.round((21 * Math.log(trimp + 1) / Math.log(7201)) * 100) / 100;
}

function estimateCaloriesFromBucketRows(
  rows: readonly HeartIntradayBucketRow[],
  maxHr: number,
  restingHr: number,
  durationMinutes: number,
): number | null {
  const sampleCount = totalBucketSampleCount(rows);
  if (sampleCount < 2 || maxHr <= restingHr || durationMinutes <= 0) {
    return null;
  }

  const metByZone = [1.8, 4, 6, 8.5, 10.5, 12];
  const reserve = maxHr - restingHr;
  const sampleDuration = durationMinutes / Math.max(sampleCount, 1);

  const calories = rows.reduce((sum, row) => {
    const zone = zoneWeight(row.avg_bpm, restingHr, reserve);
    const met = metByZone[zone];
    return sum + row.sample_count * met * 3.5 * 75 / 200 * sampleDuration;
  }, 0);

  return Math.round(calories);
}

function mergeTimeRange(
  currentFromTime: string | null,
  currentToTime: string | null,
  nextFromTime: string,
  nextToTime: string,
) {
  const normalized = normalizeTimeRange(nextFromTime, nextToTime);

  if (!currentFromTime || !currentToTime) {
    return normalized;
  }

  const current = normalizeTimeRange(currentFromTime, currentToTime);
  return {
    fromTime: current.fromTime < normalized.fromTime ? current.fromTime : normalized.fromTime,
    toTime: current.toTime > normalized.toTime ? current.toTime : normalized.toTime,
  };
}

function derivedRefreshStateFromRow(row: DerivedDataStateRow | null): DerivedRefreshState {
  return {
    status: row?.rebuild_status ?? 'idle',
    pendingFromTime: row?.pending_from_time ?? null,
    pendingToTime: row?.pending_to_time ?? null,
    lastProcessedFromTime: row?.last_processed_from_time ?? null,
    lastProcessedToTime: row?.last_processed_to_time ?? null,
    lastError: row?.last_error ?? null,
    isFirstSync: row?.last_processed_from_time === null || row?.last_processed_to_time === null,
  };
}

function detectionWindowStart(fromTime: string) {
  const date = parseSqliteDateTime(fromTime);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 12, 0, 0, 0);
}

function detectionWindowEnd(toTime: string) {
  const date = parseSqliteDateTime(toTime);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12, 0, 0, 0);
}

async function resolveMetricWindowStartTime(db: SQLiteDatabase, fromTime: string) {
  const rows = await db.getAllAsync<TimeRow>(
    `
      SELECT time
      FROM heart_rate
      WHERE time <= ?
      ORDER BY time DESC
      LIMIT ?
    `,
    fromTime,
    STRESS_WINDOW,
  );

  const earliest = rows.at(-1)?.time;
  return earliest ?? fromTime;
}

function buildDerivedMetricMaps(heartRows: HeartRateRecord[]) {
  const updates: HeartMetricUpdate[] = [];
  const rrStressState = createRollingStressState();
  const fallbackStressState = createRollingStressState();
  const stressWindow = new Array<RowStressContribution | null>(STRESS_WINDOW).fill(null);
  let stressRawRrLength = 0;
  const spo2Window: Array<{ red: number; ir: number; valid: boolean }> = [];
  let spo2ValidCount = 0;
  let spo2RedSum = 0;
  let spo2RedSquares = 0;
  let spo2IrSum = 0;
  let spo2IrSquares = 0;

  for (let index = 0; index < heartRows.length; index += 1) {
    const row = heartRows[index];
    const stressSlot = index % STRESS_WINDOW;
    if (index >= STRESS_WINDOW) {
      const removed = stressWindow[stressSlot];
      if (removed) {
        stressRawRrLength -= removed.rawRrLength;

        for (const value of removed.rrValues) {
          removeRollingStressValue(rrStressState, value);
        }

        if (removed.fallbackValue) {
          removeRollingStressValue(fallbackStressState, removed.fallbackValue);
        }
      }
    }

    const rrValues: RollingStressValue[] = [];
    for (const value of row.rr) {
      if (value > 0) {
        rrValues.push(appendRollingStressValue(rrStressState, value));
      }
    }

    const fallbackRrValue = Math.round((60 / row.bpm) * 1000);
    const fallbackValue = fallbackRrValue > 0 ? appendRollingStressValue(fallbackStressState, fallbackRrValue) : null;
    stressWindow[stressSlot] = {
      rawRrLength: row.rr.length,
      rrValues,
      fallbackValue,
    };
    stressRawRrLength += row.rr.length;

    const stress =
      index + 1 < STRESS_WINDOW
        ? null
        : stressRawRrLength >= STRESS_WINDOW
          ? calculateStressScoreFromRollingState(rrStressState)
          : calculateStressScoreFromRollingState(fallbackStressState);

    const red = row.sensorData?.spo2_red ?? 0;
    const ir = row.sensorData?.spo2_ir ?? 0;
    const valid = red > 0 && ir > 0;
    spo2Window.push({ red, ir, valid });

    if (valid) {
      spo2ValidCount += 1;
      spo2RedSum += red;
      spo2RedSquares += red * red;
      spo2IrSum += ir;
      spo2IrSquares += ir * ir;
    }

    if (spo2Window.length > SPO2_WINDOW) {
      const removed = spo2Window.shift()!;
      if (removed.valid) {
        spo2ValidCount -= 1;
        spo2RedSum -= removed.red;
        spo2RedSquares -= removed.red * removed.red;
        spo2IrSum -= removed.ir;
        spo2IrSquares -= removed.ir * removed.ir;
      }
    }

    const spo2 = calculateSpo2ScoreFromState(
      spo2Window.length,
      spo2ValidCount,
      spo2RedSum,
      spo2RedSquares,
      spo2IrSum,
      spo2IrSquares,
    );
    const skinTemp = calculateSkinTempValue(row);

    updates.push({
      id: row.id,
      stress,
      spo2,
      skinTemp,
    });
  }

  return updates;
}

function buildDerivedDetectionArtifacts(heartRows: HeartRateRecord[]) {
  const periods = detectFromGravity(heartRows);
  const sleepCandidates = mergeNearbySleepPeriods(
    periods.filter((period) => period.activity === 'sleep' && period.durationMinutes >= MIN_SLEEP_DURATION_MINUTES),
  );
  const activeCandidates = periods.filter((period) => period.activity === 'active');
  const { sleeps: primarySleepPeriods, naps: napPeriods } = selectSleepAndNapPeriods(sleepCandidates);
  const napActivities = buildNapActivities(napPeriods);
  const sleepCycles = scoreSleepCycles(
    primarySleepPeriods
      .map((period) => buildSleepCycle(period, heartRows))
      .filter((period): period is SleepCycleRecord => period !== null),
    napActivities,
  );
  const activities = [...napActivities, ...buildActivityRecords(activeCandidates, sleepCycles)];
  const stages = sleepCycles.flatMap((sleep) => buildStageSegments(sleep, heartRows));

  return {
    sleepCycles,
    activities,
    stages,
  };
}

async function updateHeartMetricRows(
  tx: TransactionWriter,
  metricUpdates: ReturnType<typeof buildDerivedMetricMaps>,
) {
  if (metricUpdates.length === 0) {
    return;
  }

  await tx.execAsync(`
    CREATE TEMP TABLE IF NOT EXISTS heart_metric_updates (
      id INTEGER PRIMARY KEY NOT NULL,
      stress REAL,
      spo2 REAL,
      skin_temp REAL
    );
    DELETE FROM heart_metric_updates;
  `);

  for (let index = 0; index < metricUpdates.length; index += HEART_METRIC_UPDATE_BATCH_SIZE) {
    const batch = metricUpdates.slice(index, index + HEART_METRIC_UPDATE_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const args: Array<number | null> = [];

    for (const update of batch) {
      args.push(update.id, update.stress, update.spo2, update.skinTemp);
    }

    await tx.runAsync(
      `
        INSERT INTO heart_metric_updates (id, stress, spo2, skin_temp)
        VALUES ${placeholders}
      `,
      ...args,
    );
  }

  await tx.execAsync(`
    UPDATE heart_rate
    SET
      stress = (SELECT heart_metric_updates.stress FROM heart_metric_updates WHERE heart_metric_updates.id = heart_rate.id),
      spo2 = (SELECT heart_metric_updates.spo2 FROM heart_metric_updates WHERE heart_metric_updates.id = heart_rate.id),
      skin_temp = (SELECT heart_metric_updates.skin_temp FROM heart_metric_updates WHERE heart_metric_updates.id = heart_rate.id)
    WHERE id IN (SELECT id FROM heart_metric_updates);

    DELETE FROM heart_metric_updates;
  `);
}

async function insertDerivedArtifacts(
  tx: TransactionWriter,
  artifacts: ReturnType<typeof buildDerivedDetectionArtifacts>,
) {
  for (const sleep of artifacts.sleepCycles) {
    await tx.runAsync(
      `
        INSERT INTO sleep_cycles (id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, avg_skin_temp, score, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      sleep.id,
      sleep.sleepId,
      formatSqliteDateTime(sleep.start),
      formatSqliteDateTime(sleep.end),
      sleep.minBpm,
      sleep.maxBpm,
      sleep.avgBpm,
      sleep.minHrv,
      sleep.maxHrv,
      sleep.avgHrv,
      sleep.avgSkinTemp,
      sleep.score,
    );
  }

  for (const activity of artifacts.activities) {
    await tx.runAsync(
      `
        INSERT INTO activities (period_id, start, end, activity, synced)
        VALUES (?, ?, ?, ?, 0)
      `,
      activity.periodId,
      formatSqliteDateTime(activity.start),
      formatSqliteDateTime(activity.end),
      activity.activity,
    );
  }

  for (const stage of artifacts.stages) {
    await tx.runAsync(
      `
        INSERT INTO sleep_stage_segments (sleep_id, start, end, stage, is_estimated)
        VALUES (?, ?, ?, ?, ?)
      `,
      stage.sleepId,
      formatSqliteDateTime(stage.start),
      formatSqliteDateTime(stage.end),
      stage.stage,
      stage.isEstimated ? 1 : 0,
    );
  }
}

async function replaceDerivedDetectionRange(
  tx: TransactionWriter,
  rangeStart: string,
  rangeEnd: string,
  overlappingSleepIds: readonly string[],
  artifacts: ReturnType<typeof buildDerivedDetectionArtifacts>,
) {
  for (const sleepId of overlappingSleepIds) {
    await tx.runAsync(
      `
        DELETE FROM sleep_stage_segments
        WHERE sleep_id = ?
      `,
      sleepId,
    );
  }

  await tx.runAsync(
    `
      DELETE FROM sleep_cycles
      WHERE start <= ? AND end >= ?
    `,
    rangeEnd,
    rangeStart,
  );
  await tx.runAsync(
    `
      DELETE FROM activities
      WHERE start <= ? AND end >= ?
    `,
    rangeEnd,
    rangeStart,
  );
  await insertDerivedArtifacts(tx, artifacts);
}

async function clearAllDerivedTables(tx: TransactionWriter) {
  await tx.execAsync(`
    DELETE FROM sleep_cycles;
    DELETE FROM activities;
    DELETE FROM sleep_stage_segments;
  `);
}

function startOfSqliteDay(value: string) {
  const date = parseSqliteDateTime(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function nextSqliteDay(value: string) {
  const date = startOfSqliteDay(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

async function loadRecentSleepCyclesForDashboard(db: SQLiteDatabase, limit: number) {
  const rows = await querySleepCycles(
    db,
    `
      SELECT id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, avg_skin_temp, score
      FROM sleep_cycles
      ORDER BY start DESC
      LIMIT ?
    `,
    [limit],
  );
  return rows.reverse();
}

async function loadRecentHeartDayStats(db: SQLiteDatabase, limit: number) {
  const rows = await db.getAllAsync<HeartDayStatRow>(
    `
      SELECT day, min_bpm, avg_bpm, max_bpm, strain_score
      FROM heart_day_stats
      ORDER BY day DESC
      LIMIT ?
    `,
    limit,
  );
  return rows.reverse().map(toHeartDayStatRecord);
}

async function replaceHeartDayStatsRange(
  db: SQLiteDatabase,
  rangeStartDay: string,
  rangeEndDay: string,
  stats: HeartDayStatRecord[],
) {
  await withExclusiveTransaction(db, async (tx) => {
    await tx.runAsync(
      `
        DELETE FROM heart_day_stats
        WHERE day >= ? AND day <= ?
      `,
      rangeStartDay,
      rangeEndDay,
    );

    for (const stat of stats) {
      await tx.runAsync(
        `
          INSERT INTO heart_day_stats (day, min_bpm, avg_bpm, max_bpm, strain_score)
          VALUES (?, ?, ?, ?, ?)
        `,
        stat.day,
        stat.minBpm,
        stat.avgBpm,
        stat.maxBpm,
        stat.strainScore,
      );
    }
  });
}

async function replaceWellnessDayStatsRange(
  db: SQLiteDatabase,
  rangeStartDay: string,
  rangeEndDay: string,
  stats: readonly WellnessDayStatRow[],
  options?: { replaceAll?: boolean },
) {
  await withExclusiveTransaction(db, async (tx) => {
    if (options?.replaceAll) {
      await tx.execAsync('DELETE FROM wellness_day_stats;');
    } else {
      await tx.runAsync(
        `
          DELETE FROM wellness_day_stats
          WHERE day >= ? AND day <= ?
        `,
        rangeStartDay,
        rangeEndDay,
      );
    }

    for (const stat of stats) {
      await tx.runAsync(
        `
          INSERT INTO wellness_day_stats (
            day,
            stress_count,
            avg_stress,
            spo2_count,
            avg_spo2,
            skin_temp_count,
            avg_skin_temp
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        stat.day,
        stat.stress_count,
        stat.avg_stress,
        stat.spo2_count,
        stat.avg_spo2,
        stat.skin_temp_count,
        stat.avg_skin_temp,
      );
    }
  });
}

async function replaceHeartIntradayBucketRange(
  db: SQLiteDatabase,
  bucketRangeStart: string,
  bucketRangeEnd: string,
  bucketRows: readonly HeartIntradayBucketRow[],
  options?: { replaceAll?: boolean },
) {
  await withExclusiveTransaction(db, async (tx) => {
    if (options?.replaceAll) {
      await tx.execAsync('DELETE FROM heart_intraday_buckets;');
    } else {
      await tx.runAsync(
        `
          DELETE FROM heart_intraday_buckets
          WHERE bucket_start >= ? AND bucket_start <= ?
        `,
        bucketRangeStart,
        bucketRangeEnd,
      );
    }

    for (const bucket of bucketRows) {
      await tx.runAsync(
        `
          INSERT INTO heart_intraday_buckets (
            bucket_start,
            sample_count,
            avg_bpm,
            first_bpm,
            second_bpm,
            penultimate_bpm,
            last_bpm,
            max_triplet_avg
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        bucket.bucket_start,
        bucket.sample_count,
        bucket.avg_bpm,
        bucket.first_bpm,
        bucket.second_bpm,
        bucket.penultimate_bpm,
        bucket.last_bpm,
        bucket.max_triplet_avg,
      );
    }
  });
}

async function refreshHeartIntradayBucketsForRange(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
  options?: { replaceAll?: boolean },
) {
  await withAggregateMutationLock(db, async () => {
    const heartCount = await countHeartRows(db);

    if (heartCount === 0) {
      await withExclusiveTransaction(db, async (tx) => {
        await tx.execAsync(`
          DELETE FROM heart_intraday_buckets;
          DELETE FROM heart_intraday_bucket_state;
        `);
      });
      return;
    }

    const normalized = normalizeTimeRange(fromTime, toTime);
    const bucketRangeStart = bucketStartForSqliteTime(normalized.fromTime);
    const bucketRangeEnd = bucketStartForSqliteTime(normalized.toTime);
    const bucketRows = buildIntradayBucketRows(
      await queryHeartSampleRows(
        db,
        `
          SELECT bpm, time
          FROM heart_rate
          WHERE time >= ? AND time < ?
          ORDER BY time ASC
        `,
        [bucketRangeStart, bucketEndExclusive(bucketRangeEnd)],
      ),
    );

    await replaceHeartIntradayBucketRange(db, bucketRangeStart, bucketRangeEnd, bucketRows, options);

    const latestHeart = await db.getFirstAsync<TimeRow>(
      `
        SELECT time
        FROM heart_rate
        ORDER BY time DESC
        LIMIT 1
      `,
    );
    await persistHeartIntradayBucketStateRow(db, {
      source_heart_count: heartCount,
      source_last_heart_time: latestHeart?.time ?? null,
      refreshed_at: formatSqliteDateTime(new Date()),
    });
  });
}

async function refreshHeartDayStatsForRange(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
  options?: { replaceAll?: boolean },
) {
  await withAggregateMutationLock(db, async () => {
    const normalized = normalizeTimeRange(fromTime, toTime);
    const dayStart = startOfSqliteDay(normalized.fromTime);
    const dayEndExclusive = nextSqliteDay(normalized.toTime);
    const heartRows = await queryHeartSamples(
      db,
      `
        SELECT bpm, time
        FROM heart_rate
        WHERE time >= ? AND time < ?
        ORDER BY time ASC
      `,
      [formatSqliteDateTime(dayStart), formatSqliteDateTime(dayEndExclusive)],
    );

    const recentSleepCycles = await loadRecentSleepCyclesForDashboard(db, 15);
    const recentExistingDayStats = options?.replaceAll ? [] : await loadRecentHeartDayStats(db, 14);
    const currentRangeMinima = heartRows.length === 0
      ? []
      : groupByDay(heartRows).map(([, rows]) => summarizeHeartRows(rows)!.min);
    const dailyMinima = [
      ...recentExistingDayStats.map((stat) => stat.minBpm),
      ...currentRangeMinima,
    ];
    const restingHr = personalizeRestingHr(recentSleepCycles, dailyMinima);
    const currentGlobal = options?.replaceAll ? null : await loadHeartGlobalStatsRow(db);
    const rangePeakBpm = summarizeHeartRows(heartRows)?.max ?? null;
    const observedPeakBpm =
      rangePeakBpm === null
        ? currentGlobal?.observed_peak_bpm ?? null
        : Math.max(currentGlobal?.observed_peak_bpm ?? 0, rangePeakBpm);
    const maxHr = personalizeMaxHrFromObservedPeak(observedPeakBpm, restingHr);
    const heartDayStats = buildHeartDayStatsFromRows(heartRows, restingHr, maxHr);

    if (options?.replaceAll) {
      await withExclusiveTransaction(db, async (tx) => {
        await tx.execAsync('DELETE FROM heart_day_stats;');
        for (const stat of heartDayStats) {
          await tx.runAsync(
            `
              INSERT INTO heart_day_stats (day, min_bpm, avg_bpm, max_bpm, strain_score)
              VALUES (?, ?, ?, ?, ?)
            `,
            stat.day,
            stat.minBpm,
            stat.avgBpm,
            stat.maxBpm,
            stat.strainScore,
          );
        }
      });
    } else {
      await replaceHeartDayStatsRange(
        db,
        dateKey(dayStart),
        dateKey(new Date(dayEndExclusive.getTime() - 1000)),
        heartDayStats,
      );
    }

    const latestHeart = await db.getFirstAsync<LatestHeartRow>(
      `
        SELECT time, stress
        FROM heart_rate
        ORDER BY time DESC
        LIMIT 1
      `,
    );
    const peakFromDays = await db.getFirstAsync<NullableNumberRow>(
      `
        SELECT MAX(max_bpm) AS value
        FROM heart_day_stats
        WHERE max_bpm BETWEEN ? AND ?
      `,
      MIN_PLAUSIBLE_RECORDED_BPM,
      MAX_PLAUSIBLE_RECORDED_BPM,
    );

    await persistHeartGlobalStatsRow(db, {
      observed_peak_bpm: peakFromDays?.value ?? null,
      latest_heart_time: latestHeart?.time ?? null,
      latest_stress: latestHeart?.stress ?? null,
    });
  });
}

async function refreshWellnessDayStatsForRange(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
  options?: { replaceAll?: boolean },
) {
  await withAggregateMutationLock(db, async () => {
    const normalized = normalizeTimeRange(fromTime, toTime);
    const dayStart = startOfSqliteDay(normalized.fromTime);
    const dayEndExclusive = nextSqliteDay(normalized.toTime);
    const dayStats = await db.getAllAsync<WellnessDayStatRow>(
      `
        SELECT
          substr(time, 1, 10) AS day,
          COUNT(stress) AS stress_count,
          AVG(stress) AS avg_stress,
          COUNT(spo2) AS spo2_count,
          AVG(spo2) AS avg_spo2,
          COUNT(skin_temp) AS skin_temp_count,
          AVG(skin_temp) AS avg_skin_temp
        FROM heart_rate
        WHERE time >= ? AND time < ?
        GROUP BY day
        ORDER BY day ASC
      `,
      formatSqliteDateTime(dayStart),
      formatSqliteDateTime(dayEndExclusive),
    );

    await replaceWellnessDayStatsRange(
      db,
      dateKey(dayStart),
      dateKey(new Date(dayEndExclusive.getTime() - 1000)),
      dayStats,
      options,
    );
  });
}

export async function refreshHeartAggregatesForRange(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
) {
  await refreshHeartIntradayBucketsForRange(db, fromTime, toTime);
  await refreshHeartDayStatsForRange(db, fromTime, toTime);
}

export async function shouldRefreshDerivedData(db: SQLiteDatabase): Promise<boolean> {
  const heartCount = await countHeartRows(db);

  if (heartCount === 0) {
    return false;
  }

  const state = await loadDerivedDataStateRow(db);

  if (!state) {
    return true;
  }

  return (
    state.derived_schema_version !== DERIVED_DATA_SCHEMA_VERSION ||
    state.source_heart_count !== heartCount ||
    state.rebuild_status !== 'idle' ||
    state.pending_from_time !== null ||
    state.pending_to_time !== null
  );
}

export async function markDerivedRefreshPending(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
) {
  const state = await loadDerivedDataStateRow(db);
  const merged = mergeTimeRange(state?.pending_from_time ?? null, state?.pending_to_time ?? null, fromTime, toTime);

  await persistDerivedDataStateRow(db, {
    rebuild_status: state?.rebuild_status === 'processing' ? 'processing' : 'pending',
    pending_from_time: merged.fromTime,
    pending_to_time: merged.toTime,
    last_error: null,
  });
}

export async function refreshDerivedDataRange(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
) {
  const refreshStartedAt = Date.now();
  const normalized = normalizeTimeRange(fromTime, toTime);
  const metricWindowStartTime = await resolveMetricWindowStartTime(db, normalized.fromTime);
  const detectionStart = detectionWindowStart(normalized.fromTime);
  const detectionEnd = detectionWindowEnd(normalized.toTime);
  const metricQueryStartedAt = Date.now();
  const metricRows = await queryHeartRows(
    db,
    `
      SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data
      FROM heart_rate
      WHERE time >= ? AND time <= ?
      ORDER BY time ASC
    `,
    [metricWindowStartTime, normalized.toTime],
  );
  logMobilePerf('derived.range.queryMetrics', metricQueryStartedAt, {
    rows: metricRows.length,
  });

  const detectionQueryStartedAt = Date.now();
  const detectionRows = await queryHeartRows(
    db,
    `
      SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data
      FROM heart_rate
      WHERE time >= ? AND time <= ?
      ORDER BY time ASC
    `,
    [formatSqliteDateTime(detectionStart), formatSqliteDateTime(detectionEnd)],
  );
  logMobilePerf('derived.range.queryDetection', detectionQueryStartedAt, {
    rows: detectionRows.length,
  });

  const metricBuildStartedAt = Date.now();
  const metricUpdates = buildDerivedMetricMaps(metricRows);
  logMobilePerf('derived.range.buildMetrics', metricBuildStartedAt, {
    rows: metricRows.length,
  });

  const artifactBuildStartedAt = Date.now();
  const artifacts = buildDerivedDetectionArtifacts(detectionRows);
  logMobilePerf('derived.range.buildArtifacts', artifactBuildStartedAt, {
    rows: detectionRows.length,
    sleepCycles: artifacts.sleepCycles.length,
    activities: artifacts.activities.length,
    stages: artifacts.stages.length,
  });

  const overlapQueryStartedAt = Date.now();
  const overlappingSleepRows = await db.getAllAsync<{ sleep_id: string }>(
    `
      SELECT sleep_id
      FROM sleep_cycles
      WHERE start <= ? AND end >= ?
    `,
    formatSqliteDateTime(detectionEnd),
    formatSqliteDateTime(detectionStart),
  );
  const overlappingSleepIds = [...new Set(overlappingSleepRows.map((row) => row.sleep_id))];
  logMobilePerf('derived.range.queryOverlappingSleepIds', overlapQueryStartedAt, {
    sleepIds: overlappingSleepIds.length,
  });

  await withExclusiveTransaction(db, async (tx) => {
    const metricWriteStartedAt = Date.now();
    await updateHeartMetricRows(tx, metricUpdates);
    logMobilePerf('derived.range.writeMetrics', metricWriteStartedAt, {
      rows: metricRows.length,
    });

    const artifactWriteStartedAt = Date.now();
    await replaceDerivedDetectionRange(
      tx,
      formatSqliteDateTime(detectionStart),
      formatSqliteDateTime(detectionEnd),
      overlappingSleepIds,
      artifacts,
    );
    logMobilePerf('derived.range.replaceArtifacts', artifactWriteStartedAt, {
      sleepCycles: artifacts.sleepCycles.length,
      activities: artifacts.activities.length,
      stages: artifacts.stages.length,
    });
  });

  const statsStartedAt = Date.now();
  await refreshHeartDayStatsForRange(db, normalized.fromTime, normalized.toTime);
  logMobilePerf('derived.range.refreshDayStats', statsStartedAt);
  const wellnessStatsStartedAt = Date.now();
  await refreshWellnessDayStatsForRange(db, normalized.fromTime, normalized.toTime);
  logMobilePerf('derived.range.refreshWellnessDayStats', wellnessStatsStartedAt);
  logMobilePerf('derived.range.total', refreshStartedAt, {
    metricRows: metricRows.length,
    detectionRows: detectionRows.length,
  });
}

export async function refreshDerivedData(db: SQLiteDatabase) {
  const refreshStartedAt = Date.now();
  const queryStartedAt = Date.now();
  const heartRows = await queryHeartRows(
    db,
    'SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data FROM heart_rate ORDER BY time ASC',
  );
  logMobilePerf('derived.full.queryHeartRows', queryStartedAt, {
    rows: heartRows.length,
  });

  const metricBuildStartedAt = Date.now();
  const metricUpdates = buildDerivedMetricMaps(heartRows);
  logMobilePerf('derived.full.buildMetrics', metricBuildStartedAt, {
    rows: heartRows.length,
  });

  const artifactBuildStartedAt = Date.now();
  const artifacts = buildDerivedDetectionArtifacts(heartRows);
  logMobilePerf('derived.full.buildArtifacts', artifactBuildStartedAt, {
    rows: heartRows.length,
    sleepCycles: artifacts.sleepCycles.length,
    activities: artifacts.activities.length,
    stages: artifacts.stages.length,
  });
  const refreshedAt = formatSqliteDateTime(new Date());

  await withExclusiveTransaction(db, async (tx) => {
    const metricWriteStartedAt = Date.now();
    await updateHeartMetricRows(tx, metricUpdates);
    logMobilePerf('derived.full.writeMetrics', metricWriteStartedAt, {
      rows: heartRows.length,
    });

    const artifactWriteStartedAt = Date.now();
    await clearAllDerivedTables(tx);
    await insertDerivedArtifacts(tx, artifacts);
    logMobilePerf('derived.full.replaceArtifacts', artifactWriteStartedAt, {
      sleepCycles: artifacts.sleepCycles.length,
      activities: artifacts.activities.length,
      stages: artifacts.stages.length,
    });
  });

  if (heartRows.length > 0) {
    const statsStartedAt = Date.now();
    await refreshHeartDayStatsForRange(db, heartRows[0].time, heartRows.at(-1)!.time, {
      replaceAll: true,
    });
    logMobilePerf('derived.full.refreshDayStats', statsStartedAt);
    const wellnessStatsStartedAt = Date.now();
    await refreshWellnessDayStatsForRange(db, heartRows[0].time, heartRows.at(-1)!.time, {
      replaceAll: true,
    });
    logMobilePerf('derived.full.refreshWellnessDayStats', wellnessStatsStartedAt);
  } else {
    await withExclusiveTransaction(db, async (tx) => {
      await tx.execAsync(`
        DELETE FROM heart_day_stats;
        DELETE FROM heart_global_stats;
        DELETE FROM wellness_day_stats;
      `);
    });
  }

  await persistDerivedDataStateRow(db, {
    derived_schema_version: DERIVED_DATA_SCHEMA_VERSION,
    source_heart_count: heartRows.length,
    refreshed_at: refreshedAt,
    rebuild_status: 'idle',
    pending_from_time: null,
    pending_to_time: null,
    last_processed_from_time: heartRows[0]?.time ?? null,
    last_processed_to_time: heartRows.at(-1)?.time ?? null,
    last_error: null,
  });
  logMobilePerf('derived.full.total', refreshStartedAt, {
    rows: heartRows.length,
  });
}

export async function processPendingDerivedRefresh(db: SQLiteDatabase): Promise<boolean> {
  let processed = false;

  while (true) {
    const heartCount = await countHeartRows(db);
    if (heartCount === 0) {
      await persistDerivedDataStateRow(db, {
        derived_schema_version: DERIVED_DATA_SCHEMA_VERSION,
        source_heart_count: 0,
        refreshed_at: formatSqliteDateTime(new Date()),
        rebuild_status: 'idle',
        pending_from_time: null,
        pending_to_time: null,
        last_error: null,
      });
      logMobilePerf('derived.pending.empty', Date.now(), {
        heartCount,
      });
      return false;
    }

    const state = await loadDerivedDataStateRow(db);

    if (
      !state ||
      state.derived_schema_version !== DERIVED_DATA_SCHEMA_VERSION ||
      (state.pending_from_time === null && state.pending_to_time === null && state.source_heart_count !== heartCount)
    ) {
      const fullRefreshStartedAt = Date.now();
      await refreshDerivedData(db);
      logMobilePerf('derived.pending.fullRefresh', fullRefreshStartedAt, {
        heartCount,
      });
      return true;
    }

    if (!state.pending_from_time || !state.pending_to_time) {
      if (state.rebuild_status !== 'idle' || state.last_error !== null) {
        await persistDerivedDataStateRow(db, {
          derived_schema_version: DERIVED_DATA_SCHEMA_VERSION,
          source_heart_count: heartCount,
          refreshed_at: state.refreshed_at,
          rebuild_status: 'idle',
          last_error: null,
        });
      }
      logMobilePerf('derived.pending.idle', Date.now(), {
        processed,
      });
      return processed;
    }

    const currentRange = normalizeTimeRange(state.pending_from_time, state.pending_to_time);
    await persistDerivedDataStateRow(db, {
      rebuild_status: 'processing',
      pending_from_time: null,
      pending_to_time: null,
      last_error: null,
    });

    try {
      const rangeStartedAt = Date.now();
      await refreshDerivedDataRange(db, currentRange.fromTime, currentRange.toTime);
      logMobilePerf('derived.pending.range', rangeStartedAt, {
        fromTime: currentRange.fromTime,
        toTime: currentRange.toTime,
      });
      processed = true;

      const nextState = await loadDerivedDataStateRow(db);
      await persistDerivedDataStateRow(db, {
        derived_schema_version: DERIVED_DATA_SCHEMA_VERSION,
        source_heart_count: heartCount,
        refreshed_at: formatSqliteDateTime(new Date()),
        rebuild_status:
          nextState?.pending_from_time && nextState?.pending_to_time ? 'pending' : 'idle',
        last_processed_from_time: currentRange.fromTime,
        last_processed_to_time: currentRange.toTime,
        last_error: null,
      });
    } catch (error) {
      const latestState = await loadDerivedDataStateRow(db);
      const merged = mergeTimeRange(
        latestState?.pending_from_time ?? null,
        latestState?.pending_to_time ?? null,
        currentRange.fromTime,
        currentRange.toTime,
      );
      await persistDerivedDataStateRow(db, {
        rebuild_status: 'error',
        pending_from_time: merged.fromTime,
        pending_to_time: merged.toTime,
        last_error: error instanceof Error ? error.message : 'Derived refresh failed.',
      });
      throw error;
    }
  }
}

async function loadLatestDeviceStateRow(db: SQLiteDatabase) {
  return db.getFirstAsync<DeviceStateRow>(
    `
      SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, charging_status, body_status, sync_error
      FROM device_state
      ORDER BY last_synced_at DESC
      LIMIT 1
    `,
  );
}

async function loadLatestHeartState(db: SQLiteDatabase) {
  return withAggregateReadLock(db, async () => {
    const [global, latestHeart] = await Promise.all([
      loadHeartGlobalStatsRow(db),
      db.getFirstAsync<LatestHeartRow>(
        `
          SELECT time, stress
          FROM heart_rate
          ORDER BY time DESC
          LIMIT 1
        `,
      ),
    ]);

    const latestHeartTime =
      global?.latest_heart_time && latestHeart?.time
        ? global.latest_heart_time > latestHeart.time
          ? global.latest_heart_time
          : latestHeart.time
        : global?.latest_heart_time ?? latestHeart?.time ?? null;
    const latestStress =
      latestHeartTime === latestHeart?.time
        ? latestHeart?.stress ?? null
        : global?.latest_stress ?? null;

    return {
      observed_peak_bpm: global?.observed_peak_bpm ?? null,
      latest_heart_time: latestHeartTime,
      latest_stress: latestStress,
    } satisfies HeartGlobalStatsRow;
  });
}

async function ensureDashboardAggregatesReady(db: SQLiteDatabase) {
  const ensureStartedAt = Date.now();
  await waitForAggregateMutations(db);
  const [heartCount, existingDayStat, global] = await Promise.all([
    countHeartRows(db),
    withAggregateReadLock(db, () =>
      db.getFirstAsync<{ day: string }>(
        `
          SELECT day
          FROM heart_day_stats
          LIMIT 1
        `,
      ),
    ),
    withAggregateReadLock(db, () => loadHeartGlobalStatsRow(db)),
  ]);

  if (heartCount === 0) {
    logMobilePerf('dashboard.full.ensureAggregates.empty', ensureStartedAt, {
      heartCount,
    });
    return;
  }

  if (existingDayStat && global?.latest_heart_time) {
    logMobilePerf('dashboard.full.ensureAggregates.hit', ensureStartedAt, {
      heartCount,
    });
    return;
  }

  const bounds = await db.getFirstAsync<HeartTimeBoundsRow>(
    `
      SELECT MIN(time) AS min_time, MAX(time) AS max_time
      FROM heart_rate
    `,
  );

  if (bounds?.min_time && bounds.max_time) {
    await refreshHeartDayStatsForRange(db, bounds.min_time, bounds.max_time, {
      replaceAll: true,
    });
  }

  logMobilePerf('dashboard.full.ensureAggregates.rebuild', ensureStartedAt, {
    heartCount,
  });
}

async function ensureHeartIntradayBucketsReady(db: SQLiteDatabase) {
  const ensureStartedAt = Date.now();
  await waitForAggregateMutations(db);
  const heartCount = await countHeartRows(db);

  if (heartCount === 0) {
    logMobilePerf('dashboard.full.ensureIntradayBuckets.empty', ensureStartedAt, {
      heartCount,
    });
    return;
  }

  const latestHeart = await db.getFirstAsync<TimeRow>(
    `
      SELECT time
      FROM heart_rate
      ORDER BY time DESC
      LIMIT 1
    `,
  );
  const state = await withAggregateReadLock(db, () => loadHeartIntradayBucketStateRow(db));

  if (
    state &&
    state.source_heart_count === heartCount &&
    state.source_last_heart_time === (latestHeart?.time ?? null)
  ) {
    logMobilePerf('dashboard.full.ensureIntradayBuckets.hit', ensureStartedAt, {
      heartCount,
    });
    return;
  }

  const bounds = await db.getFirstAsync<HeartTimeBoundsRow>(
    `
      SELECT MIN(time) AS min_time, MAX(time) AS max_time
      FROM heart_rate
    `,
  );

  if (bounds?.min_time && bounds.max_time) {
    await refreshHeartIntradayBucketsForRange(db, bounds.min_time, bounds.max_time, {
      replaceAll: true,
    });
  }

  logMobilePerf('dashboard.full.ensureIntradayBuckets.rebuild', ensureStartedAt, {
    heartCount,
  });
}

async function ensureWellnessDayStatsReady(db: SQLiteDatabase) {
  const ensureStartedAt = Date.now();
  await waitForAggregateMutations(db);
  const [heartCount, existingDayStat] = await Promise.all([
    countHeartRows(db),
    withAggregateReadLock(db, () =>
      db.getFirstAsync<{ day: string }>(
        `
          SELECT day
          FROM wellness_day_stats
          LIMIT 1
        `,
      ),
    ),
  ]);

  if (heartCount === 0) {
    logMobilePerf('wellness.ensureDayStats.empty', ensureStartedAt, {
      heartCount,
    });
    return;
  }

  if (existingDayStat) {
    logMobilePerf('wellness.ensureDayStats.hit', ensureStartedAt, {
      heartCount,
    });
    return;
  }

  const bounds = await db.getFirstAsync<HeartTimeBoundsRow>(
    `
      SELECT MIN(time) AS min_time, MAX(time) AS max_time
      FROM heart_rate
    `,
  );

  if (bounds?.min_time && bounds.max_time) {
    await refreshWellnessDayStatsForRange(db, bounds.min_time, bounds.max_time, {
      replaceAll: true,
    });
  }

  logMobilePerf('wellness.ensureDayStats.rebuild', ensureStartedAt, {
    heartCount,
  });
}

async function loadDashboardIntradayRows(db: SQLiteDatabase, latestHeartTime: string | null) {
  return loadIntradayHeartWindow(db, latestHeartTime);
}

async function loadIntradayHeartWindow(
  db: SQLiteDatabase,
  latestHeartTime: string | null,
): Promise<BucketedHeartWindow> {
  if (!latestHeartTime) {
    return {
      latestHeartDate: null,
      intradayStart: null,
      rawRowCount: 0,
      bucketSamples: [],
      averageBpm: null,
      sustainedPeakBpm: null,
    };
  }

  const latestHeartDate = parseSqliteDateTime(latestHeartTime);
  const intradayStart = new Date(latestHeartDate.getTime() - 24 * 3600000);
  const intradayStartSql = formatSqliteDateTime(intradayStart);
  const firstBucketStart = bucketStartForDate(intradayStart);
  const lastBucketStart = bucketStartForSqliteTime(latestHeartTime);

  if (await hasInvalidRecordedBpmRowsInRange(db, intradayStartSql, latestHeartTime)) {
    const rawRows = await queryHeartSampleRows(
      db,
      `
        SELECT bpm, time
        FROM heart_rate
        WHERE time >= ? AND time <= ?
        ORDER BY time ASC
      `,
      [intradayStartSql, latestHeartTime],
    );
    const bucketRows = buildIntradayBucketRows(rawRows);
    const rawWindow = summarizeBucketWindow(bucketRows);

    return {
      latestHeartDate,
      intradayStart,
      rawRowCount: rawWindow.rawRowCount,
      bucketSamples: rawWindow.bucketSamples,
      averageBpm: rawWindow.averageBpm,
      sustainedPeakBpm: rawWindow.sustainedPeakBpm,
    };
  }

  await ensureHeartIntradayBucketsReady(db);

  let partialFirstBucket: HeartIntradayBucketRow[] = [];
  let bucketQueryStart = firstBucketStart;

  if (intradayStartSql > firstBucketStart) {
    const firstBucketRows = await queryHeartSampleRows(
      db,
      `
        SELECT bpm, time
        FROM heart_rate
        WHERE time >= ? AND time <= ?
        ORDER BY time ASC
      `,
      [intradayStartSql, latestHeartTime < bucketEndExclusive(firstBucketStart) ? latestHeartTime : bucketEndExclusive(firstBucketStart)],
    );

    if (firstBucketRows.length > 0) {
      const summary = summarizeIntradayBucketRows(firstBucketStart, firstBucketRows);
      partialFirstBucket = summary ? [summary] : [];
    }

    bucketQueryStart = bucketEndExclusive(firstBucketStart);
  }

  const storedBuckets =
    bucketQueryStart > lastBucketStart
      ? []
      : await withAggregateReadLock(db, () =>
          db.getAllAsync<HeartIntradayBucketRow>(
            `
              SELECT
                bucket_start,
                sample_count,
                avg_bpm,
                first_bpm,
                second_bpm,
                penultimate_bpm,
                last_bpm,
                max_triplet_avg
              FROM heart_intraday_buckets
              WHERE bucket_start >= ? AND bucket_start <= ?
              ORDER BY bucket_start ASC
            `,
            bucketQueryStart,
            lastBucketStart,
          ),
        );

  const bucketRows = [...partialFirstBucket, ...storedBuckets];
  const summarizedWindow = summarizeBucketWindow(bucketRows);

  return {
    latestHeartDate,
    intradayStart,
    rawRowCount: summarizedWindow.rawRowCount,
    bucketSamples: summarizedWindow.bucketSamples,
    averageBpm: summarizedWindow.averageBpm,
    sustainedPeakBpm: summarizedWindow.sustainedPeakBpm,
  };
}

async function loadLatestSleepStagesForDashboard(db: SQLiteDatabase, latestSleep: SleepCycleRecord | null) {
  if (!latestSleep) {
    return [];
  }

  return querySleepStages(
    db,
    `
      SELECT id, sleep_id, start, end, stage, is_estimated
      FROM sleep_stage_segments
      WHERE sleep_id = ?
      ORDER BY start ASC
    `,
    [latestSleep.sleepId],
  );
}

function buildDashboardSleepCard(latestSleep: SleepCycleRecord | null, stageRecords: SleepStageRecord[]): SleepCardSnapshot {
  if (!latestSleep) {
    return {
      score: null,
      durationMinutes: null,
      timeInBedMinutes: null,
      stages: [],
      startLabel: '--',
      middleLabel: '--',
      endLabel: '--',
      isEstimated: true,
      missingReason: NO_SLEEP_REASON,
    };
  }

  const summary = summarizeSleepStages(stageRecords, latestSleep.start, latestSleep.end);

  return {
    score: latestSleep.score,
    durationMinutes: summary.timeAsleepMinutes,
    timeInBedMinutes: summary.timeInBedMinutes,
    stages: summary.stages,
    startLabel: formatClock(summary.start),
    middleLabel: axisLabelForMidpoint(summary.start, summary.end),
    endLabel: formatClock(summary.end),
    isEstimated: stageRecords.some((stage) => stage.isEstimated),
    missingReason: stageRecords.length === 0 ? LIMITED_SENSOR_REASON : null,
  };
}

async function buildFullDashboardSnapshot(db: SQLiteDatabase): Promise<DashboardSnapshot> {
  const buildStartedAt = Date.now();
  const now = new Date();
  await ensureDashboardAggregatesReady(db);
  const baselineLoadStartedAt = Date.now();
  const [heartCount, heartState, heartDayStats, sleepCycles, deviceState] = await Promise.all([
    countHeartRows(db),
    loadLatestHeartState(db),
    withAggregateReadLock(db, () => loadRecentHeartDayStats(db, 14)),
    loadRecentSleepCyclesForDashboard(db, 15),
    loadLatestDeviceStateRow(db),
  ]);
  logMobilePerf('dashboard.full.loadBaseline', baselineLoadStartedAt, {
    heartCount,
    heartDays: heartDayStats.length,
    sleepCycles: sleepCycles.length,
  });

  if (heartCount === 0) {
    logMobilePerf('dashboard.full.total', buildStartedAt, {
      heartCount,
    });
    return buildEmptyDashboardSnapshot(now, deviceState);
  }

  const latestSleep = sleepCycles.at(-1) ?? null;
  const detailLoadStartedAt = Date.now();
  const [intraday, stageRecords] = await Promise.all([
    loadDashboardIntradayRows(db, heartState.latest_heart_time),
    loadLatestSleepStagesForDashboard(db, latestSleep),
  ]);
  logMobilePerf('dashboard.full.loadDetail', detailLoadStartedAt, {
    intradayRows: intraday.rawRowCount,
    stageRecords: stageRecords.length,
  });

  const computeStartedAt = Date.now();
  const dailyMinima = heartDayStats.map((stat) => stat.minBpm);
  const restingHr = personalizeRestingHr(sleepCycles, dailyMinima);
  const recovery = estimateRecoveryScoreFromSleeps(latestSleep, sleepCycles, heartState.latest_stress);
  const heartCardSeries =
    intraday.bucketSamples.length > 0
      ? createTimeBuckets(
          intraday.bucketSamples,
          DASHBOARD_HEART_BUCKET_MINUTES,
          intraday.intradayStart ?? undefined,
          intraday.latestHeartDate ?? undefined,
        )
      : [];
  const sleepCard = buildDashboardSleepCard(latestSleep, stageRecords);
  const latestHeartDate = intraday.latestHeartDate ?? now;
  const dayStatsByDay = new Map(heartDayStats.map((stat) => [stat.day, stat]));
  const todayStrain = dayStatsByDay.get(dateKey(latestHeartDate))?.strainScore ?? null;
  const strainSeries = buildFilledDailySeries('14d', latestHeartDate, (day) => dayStatsByDay.get(day)?.strainScore ?? null);
  logMobilePerf('dashboard.full.computeCards', computeStartedAt, {
    intradayPoints: heartCardSeries.length,
    strainPoints: strainSeries.length,
    hasSleep: latestSleep !== null,
  });

  const snapshot = {
    greeting: greetingForHour(now.getHours()),
    dateLabel: formatLongDate(now),
    recovery: {
      score: recovery.score,
      label: describeRecovery(recovery.score),
      caption: 'Recovery',
      isEstimated: true,
      missingReason: recovery.missingReason,
      breakdown: recovery.breakdown,
    },
    summaryStats: [
      {
        label: 'HRV',
        value: formatMetricNumber(latestSleep?.avgHrv ?? null, 'ms'),
        accent: 'green',
        missingReason: latestSleep ? null : NO_SLEEP_REASON,
      },
      {
        label: 'RHR',
        value: formatMetricNumber(restingHr, 'bpm'),
        accent: 'cyan',
      },
      {
        label: 'Sleep',
        value: sleepCard.durationMinutes !== null ? formatMetricNumber(sleepCard.durationMinutes, '').replace(' ', '') : '--',
        accent: 'violet',
        missingReason: latestSleep ? null : NO_SLEEP_REASON,
      },
    ],
    heartCard: {
      restingHr,
      averageHr: intraday.averageBpm,
      maxHr: intraday.sustainedPeakBpm,
      series: heartCardSeries,
      missingReason: heartCardSeries.length === 0 ? NO_HISTORY_REASON : null,
    },
    sleepCard,
    strainCard: {
      score: todayStrain,
      label: todayStrain === null ? 'Waiting for effort' : todayStrain >= 14 ? 'Loaded' : todayStrain >= 8 ? 'Building' : 'Light',
      series: strainSeries,
      isEstimated: true,
      missingReason: strainSeries.length === 0 ? NO_HISTORY_REASON : null,
    },
    lastSyncLabel: dashboardSyncLabel(deviceState),
  } satisfies DashboardSnapshot;

  logMobilePerf('dashboard.full.total', buildStartedAt, {
    heartCount,
  });

  return snapshot;
}

async function buildPostSyncHeartOnlySnapshot(db: SQLiteDatabase): Promise<DashboardSnapshot> {
  const now = new Date();
  const [heartCount, cached, deviceState, heartState] = await Promise.all([
    countHeartRows(db),
    loadDashboardSnapshotCacheRow(db),
    loadLatestDeviceStateRow(db),
    loadLatestHeartState(db),
  ]);

  if (heartCount === 0) {
    return buildEmptyDashboardSnapshot(now, deviceState);
  }

  const baseSnapshot = cached ? parseDashboardSnapshot(cached.snapshot_json) : null;
  const baseline = baseSnapshot ?? buildEmptyDashboardSnapshot(now, deviceState);
  const intraday = await loadDashboardIntradayRows(db, heartState.latest_heart_time);

  return {
    ...baseline,
    greeting: greetingForHour(now.getHours()),
    dateLabel: formatLongDate(now),
    heartCard: {
      ...baseline.heartCard,
      averageHr: intraday.averageBpm ?? baseline.heartCard.averageHr,
      maxHr: intraday.sustainedPeakBpm ?? baseline.heartCard.maxHr,
      series:
        intraday.bucketSamples.length > 0
          ? createTimeBuckets(
              intraday.bucketSamples,
              DASHBOARD_HEART_BUCKET_MINUTES,
              intraday.intradayStart ?? undefined,
              intraday.latestHeartDate ?? undefined,
            )
          : baseline.heartCard.series,
      missingReason:
        intraday.bucketSamples.length > 0 ? null : baseline.heartCard.missingReason,
    },
    lastSyncLabel: dashboardSyncLabel(deviceState),
  };
}

export async function refreshDashboardSnapshot(
  db: SQLiteDatabase,
  mode: 'full' | 'post_sync_heart_only',
): Promise<boolean> {
  const refreshStartedAt = Date.now();
  const heartCount = await countHeartRows(db);
  if (heartCount === 0) {
    return false;
  }

  const [snapshot, heartState, derivedState] = await Promise.all([
    mode === 'full' ? buildFullDashboardSnapshot(db) : buildPostSyncHeartOnlySnapshot(db),
    loadLatestHeartState(db),
    loadDerivedDataStateRow(db),
  ]);

  const persistStartedAt = Date.now();
  await persistDashboardSnapshotCacheRow(db, {
    snapshot_json: JSON.stringify(snapshot),
    snapshot_kind: mode,
    built_at: formatSqliteDateTime(new Date()),
    source_heart_count: heartCount,
    source_last_heart_time: heartState.latest_heart_time,
    derived_refreshed_at: derivedState?.refreshed_at ?? null,
    last_error: null,
  });
  logMobilePerf(`dashboard.refresh.${mode}.persistCache`, persistStartedAt, {
    heartCount,
  });

  logMobilePerf(`dashboard.refresh.${mode}`, refreshStartedAt, {
    heartCount,
  });

  return true;
}

export async function clearDashboardAggregatesForDebug(db: SQLiteDatabase) {
  await withExclusiveTransaction(db, async (tx) => {
    await tx.execAsync(`
      DELETE FROM heart_day_stats;
      DELETE FROM heart_global_stats;
      DELETE FROM heart_intraday_buckets;
      DELETE FROM heart_intraday_bucket_state;
      DELETE FROM wellness_day_stats;
    `);
  });
}

export async function rebuildAggregateTablesForDebug(db: SQLiteDatabase): Promise<boolean> {
  const rebuildStartedAt = Date.now();
  const heartCount = await countHeartRows(db);

  if (heartCount === 0) {
    await clearDashboardAggregatesForDebug(db);
    logMobilePerf('aggregates.debug.rebuild.empty', rebuildStartedAt, {
      heartCount,
    });
    return false;
  }

  const bounds = await db.getFirstAsync<HeartTimeBoundsRow>(
    `
      SELECT MIN(time) AS min_time, MAX(time) AS max_time
      FROM heart_rate
    `,
  );

  if (!bounds?.min_time || !bounds.max_time) {
    await clearDashboardAggregatesForDebug(db);
    logMobilePerf('aggregates.debug.rebuild.empty', rebuildStartedAt, {
      heartCount,
    });
    return false;
  }

  await refreshHeartIntradayBucketsForRange(db, bounds.min_time, bounds.max_time, {
    replaceAll: true,
  });
  await refreshHeartDayStatsForRange(db, bounds.min_time, bounds.max_time, {
    replaceAll: true,
  });
  await refreshWellnessDayStatsForRange(db, bounds.min_time, bounds.max_time, {
    replaceAll: true,
  });

  logMobilePerf('aggregates.debug.rebuild', rebuildStartedAt, {
    heartCount,
  });

  return true;
}

export async function primeDashboardSnapshot(db: SQLiteDatabase): Promise<boolean> {
  const existing = await loadDashboardSnapshotCacheRow(db);
  const heartCount = await countHeartRows(db);

  if (heartCount === 0) {
    return false;
  }

  const derivedState = await loadDerivedDataStateRow(db);
  const canPrimeSupportingAggregates =
    !derivedState ||
    (derivedState.derived_schema_version === DERIVED_DATA_SCHEMA_VERSION &&
      derivedState.rebuild_status === 'idle' &&
      derivedState.pending_from_time === null &&
      derivedState.pending_to_time === null);

  if (existing && parseDashboardSnapshot(existing.snapshot_json)) {
    if (canPrimeSupportingAggregates) {
      await ensureWellnessDayStatsReady(db);
    }

    return false;
  }

  const mode =
    derivedState &&
    derivedState.derived_schema_version === DERIVED_DATA_SCHEMA_VERSION &&
    derivedState.rebuild_status === 'idle' &&
    derivedState.pending_from_time === null &&
    derivedState.pending_to_time === null
      ? 'full'
      : 'post_sync_heart_only';

  const primed = await refreshDashboardSnapshot(db, mode);

  if (canPrimeSupportingAggregates) {
    await ensureWellnessDayStatsReady(db);
  }

  return primed;
}

export class SQLiteHealthRepository implements HealthRepository {
  private preparePromise: Promise<void> | null = null;
  private mutationPromise: Promise<void> | null = null;
  private readonly snapshotCache = new Map<string, Promise<unknown>>();
  private readonly queryCache = new Map<string, Promise<unknown>>();

  constructor(private readonly db: SQLiteDatabase) {}

  private async runRepositoryMutation<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.mutationPromise ?? Promise.resolve();
    const next = previous.catch(() => {}).then(callback);
    const settled = next.then(
      () => {},
      () => {},
    );

    this.mutationPromise = settled;

    try {
      return await next;
    } finally {
      if (this.mutationPromise === settled) {
        this.mutationPromise = null;
      }
    }
  }

  private async waitForRepositoryMutations() {
    if (this.mutationPromise) {
      await this.mutationPromise;
    }
  }

  private async readCached<T>(cache: Map<string, Promise<unknown>>, key: string, loader: () => Promise<T>) {
    const existing = cache.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const pending = loader().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }

  private readSnapshot<T>(key: string, loader: () => Promise<T>) {
    return this.readCached(this.snapshotCache, key, loader);
  }

  private readQuery<T>(key: string, loader: () => Promise<T>) {
    return this.readCached(this.queryCache, key, loader);
  }

  invalidateCaches(scope: HealthCacheScope | readonly HealthCacheScope[] = 'all') {
    const scopes = Array.isArray(scope) ? scope : [scope];

    if (scopes.includes('all')) {
      this.snapshotCache.clear();
      this.queryCache.clear();
      return;
    }

    for (const key of this.snapshotCache.keys()) {
      for (const candidate of scopes) {
        if (key === candidate || key.startsWith(`${candidate}:`)) {
          this.snapshotCache.delete(key);
          break;
        }
      }
    }

    this.queryCache.clear();
  }

  private async ensurePrepared() {
    if (this.preparePromise) {
      await this.preparePromise;
      return;
    }

    this.preparePromise = (async () => {
      const ensureStartedAt = Date.now();
      try {
        if (await shouldRefreshDerivedData(this.db)) {
          const processed = await processPendingDerivedRefresh(this.db);
          if (processed) {
            await refreshDashboardSnapshot(this.db, 'full');
            this.invalidateCaches(['dashboard', 'sleep', 'wellness', 'derived']);
          } else {
            this.invalidateCaches('derived');
          }
        }
        logMobilePerf('repository.ensurePrepared', ensureStartedAt);
      } catch (error) {
        logMobilePerfError('repository.ensurePrepared', error);
        throw error;
      } finally {
        this.preparePromise = null;
      }
    })();

    await this.preparePromise;
  }

  async getDerivedRefreshState(): Promise<DerivedRefreshState> {
    return this.readQuery('derived:state', async () => {
      await this.waitForRepositoryMutations();

      const state = await loadDerivedDataStateRow(this.db);

      if (state) {
        return derivedRefreshStateFromRow(state);
      }

      const heartCount = await countHeartRows(this.db);
      if (heartCount === 0) {
        return derivedRefreshStateFromRow(null);
      }

      return {
        status: 'pending',
        pendingFromTime: null,
        pendingToTime: null,
        lastProcessedFromTime: null,
        lastProcessedToTime: null,
        lastError: null,
        isFirstSync: true,
      };
    });
  }

  async primeDashboardSnapshot(): Promise<boolean> {
    return this.runRepositoryMutation(async () => {
      const primed = await primeDashboardSnapshot(this.db);

      if (primed) {
        this.invalidateCaches('dashboard');
      }

      return primed;
    });
  }

  async refreshDashboardSnapshot(mode: 'full' | 'post_sync_heart_only'): Promise<boolean> {
    return this.runRepositoryMutation(async () => {
      const refreshed = await refreshDashboardSnapshot(this.db, mode);

      if (refreshed) {
        this.invalidateCaches('dashboard');
      }

      return refreshed;
    });
  }

  async processPendingDerivedRefresh(): Promise<boolean> {
    return this.runRepositoryMutation(async () => {
      const processed = await processPendingDerivedRefresh(this.db);

      if (processed) {
        await refreshDashboardSnapshot(this.db, 'full');
        this.invalidateCaches(['dashboard', 'sleep', 'wellness', 'derived']);
      } else {
        this.invalidateCaches('derived');
      }

      return processed;
    });
  }

  private async loadLatestHeartDate() {
    const row = await this.readQuery<TimeRow | null>('heart:latest-time', () =>
      this.db.getFirstAsync<TimeRow>('SELECT time FROM heart_rate ORDER BY time DESC LIMIT 1'),
    );
    return row ? parseSqliteDateTime(row.time) : null;
  }

  private async loadAllHeartRows() {
    return this.readQuery('heart:all-rows', () =>
      queryHeartRows(
        this.db,
        'SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data FROM heart_rate ORDER BY time ASC',
      ),
    );
  }

  private async loadHeartRowsSince(start: Date, cacheKey: string) {
    const startSql = formatSqliteDateTime(start);
    return this.readQuery(cacheKey, () =>
      queryHeartRows(
        this.db,
        `
          SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data
          FROM heart_rate
          WHERE time >= ?
          ORDER BY time ASC
        `,
        [startSql],
      ),
    );
  }

  private async loadWellnessMetricDayAggregatesSince(start: Date, cacheKey: string) {
    const startDay = dateKey(start);
    return this.readQuery(cacheKey, () =>
      withAggregateReadLock(this.db, () =>
        this.db.getAllAsync<WellnessMetricDayAggregateRow>(
          `
            SELECT
              day,
              avg_stress,
              avg_spo2,
              avg_skin_temp
            FROM wellness_day_stats
            WHERE day >= ?
            ORDER BY day ASC
          `,
          startDay,
        ),
      ),
    );
  }

  private async loadWellnessMetricSummarySince(start: Date, cacheKey: string) {
    const startSql = formatSqliteDateTime(start);
    const startDay = dateKey(start);
    return this.readQuery(cacheKey, () =>
      withAggregateReadLock(this.db, () =>
        this.db.getFirstAsync<WellnessMetricSummaryRow>(
          `
            SELECT
              COALESCE(SUM(stress_count), 0) AS stress_count,
              CASE
                WHEN COALESCE(SUM(stress_count), 0) = 0 THEN NULL
                ELSE SUM(avg_stress * stress_count) / SUM(stress_count)
              END AS avg_stress,
              (SELECT stress FROM heart_rate WHERE time >= ? AND stress IS NOT NULL ORDER BY time DESC LIMIT 1) AS latest_stress,
              COALESCE(SUM(spo2_count), 0) AS spo2_count,
              CASE
                WHEN COALESCE(SUM(spo2_count), 0) = 0 THEN NULL
                ELSE SUM(avg_spo2 * spo2_count) / SUM(spo2_count)
              END AS avg_spo2,
              (SELECT spo2 FROM heart_rate WHERE time >= ? AND spo2 IS NOT NULL ORDER BY time DESC LIMIT 1) AS latest_spo2,
              COALESCE(SUM(skin_temp_count), 0) AS skin_temp_count,
              CASE
                WHEN COALESCE(SUM(skin_temp_count), 0) = 0 THEN NULL
                ELSE SUM(avg_skin_temp * skin_temp_count) / SUM(skin_temp_count)
              END AS avg_skin_temp,
              (SELECT skin_temp FROM heart_rate WHERE time >= ? AND skin_temp IS NOT NULL ORDER BY time DESC LIMIT 1) AS latest_skin_temp
            FROM wellness_day_stats
            WHERE day >= ?
          `,
          startSql,
          startSql,
          startSql,
          startDay,
        ),
      ),
    );
  }

  private async loadRecentWellnessMetricValuesSince(
    start: Date,
    metric: 'stress' | 'spo2' | 'skin_temp',
    limit: number,
    cacheKey: string,
  ) {
    const startSql = formatSqliteDateTime(start);
    const sql =
      metric === 'stress'
        ? `
            SELECT stress AS value
            FROM heart_rate
            WHERE time >= ? AND stress IS NOT NULL
            ORDER BY time DESC
            LIMIT ?
          `
        : metric === 'spo2'
          ? `
              SELECT spo2 AS value
              FROM heart_rate
              WHERE time >= ? AND spo2 IS NOT NULL
              ORDER BY time DESC
              LIMIT ?
            `
          : `
              SELECT skin_temp AS value
              FROM heart_rate
              WHERE time >= ? AND skin_temp IS NOT NULL
              ORDER BY time DESC
              LIMIT ?
            `;

    return this.readQuery(cacheKey, async () => {
      const rows = await this.db.getAllAsync<NullableNumberRow>(sql, startSql, limit);
      return rows.map((row) => row.value).filter((value): value is number => value !== null);
    });
  }

  private async loadHeartSamplesBetween(start: Date, end: Date, cacheKey: string) {
    return this.readQuery(cacheKey, () =>
      queryHeartSamples(
        this.db,
        `
          SELECT bpm, time
          FROM heart_rate
          WHERE time >= ? AND time <= ?
          ORDER BY time ASC
        `,
        [formatSqliteDateTime(start), formatSqliteDateTime(end)],
      ),
    );
  }

  private async loadHeartBucketRowsBetween(start: Date, end: Date, cacheKey: string) {
    const startBucket = bucketStartForDate(start);
    const endBucket = bucketStartForDate(end);

    return this.readQuery(cacheKey, async () => {
      return withAggregateReadLock(this.db, () =>
        this.db.getAllAsync<HeartIntradayBucketRow>(
          `
            SELECT
              bucket_start,
              sample_count,
              avg_bpm,
              first_bpm,
              second_bpm,
              penultimate_bpm,
              last_bpm,
              max_triplet_avg
            FROM heart_intraday_buckets
            WHERE bucket_start >= ? AND bucket_start <= ?
            ORDER BY bucket_start ASC
          `,
          startBucket,
          endBucket,
        ),
      );
    });
  }

  private async loadDailyHeartMinima() {
    return this.readQuery('heart:daily-minima', async () => {
      let rows = await withAggregateReadLock(this.db, () =>
        this.db.getAllAsync<DailyMinimaRow>(
          `
            SELECT day, min_bpm
            FROM heart_day_stats
            ORDER BY day ASC
          `,
        ),
      );

      if (rows.length === 0 && (await countHeartRows(this.db)) > 0) {
        await ensureDashboardAggregatesReady(this.db);
        rows = await withAggregateReadLock(this.db, () =>
          this.db.getAllAsync<DailyMinimaRow>(
            `
              SELECT day, min_bpm
              FROM heart_day_stats
              ORDER BY day ASC
            `,
          ),
        );
      }

      return rows;
    });
  }

  private async loadRecentSleepCycles(limit: number) {
    return this.readQuery(`sleep-cycles:recent:${limit}`, async () => {
      const rows = await querySleepCycles(
        this.db,
        `
          SELECT id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, avg_skin_temp, score
          FROM sleep_cycles
          ORDER BY start DESC
          LIMIT ?
        `,
        [limit],
      );
      return rows.reverse();
    });
  }

  private async loadSleepStagesForIds(sleepIds: readonly string[]) {
    if (sleepIds.length === 0) {
      return [];
    }

    const sortedIds = [...sleepIds].sort();
    const placeholders = buildInClause(sortedIds);
    return this.readQuery(`sleep-stages:${sortedIds.join('|')}`, () =>
      querySleepStages(
        this.db,
        `
          SELECT id, sleep_id, start, end, stage, is_estimated
          FROM sleep_stage_segments
          WHERE sleep_id IN (${placeholders})
          ORDER BY start ASC
        `,
        sortedIds,
      ),
    );
  }

  private async loadDeviceStateRow() {
    return this.readQuery('device-state:latest', () =>
      this.db.getFirstAsync<DeviceStateRow>(
        `
          SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, charging_status, body_status, sync_error
          FROM device_state
          ORDER BY last_synced_at DESC
          LIMIT 1
        `,
      ),
    );
  }

  private async loadNapActivitiesSince(start: Date) {
    return queryActivities(
      this.db,
      `
        SELECT id, period_id, start, end, activity
        FROM activities
        WHERE activity = 'Nap' AND start >= ?
        ORDER BY start ASC
      `,
      [formatSqliteDateTime(start)],
    );
  }

  private async loadRecentActivities(limit: number) {
    return this.readQuery(`activities:recent:${limit}`, () =>
      queryActivities(
        this.db,
        `
          SELECT id, period_id, start, end, activity
          FROM activities
          ORDER BY start DESC
          LIMIT ?
        `,
        [limit],
      ),
    );
  }

  async getDashboardSnapshot(): Promise<DashboardSnapshot> {
    return this.readSnapshot('dashboard', async () => {
      const startedAt = Date.now();
      try {
        await this.waitForRepositoryMutations();

        const cached = await loadDashboardSnapshotCacheRow(this.db);
        const parsed = cached ? parseDashboardSnapshot(cached.snapshot_json) : null;
        if (parsed) {
          if (shouldRepairCachedHeartCard(parsed)) {
            await refreshDashboardSnapshot(this.db, 'post_sync_heart_only');
            const repaired = await loadDashboardSnapshotCacheRow(this.db);
            const repairedSnapshot = repaired ? parseDashboardSnapshot(repaired.snapshot_json) : null;

            if (repairedSnapshot) {
              logMobilePerf('repository.getDashboardSnapshot.cacheRepair', startedAt, {
                snapshotKind: repaired?.snapshot_kind ?? null,
              });
              return repairedSnapshot;
            }
          }

          logMobilePerf('repository.getDashboardSnapshot.cacheHit', startedAt, {
            snapshotKind: cached?.snapshot_kind ?? null,
          });
          return parsed;
        }

        const deviceState = await loadLatestDeviceStateRow(this.db);
        const heartCount = await countHeartRows(this.db);
        if (heartCount === 0) {
          logMobilePerf('repository.getDashboardSnapshot.empty', startedAt);
          return buildEmptyDashboardSnapshot(new Date(), deviceState);
        }

        await primeDashboardSnapshot(this.db);
        const primed = await loadDashboardSnapshotCacheRow(this.db);
        const primedSnapshot = primed ? parseDashboardSnapshot(primed.snapshot_json) : null;
        logMobilePerf('repository.getDashboardSnapshot.primed', startedAt, {
          snapshotKind: primed?.snapshot_kind ?? null,
        });
        return primedSnapshot ?? buildEmptyDashboardSnapshot(new Date(), deviceState);
      } catch (error) {
        logMobilePerfError('repository.getDashboardSnapshot', error);
        throw error;
      }
    });
  }

  async setTargetWakeMinutes(minutes: number): Promise<void> {
    await this.runRepositoryMutation(async () => {
      const nextTargetWakeMinutes = roundClockMinutes(
        normalizeClockMinutes(minutes),
        SLEEP_TARGET_STEP_MINUTES,
      );
      await persistSleepPreferences(this.db, {
        targetWakeMinutes: nextTargetWakeMinutes,
        alarmEnabled: false,
      });
      this.invalidateCaches('sleep');
    });
  }

  async enableAlarm(targetWakeMinutes: number): Promise<void> {
    await this.runRepositoryMutation(async () => {
      const nextTargetWakeMinutes = roundClockMinutes(
        normalizeClockMinutes(targetWakeMinutes),
        SLEEP_TARGET_STEP_MINUTES,
      );
      await persistSleepPreferences(this.db, {
        targetWakeMinutes: nextTargetWakeMinutes,
        alarmEnabled: true,
      });
      this.invalidateCaches('sleep');
    });
  }

  async disableAlarm(targetWakeMinutes: number): Promise<void> {
    await this.runRepositoryMutation(async () => {
      const nextTargetWakeMinutes = roundClockMinutes(
        normalizeClockMinutes(targetWakeMinutes),
        SLEEP_TARGET_STEP_MINUTES,
      );
      await persistSleepPreferences(this.db, {
        targetWakeMinutes: nextTargetWakeMinutes,
        alarmEnabled: false,
      });
      this.invalidateCaches('sleep');
    });
  }

  async getSleepHistory(range: HistoryRange): Promise<SleepHistorySnapshot> {
    return this.readSnapshot(`sleep:${range}`, async () => {
      const startedAt = Date.now();
      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();

        const sleepCycles = await this.loadRecentSleepCycles(Math.max(rangeDays(range), 15));
        const preferences = await loadSleepPreferences(this.db, sleepCycles);
        const latestSleepForPlan = sleepCycles.at(-1) ?? null;
        const napActivities = latestSleepForPlan ? await this.loadNapActivitiesSince(latestSleepForPlan.end) : [];
        const sleepPlan = buildSleepPlanSnapshot(preferences, sleepCycles, napActivities);
        const sessions = sleepCycles.slice(-rangeDays(range)).reverse();
        const latestSleep = sessions[0] ?? null;

        if (!latestSleep) {
          logMobilePerf('repository.getSleepHistory.empty', startedAt, {
            range,
          });
          return {
            headlineScore: null,
            headlineLabel: 'Waiting for sleep',
            bedtime: '--',
            wakeTime: '--',
            durationMinutes: null,
            timeInBedMinutes: null,
            bedtimeConsistency: null,
            wakeConsistency: null,
            scoreTrend: [],
            durationTrend: [],
            sessions: [],
            sleepPlan,
            isEstimated: true,
            missingReason: NO_SLEEP_REASON,
          };
        }

        const stageRecords = await this.loadSleepStagesForIds(sessions.map((session) => session.sleepId));
        const bedtimeValues = sessions.map((session) => session.start.getHours() * 60 + session.start.getMinutes());
        const wakeValues = sessions.map((session) => session.end.getHours() * 60 + session.end.getMinutes());
        const bedtimeMean = mean(bedtimeValues);
        const wakeMean = mean(wakeValues);
        const bedtimeConsistency = clamp(100 - stdDev(bedtimeValues, bedtimeMean) / Math.max(1, bedtimeMean) * 100, 0, 100);
        const wakeConsistency = clamp(100 - stdDev(wakeValues, wakeMean) / Math.max(1, wakeMean) * 100, 0, 100);

        const mappedSessions: SleepSession[] = sessions.map((session) => {
          const summary = summarizeSleepStages(
            stageRecords.filter((stage) => stage.sleepId === session.sleepId),
            session.start,
            session.end,
          );

          return {
            id: session.id,
            dateLabel: formatShortDate(session.end),
            score: session.score,
            bedtime: formatClock(summary.start),
            wakeTime: formatClock(summary.end),
            durationMinutes: summary.timeAsleepMinutes,
            timeInBedMinutes: summary.timeInBedMinutes,
            efficiency: session.score,
            remMinutes: summary.remMinutes,
            deepMinutes: summary.deepMinutes,
            consistency: Math.round((bedtimeConsistency + wakeConsistency) / 2),
            stages: summary.stages,
            isEstimated: true,
            missingReason: summary.stages.length === 0 ? LIMITED_SENSOR_REASON : null,
            minBpm: session.minBpm,
            maxBpm: session.maxBpm,
            avgHrv: session.avgHrv,
          };
        });
        const sleepScoreByDay = new Map(sessions.map((session) => [dateKey(session.end), session.score]));
        const sleepDurationByDay = new Map(
          sessions.map((session, index) => [dateKey(session.end), mappedSessions[index]?.durationMinutes ?? minutesBetween(session.start, session.end)]),
        );
        const latestSession = mappedSessions[0] ?? null;

        const snapshot = {
          headlineScore: latestSession?.score ?? latestSleep.score,
          headlineLabel: describeSleepScore(latestSession?.score ?? latestSleep.score),
          bedtime: latestSession?.bedtime ?? formatClock(latestSleep.start),
          wakeTime: latestSession?.wakeTime ?? formatClock(latestSleep.end),
          durationMinutes: latestSession?.durationMinutes ?? minutesBetween(latestSleep.start, latestSleep.end),
          timeInBedMinutes: latestSession?.timeInBedMinutes ?? minutesBetween(latestSleep.start, latestSleep.end),
          bedtimeConsistency: Math.round(bedtimeConsistency),
          wakeConsistency: Math.round(wakeConsistency),
          scoreTrend: buildFilledDailySeries(range, latestSleep.end, (day) => sleepScoreByDay.get(day) ?? null),
          durationTrend: buildFilledDailySeries(range, latestSleep.end, (day) => sleepDurationByDay.get(day) ?? null),
          sessions: mappedSessions,
          sleepPlan,
          isEstimated: true,
        } satisfies SleepHistorySnapshot;
        logMobilePerf('repository.getSleepHistory', startedAt, {
          range,
          sessions: snapshot.sessions.length,
        });
        return snapshot;
      } catch (error) {
        logMobilePerfError('repository.getSleepHistory', error, {
          range,
        });
        throw error;
      }
    });
  }

  async getHeartHistory(range: HistoryRange): Promise<HeartHistorySnapshot> {
    return this.readSnapshot(`heart:${range}`, async () => {
      const startedAt = Date.now();
      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();
        await waitForAggregateMutations(this.db);

        const [latestHeartDate, dailyMinimaRows, sleepCycles] = await Promise.all([
          this.loadLatestHeartDate(),
          this.loadDailyHeartMinima(),
          this.loadRecentSleepCycles(14),
        ]);

        if (!latestHeartDate || dailyMinimaRows.length === 0) {
          logMobilePerf('repository.getHeartHistory.empty', startedAt, {
            range,
          });
          return {
            restingHr: null,
            averageHr: null,
            maxHr: null,
            intraday: [],
            weeklyResting: [],
            recoveryShift: null,
            missingReason: NO_HISTORY_REASON,
          };
        }

        const intradayStart = new Date(latestHeartDate.getTime() - 24 * 3600000);
        const intraday = await loadIntradayHeartWindow(this.db, formatSqliteDateTime(latestHeartDate));
        const sanitizedDailyMinimaRows = dailyMinimaRows.map((row) => ({
          day: row.day,
          min_bpm: sanitizeRecordedBpm(row.min_bpm),
        }));
        const dailyMinima = sanitizedDailyMinimaRows
          .map((row) => row.min_bpm)
          .filter((value): value is number => value !== null);
        const restingHr = personalizeRestingHr(sleepCycles, dailyMinima);
        const dailyMinimaByDay = new Map(sanitizedDailyMinimaRows.map((row) => [row.day, row.min_bpm]));
        const weeklyResting = buildFilledDailySeries(range, latestHeartDate, (day) => dailyMinimaByDay.get(day) ?? null);
        const previousMedian = median(trendValues(weeklyResting.slice(0, -1)));

        const snapshot = {
          restingHr,
          averageHr: intraday.averageBpm,
          maxHr: intraday.sustainedPeakBpm,
          intraday: createTimeBuckets(
            intraday.bucketSamples,
            HEART_INTRADAY_BUCKET_MINUTES,
            intraday.intradayStart ?? intradayStart,
            latestHeartDate,
          ),
          weeklyResting,
          recoveryShift: previousMedian === null ? null : restingHr - previousMedian,
        } satisfies HeartHistorySnapshot;
        logMobilePerf('repository.getHeartHistory', startedAt, {
          range,
          intradayPoints: snapshot.intraday.length,
        });
        return snapshot;
      } catch (error) {
        logMobilePerfError('repository.getHeartHistory', error, {
          range,
        });
        throw error;
      }
    });
  }

  async getWellnessSnapshot(range: HistoryRange): Promise<WellnessSnapshot> {
    return this.readSnapshot(`wellness:${range}`, async () => {
      const startedAt = Date.now();
      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();
        await waitForAggregateMutations(this.db);
        await ensureWellnessDayStatsReady(this.db);

        const baselineStartedAt = Date.now();
        const [recentSleepCycles, recentActivities, dailyMinimaRows, heartState] = await Promise.all([
          this.loadRecentSleepCycles(rangeDays(range)),
          this.loadRecentActivities(5),
          this.loadDailyHeartMinima(),
          loadLatestHeartState(this.db),
        ]);
        const latestHeartDate = heartState.latest_heart_time
          ? parseSqliteDateTime(heartState.latest_heart_time)
          : null;
        logMobilePerf('repository.getWellnessSnapshot.loadBaseline', baselineStartedAt, {
          range,
          heartDays: dailyMinimaRows.length,
          sleepCycles: recentSleepCycles.length,
          activities: recentActivities.length,
        });

        if (!latestHeartDate || dailyMinimaRows.length === 0) {
          const emptyMetric = (title: string, accent: MetricSeries['accent']): MetricSeries => ({
            title,
            latest: null,
            average: null,
            delta: null,
            unit: '',
            detail: NO_HISTORY_REASON,
            accent,
            series: [],
            missingReason: NO_HISTORY_REASON,
          });

          logMobilePerf('repository.getWellnessSnapshot.empty', startedAt, {
            range,
          });
          return {
            stress: emptyMetric('Stress', 'alert'),
            spo2: emptyMetric('SpO2', 'cyan'),
            skinTemperature: emptyMetric('Skin Temperature', 'heart'),
            recoveryIndex: emptyMetric('Recovery Index', 'green'),
            activities: [],
            missingReason: NO_HISTORY_REASON,
          };
        }

        const earliestRelevantTimestamp = Math.min(
          latestHeartDate.getTime() - rangeDays(range) * 24 * 3600000,
          recentSleepCycles[0]?.start.getTime() ?? latestHeartDate.getTime(),
          recentActivities.at(-1)?.start.getTime() ?? latestHeartDate.getTime(),
        );
        const earliestRelevantDate = new Date(earliestRelevantTimestamp);
        const earliestRelevantSql = formatSqliteDateTime(earliestRelevantDate);
        const metricRowsStartedAt = Date.now();
        const [metricDayAggregates, metricSummary, recentStressValues, recentSpo2Values, recentSkinTempValues] = await Promise.all([
          this.loadWellnessMetricDayAggregatesSince(
            earliestRelevantDate,
            `wellness:metric-days:${range}:${earliestRelevantSql}`,
          ),
          this.loadWellnessMetricSummarySince(
            earliestRelevantDate,
            `wellness:metric-summary:${range}:${earliestRelevantSql}`,
          ),
          this.loadRecentWellnessMetricValuesSince(
            earliestRelevantDate,
            'stress',
            8,
            `wellness:metric-recent:stress:${range}:${earliestRelevantSql}`,
          ),
          this.loadRecentWellnessMetricValuesSince(
            earliestRelevantDate,
            'spo2',
            8,
            `wellness:metric-recent:spo2:${range}:${earliestRelevantSql}`,
          ),
          this.loadRecentWellnessMetricValuesSince(
            earliestRelevantDate,
            'skin_temp',
            8,
            `wellness:metric-recent:skin_temp:${range}:${earliestRelevantSql}`,
          ),
        ]);
        logMobilePerf('repository.getWellnessSnapshot.loadMetricRows', metricRowsStartedAt, {
          range,
          dayRows: metricDayAggregates.length,
        });

        const activityRowsStartedAt = Date.now();
        await ensureHeartIntradayBucketsReady(this.db);
        const activityHeartBuckets = await Promise.all(
          recentActivities.map((activity) =>
            this.loadHeartBucketRowsBetween(
              activity.start,
              activity.end,
              `wellness:activity-buckets:${activity.id}:${formatSqliteDateTime(activity.start)}:${formatSqliteDateTime(activity.end)}`,
            ),
          ),
        );
        logMobilePerf('repository.getWellnessSnapshot.loadActivityRows', activityRowsStartedAt, {
          range,
          activities: recentActivities.length,
          bucketRows: activityHeartBuckets.reduce((sum, rows) => sum + rows.length, 0),
          samples: activityHeartBuckets.reduce((sum, rows) => sum + totalBucketSampleCount(rows), 0),
        });

        const computeStartedAt = Date.now();
        const latestSleep = recentSleepCycles.at(-1) ?? null;
        const restingHr = personalizeRestingHr(recentSleepCycles, dailyMinimaRows.map((row) => row.min_bpm));
        const maxHr = personalizeMaxHrFromObservedPeak(heartState.observed_peak_bpm, restingHr);
        const latestStress = heartState.latest_stress;
        const recoveryByDay = new Map(
          recentSleepCycles.map((sleep, index, sleeps) => [
            dateKey(sleep.end),
            estimateRecoveryScoreFromSleeps(sleep, sleeps.slice(0, index + 1), latestStress).score,
          ]),
        );
        const recoveryTrend =
          latestSleep === null
            ? []
            : buildFilledDailySeries(range, latestSleep.end, (day) => recoveryByDay.get(day) ?? null);
        const stressByDay = new Map(metricDayAggregates.map((row) => [row.day, row.avg_stress]));
        const spo2ByDay = new Map(metricDayAggregates.map((row) => [row.day, row.avg_spo2]));
        const skinTempByDay = new Map(metricDayAggregates.map((row) => [row.day, row.avg_skin_temp]));

        const activities = recentActivities.map((activity, index): ActivitySummary => {
          const rows = activityHeartBuckets[index] ?? [];
          const durationMinutes = minutesBetween(activity.start, activity.end);
          return {
            id: activity.id,
            title: activity.activity,
            timeLabel: formatClock(activity.start),
            durationMinutes,
            strain: calculateStrainFromBucketRows(rows, maxHr, restingHr, durationMinutes),
            calories: estimateCaloriesFromBucketRows(rows, maxHr, restingHr, durationMinutes),
            isEstimated: true,
            strainLabel: 'Estimated strain',
            caloriesLabel: 'Estimated calories',
          };
        });

        const recovery = estimateRecoveryScoreFromSleeps(latestSleep, recentSleepCycles, latestStress);
        const snapshot = {
          stress: buildWellnessMetricSeries({
            title: 'Stress',
            unit: '',
            accent: 'alert',
            detail: 'Lower recent variability points to calmer load.',
            endDate: latestHeartDate,
            range,
            latest: metricSummary?.latest_stress ?? null,
            average: metricSummary?.avg_stress ?? null,
            count: metricSummary?.stress_count ?? 0,
            recentValues: recentStressValues,
            valuesByDay: stressByDay,
          }),
          spo2: buildWellnessMetricSeries({
            title: 'SpO2',
            unit: '%',
            accent: 'cyan',
            detail: 'Overnight oxygen stayed stable.',
            endDate: latestHeartDate,
            range,
            latest: metricSummary?.latest_spo2 ?? null,
            average: metricSummary?.avg_spo2 ?? null,
            count: metricSummary?.spo2_count ?? 0,
            recentValues: recentSpo2Values,
            valuesByDay: spo2ByDay,
          }),
          skinTemperature: buildWellnessMetricSeries({
            title: 'Skin Temperature',
            unit: '°C',
            accent: 'heart',
            detail: 'Night temperature stayed within baseline range.',
            digits: 1,
            endDate: latestHeartDate,
            range,
            latest: metricSummary?.latest_skin_temp ?? null,
            average: metricSummary?.avg_skin_temp ?? null,
            count: metricSummary?.skin_temp_count ?? 0,
            recentValues: recentSkinTempValues,
            valuesByDay: skinTempByDay,
          }),
          recoveryIndex: {
            title: 'Recovery Index',
            latest: recovery.score,
            average: trendValues(recoveryTrend).length === 0 ? null : mean(trendValues(recoveryTrend)),
            delta: trendValues(recoveryTrend).length < 2 ? null : trendValues(recoveryTrend).at(-1)! - trendValues(recoveryTrend).at(-2)!,
            unit: '',
            detail: recovery.score === null ? NO_SLEEP_REASON : 'Transparent readiness heuristic from sleep, HRV, resting HR, stress, and temperature.',
            accent: 'green',
            series: recoveryTrend,
            isEstimated: true,
            hasPartialData: recoveryTrend.length < 7,
            missingReason: recovery.score === null ? NO_SLEEP_REASON : null,
          },
          activities,
        } satisfies WellnessSnapshot;
        logMobilePerf('repository.getWellnessSnapshot.compute', computeStartedAt, {
          range,
          dayRows: metricDayAggregates.length,
          activities: snapshot.activities.length,
        });
        logMobilePerf('repository.getWellnessSnapshot', startedAt, {
          range,
          activities: snapshot.activities.length,
        });
        return snapshot;
      } catch (error) {
        logMobilePerfError('repository.getWellnessSnapshot', error, {
          range,
        });
        throw error;
      }
    });
  }
}
