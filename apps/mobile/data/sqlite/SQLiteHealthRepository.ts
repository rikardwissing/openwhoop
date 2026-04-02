import type { SQLiteDatabase } from 'expo-sqlite';

import type { HealthCacheScope, HealthRepository } from '@/data/HealthRepository';
import { DERIVED_DATA_SCHEMA_VERSION } from '@/db/schema';
import type {
  ActivitySummary,
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
import { dateKey, formatAxisTime, formatClock, formatClockMinutes, formatLongDate, formatShortDate, formatSqliteDateTime, hoursBetween, minutesBetween, parseSqliteDateTime } from '@/utils/dateTime';
import { describeRecovery, describeSleepScore, formatMetricNumber } from '@/utils/formatters';
import { sustainedPeakBpm } from '@/utils/heartRate';
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
const STRESS_WINDOW = 120;
const SPO2_WINDOW = 30;
const DEFAULT_TARGET_WAKE_MINUTES = 7 * 60 + 30;
const RECENT_WAKE_INFERENCE_DAYS = 7;
const DASHBOARD_HEART_BUCKET_MINUTES = 5;
const HEART_INTRADAY_BUCKET_MINUTES = 5;

const PPG_THRESHOLDS = {
  inactiveActive: 7629,
  activeSleep: 15258,
  sleepAwake: 22888,
};

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
  gravity: [number, number, number] | null;
  ppgGreen: number | null;
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
  score: number | null;
}

interface SleepCycleRecord {
  id: string;
  sleepId: string;
  start: Date;
  end: Date;
  minBpm: number;
  maxBpm: number;
  avgBpm: number;
  minHrv: number;
  maxHrv: number;
  avgHrv: number;
  score: number | null;
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

interface DeviceStateRow {
  id: string;
  name: string | null;
  last_seen_at: string | null;
  last_synced_at: string | null;
  firmware: string | null;
  battery_percent: number | null;
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
}

interface TimeRow {
  time: string;
}

interface NumberRow {
  bpm: number;
}

interface DailyMinimaRow {
  day: string;
  min_bpm: number;
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
    gravity: sensorData?.accel_gravity ?? null,
    ppgGreen: sensorData?.ppg_green ?? null,
  };
}

function toSleepCycleRecord(row: SleepCycleRow): SleepCycleRecord {
  return {
    id: row.id,
    sleepId: row.sleep_id,
    start: parseSqliteDateTime(row.start),
    end: parseSqliteDateTime(row.end),
    minBpm: row.min_bpm,
    maxBpm: row.max_bpm,
    avgBpm: row.avg_bpm,
    minHrv: row.min_hrv,
    maxHrv: row.max_hrv,
    avgHrv: row.avg_hrv,
    score: row.score,
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

function createTimeBuckets(points: HeartRateRecord[], bucketMinutes: number): TrendPoint[] {
  if (points.length === 0) {
    return [];
  }

  const bucketMs = bucketMinutes * 60000;
  const buckets = new Map<number, HeartRateRecord[]>();

  for (const point of points) {
    const bucketStart = Math.floor(point.date.getTime() / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart);

    if (bucket) {
      bucket.push(point);
      continue;
    }

    buckets.set(bucketStart, [point]);
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([bucketStart, bucket]) => ({
      label: formatAxisTime(new Date(bucketStart)),
      value: Math.round(mean(bucket.map((point) => point.bpm))),
    }));
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
  const stillFractions = deltas.map((_, index) => {
    const half = Math.floor(windowSize / 2);
    const start = Math.max(0, index - half);
    const end = Math.min(deltas.length, index + half + 1);
    const window = deltas.slice(start, end);
    const still = window.filter((value) => value < GRAVITY_STILL_THRESHOLD).length;
    return still / window.length;
  });

  const classified = stillFractions.map((fraction) => fraction >= GRAVITY_STILL_FRACTION);
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

function rowsInRange(rows: HeartRateRecord[], start: Date, end: Date): HeartRateRecord[] {
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

function buildSleepCycle(period: DetectedPeriod, rows: HeartRateRecord[]): SleepCycleRecord | null {
  const windowRows = rowsInRange(rows, period.start, period.end);
  if (windowRows.length === 0) {
    return null;
  }

  const rr = windowRows.flatMap((row) => row.rr);
  const hrvValues = calculateRollingHrv(rr);
  const bpmValues = windowRows.map((row) => row.bpm);
  const sleepId = dateKey(period.end);

  return {
    id: sleepId,
    sleepId,
    start: period.start,
    end: period.end,
    minBpm: Math.min(...bpmValues),
    maxBpm: Math.max(...bpmValues),
    avgBpm: Math.round(mean(bpmValues)),
    minHrv: hrvValues.length > 0 ? Math.min(...hrvValues) : 0,
    maxHrv: hrvValues.length > 0 ? Math.max(...hrvValues) : 0,
    avgHrv: hrvValues.length > 0 ? Math.round(mean(hrvValues)) : 0,
    score: null,
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
      scored.map((priorSleep) => minutesBetween(priorSleep.start, priorSleep.end)),
    );
    const effectiveSleepMinutes = minutesBetween(sleep.start, sleep.end) + Math.round(napCreditHours(recentNaps) * 60);
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
  const recentSleepDurations = sleeps.map((sleep) => minutesBetween(sleep.start, sleep.end));
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

function classifyPpgStage(ppgGreen: number): SleepStage {
  if (ppgGreen >= PPG_THRESHOLDS.sleepAwake) {
    return 'awake';
  }

  if (ppgGreen >= PPG_THRESHOLDS.activeSleep) {
    return 'light';
  }

  if (ppgGreen >= PPG_THRESHOLDS.inactiveActive) {
    return 'rem';
  }

  return 'deep';
}

function buildStageSegments(sleep: SleepCycleRecord, rows: HeartRateRecord[]): SleepStageRecord[] {
  const windowRows = rowsInRange(rows, sleep.start, sleep.end).filter((row) => row.ppgGreen !== null);
  if (windowRows.length === 0) {
    return [];
  }

  const segments: SleepStageRecord[] = [];
  let currentStage = classifyPpgStage(windowRows[0].ppgGreen ?? 0);
  let start = windowRows[0].date;
  let previous = windowRows[0].date;

  for (let index = 1; index < windowRows.length; index += 1) {
    const row = windowRows[index];
    const stage = classifyPpgStage(row.ppgGreen ?? 0);
    const gapMinutes = minutesBetween(previous, row.date);

    if (stage !== currentStage || gapMinutes > 5) {
      segments.push({
        sleepId: sleep.sleepId,
        start,
        end: previous,
        stage: currentStage,
        isEstimated: true,
      });
      currentStage = stage;
      start = row.date;
    }

    previous = row.date;
  }

  segments.push({
    sleepId: sleep.sleepId,
    start,
    end: previous,
    stage: currentStage,
    isEstimated: true,
  });

  return segments;
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

function sampleDurationMinutes(rows: HeartRateRecord[]): number {
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

function calculateStrain(rows: HeartRateRecord[], maxHr: number, restingHr: number): number | null {
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

function estimateCalories(rows: HeartRateRecord[], maxHr: number, restingHr: number): number | null {
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

function calculateStressScore(window: HeartRateRecord[]): number | null {
  if (window.length < STRESS_WINDOW) {
    return null;
  }

  const realRr = window.flatMap((row) => row.rr);
  const rr = (realRr.length >= STRESS_WINDOW ? realRr : window.map((row) => Math.round((60 / row.bpm) * 1000)))
    .filter((value) => value > 0);

  if (rr.length < STRESS_WINDOW) {
    return null;
  }

  const min = Math.min(...rr);
  const max = Math.max(...rr);
  const bins = new Map<number, number>();

  for (const value of rr) {
    const bin = Math.floor(value / 50);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }

  const [modeBin, modeFreq] = [...bins.entries()].sort((left, right) => right[1] - left[1])[0] ?? [0, 0];
  const mode = modeBin * 50 + 25;
  const variabilityRange = (max - min) / 1000;
  if (variabilityRange < 0.0001) {
    return 10;
  }

  const aMode = modeFreq / rr.length * 100;
  return Math.min(10, Math.round((aMode / (2 * variabilityRange * mode / 1000)) * 100) / 100);
}

function calculateSpo2Score(window: HeartRateRecord[]): number | null {
  if (window.length < SPO2_WINDOW) {
    return null;
  }

  const valid = window
    .map((row) => ({
      red: row.sensorData?.spo2_red ?? 0,
      ir: row.sensorData?.spo2_ir ?? 0,
    }))
    .filter((row) => row.red > 0 && row.ir > 0);

  if (valid.length < SPO2_WINDOW) {
    return null;
  }

  const meanRed = mean(valid.map((row) => row.red));
  const meanIr = mean(valid.map((row) => row.ir));
  if (meanRed < 1 || meanIr < 1) {
    return null;
  }

  const acRed = Math.sqrt(mean(valid.map((row) => (row.red - meanRed) ** 2)));
  const acIr = Math.sqrt(mean(valid.map((row) => (row.ir - meanIr) ** 2)));
  if (acRed < 0.001 || acIr < 0.001) {
    return null;
  }

  const ratio = (acRed / meanRed) / (acIr / meanIr);
  return clamp(110 - 25 * ratio, 70, 100);
}

function calculateSkinTempValue(row: HeartRateRecord): number | null {
  const raw = row.sensorData?.skin_temp_raw ?? 0;
  if (raw < 100) {
    return null;
  }

  return raw * 0.04;
}

function personalizeRestingHr(sleeps: SleepCycleRecord[], dailyMinima: number[]): number {
  const lastFourteen = sleeps.slice(-14).map((sleep) => sleep.minBpm);
  const sleepMedian = median(lastFourteen);
  if (sleepMedian !== null) {
    return Math.round(sleepMedian);
  }

  const latestSleep = sleeps.at(-1);
  if (latestSleep) {
    return latestSleep.minBpm;
  }

  const dailyMedian = median(dailyMinima);
  return dailyMedian === null ? 50 : Math.round(dailyMedian);
}

function personalizeMaxHr(bpms: number[], restingHr: number): number {
  const observed = (sustainedPeakBpm(bpms) ?? 175) + 5;
  return clamp(Math.max(observed, restingHr + 100), 180, 205);
}

function groupByDay<T extends { date: Date }>(rows: T[]): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = dateKey(row.date);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
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
  const rhrBaseline = median(priorSleeps.map((sleep) => sleep.minBpm));
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
    rhrComponent: relativeDelta(latestSleep?.minBpm ?? null, rhrBaseline),
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
    .map((row) => row.skinTemp)
    .filter((value): value is number => value !== null);

  return values.length === 0 ? null : mean(values);
}

function latestValue(values: number[]): number | null {
  return values.length === 0 ? null : values.at(-1) ?? null;
}

function buildDailyTrend(range: HistoryRange, rows: HeartRateRecord[], accessor: (rows: HeartRateRecord[]) => number | null): TrendPoint[] {
  return groupByDay(rows)
    .slice(-rangeDays(range))
    .map(([day, items]) => ({
      label: formatShortDate(parseSqliteDateTime(`${day} 00:00:00`)),
      value: accessor(items) ?? 0,
    }));
}

function aggregateSleepStages(records: SleepStageRecord[]): SleepStageSegment[] {
  return records.map((record) => ({
    stage: record.stage,
    minutes: Math.max(1, minutesBetween(record.start, record.end)),
  }));
}

function axisLabelForMidpoint(start: Date, end: Date): string {
  return formatAxisTime(new Date((start.getTime() + end.getTime()) / 2));
}

async function loadPreparedData(db: SQLiteDatabase): Promise<PreparedDataBundle> {
  const [heartRows, sleepRows, activityRows, stageRows, deviceRows] = await Promise.all([
    db.getAllAsync<HeartRateQueryRow>('SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data FROM heart_rate ORDER BY time ASC'),
    db.getAllAsync<SleepCycleRow>('SELECT id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, score FROM sleep_cycles ORDER BY start ASC'),
    db.getAllAsync<ActivityRow>('SELECT id, period_id, start, end, activity FROM activities ORDER BY start ASC'),
    db.getAllAsync<SleepStageRow>('SELECT id, sleep_id, start, end, stage, is_estimated FROM sleep_stage_segments ORDER BY start ASC'),
    db.getAllAsync<DeviceStateRow>('SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, body_status, sync_error FROM device_state ORDER BY last_synced_at DESC LIMIT 1'),
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

async function querySleepCycles(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<SleepCycleRow>(sql, ...args)).map(toSleepCycleRecord);
}

async function queryActivities(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<ActivityRow>(sql, ...args)).map(toActivityRecord);
}

async function querySleepStages(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<SleepStageRow>(sql, ...args)).map(toSleepStageRecord);
}

export async function shouldRefreshDerivedData(db: SQLiteDatabase): Promise<boolean> {
  const counts = await db.getFirstAsync<{
    heart_count: number;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM heart_rate) AS heart_count
  `);

  if (!counts || counts.heart_count === 0) {
    return false;
  }

  const state = await db.getFirstAsync<DerivedDataStateRow>(
    'SELECT derived_schema_version, source_heart_count, refreshed_at FROM derived_data_state WHERE id = 1 LIMIT 1',
  );

  if (!state) {
    return true;
  }

  return (
    state.derived_schema_version !== DERIVED_DATA_SCHEMA_VERSION ||
    state.source_heart_count !== counts.heart_count
  );
}

export async function refreshDerivedData(db: SQLiteDatabase) {
  const heartRows = (await db.getAllAsync<HeartRateQueryRow>('SELECT id, bpm, time, rr_intervals, stress, spo2, skin_temp, sensor_data FROM heart_rate ORDER BY time ASC')).map(toHeartRateRecord);

  const stressByTime = new Map<string, number | null>();
  const spo2ByTime = new Map<string, number | null>();
  const tempByTime = new Map<string, number | null>();

  for (let index = 0; index < heartRows.length; index += 1) {
    const stressWindow = heartRows.slice(Math.max(0, index - STRESS_WINDOW + 1), index + 1);
    stressByTime.set(heartRows[index].time, calculateStressScore(stressWindow));

    const spo2Window = heartRows.slice(Math.max(0, index - SPO2_WINDOW + 1), index + 1);
    spo2ByTime.set(heartRows[index].time, calculateSpo2Score(spo2Window));

    tempByTime.set(heartRows[index].time, calculateSkinTempValue(heartRows[index]));
  }

  const periods = detectFromGravity(heartRows);
  const sleepCandidates = mergeNearbySleepPeriods(periods.filter((period) => period.activity === 'sleep' && period.durationMinutes >= MIN_SLEEP_DURATION_MINUTES));
  const activeCandidates = periods.filter((period) => period.activity === 'active');
  const { sleeps: primarySleepPeriods, naps: napPeriods } = selectSleepAndNapPeriods(sleepCandidates);
  const sleepCycles = scoreSleepCycles(
    primarySleepPeriods
      .map((period) => buildSleepCycle(period, heartRows))
      .filter((period): period is SleepCycleRecord => period !== null),
    buildNapActivities(napPeriods),
  );
  const activities = [...buildNapActivities(napPeriods), ...buildActivityRecords(activeCandidates, sleepCycles)];
  const stages = sleepCycles.flatMap((sleep) => buildStageSegments(sleep, heartRows));

  await db.withExclusiveTransactionAsync(async (tx) => {
    for (const row of heartRows) {
      await tx.runAsync(
        'UPDATE heart_rate SET stress = ?, spo2 = ?, skin_temp = ? WHERE time = ?',
        stressByTime.get(row.time) ?? null,
        spo2ByTime.get(row.time) ?? null,
        tempByTime.get(row.time) ?? null,
        row.time,
      );
    }

    await tx.execAsync(`
      DELETE FROM sleep_cycles;
      DELETE FROM activities;
      DELETE FROM sleep_stage_segments;
    `);

    for (const sleep of sleepCycles) {
      await tx.runAsync(
        `
          INSERT INTO sleep_cycles (id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, score, synced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
        sleep.score,
      );
    }

    for (const activity of activities) {
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

    for (const stage of stages) {
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

    await tx.runAsync(
      `
        INSERT INTO derived_data_state (id, derived_schema_version, source_heart_count, refreshed_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          derived_schema_version = excluded.derived_schema_version,
          source_heart_count = excluded.source_heart_count,
          refreshed_at = excluded.refreshed_at
      `,
      DERIVED_DATA_SCHEMA_VERSION,
      heartRows.length,
      formatSqliteDateTime(new Date()),
    );
  });
}

export class SQLiteHealthRepository implements HealthRepository {
  private preparePromise: Promise<void> | null = null;
  private readonly snapshotCache = new Map<string, Promise<unknown>>();
  private readonly queryCache = new Map<string, Promise<unknown>>();

  constructor(private readonly db: SQLiteDatabase) {}

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

  invalidateCaches(scope: HealthCacheScope = 'all') {
    if (scope === 'all') {
      this.snapshotCache.clear();
      this.queryCache.clear();
      return;
    }

    for (const key of this.snapshotCache.keys()) {
      if (key === scope || key.startsWith(`${scope}:`)) {
        this.snapshotCache.delete(key);
      }
    }
  }

  async warmCaches(): Promise<void> {
    await Promise.all([
      this.getDashboardSnapshot(),
      this.getSleepHistory('14d'),
      this.getHeartHistory('14d'),
      this.getWellnessSnapshot('14d'),
    ]);
  }

  private async ensurePrepared() {
    if (this.preparePromise) {
      await this.preparePromise;
      return;
    }

    this.preparePromise = (async () => {
      try {
        if (await shouldRefreshDerivedData(this.db)) {
          this.invalidateCaches('all');
          await refreshDerivedData(this.db);
        }
      } finally {
        this.preparePromise = null;
      }
    })();

    await this.preparePromise;
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

  private async loadAllHeartBpms() {
    return this.readQuery('heart:all-bpms', async () => {
      const rows = await this.db.getAllAsync<NumberRow>('SELECT bpm FROM heart_rate ORDER BY time ASC');
      return rows.map((row) => row.bpm);
    });
  }

  private async loadDailyHeartMinima() {
    return this.readQuery('heart:daily-minima', async () => {
      const rows = await this.db.getAllAsync<DailyMinimaRow>(
        `
          SELECT day, min_bpm
          FROM (
            SELECT substr(time, 1, 10) AS day, MIN(bpm) AS min_bpm
            FROM heart_rate
            GROUP BY day
            ORDER BY day DESC
          )
          ORDER BY day ASC
        `,
      );
      return rows;
    });
  }

  private async loadRecentSleepCycles(limit: number) {
    return this.readQuery(`sleep-cycles:recent:${limit}`, async () => {
      const rows = await querySleepCycles(
        this.db,
        `
          SELECT id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, score
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
          SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, body_status, sync_error
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
      await this.ensurePrepared();

      const now = new Date();
      const [latestHeartDate, sleepCycles, dailyMinimaRows, allBpms, deviceState] = await Promise.all([
        this.loadLatestHeartDate(),
        this.loadRecentSleepCycles(15),
        this.loadDailyHeartMinima(),
        this.loadAllHeartBpms(),
        this.loadDeviceStateRow(),
      ]);

      const latestSleep = sleepCycles.at(-1) ?? null;
      const stageRecords = latestSleep ? await this.loadSleepStagesForIds([latestSleep.sleepId]) : [];
      const sleepCard: SleepCardSnapshot = latestSleep
        ? {
            score: latestSleep.score,
            durationMinutes: minutesBetween(latestSleep.start, latestSleep.end),
            stages: aggregateSleepStages(stageRecords),
            startLabel: formatClock(latestSleep.start),
            middleLabel: axisLabelForMidpoint(latestSleep.start, latestSleep.end),
            endLabel: formatClock(latestSleep.end),
            isEstimated: stageRecords.some((stage) => stage.isEstimated),
            missingReason: stageRecords.length === 0 ? LIMITED_SENSOR_REASON : null,
          }
        : {
            score: null,
            durationMinutes: null,
            stages: [],
            startLabel: '--',
            middleLabel: '--',
            endLabel: '--',
            isEstimated: true,
            missingReason: NO_SLEEP_REASON,
          };

      if (allBpms.length === 0) {
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
          sleepCard,
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

      const dailyMinima = dailyMinimaRows.map((row) => row.min_bpm);
      const restingHr = personalizeRestingHr(sleepCycles, dailyMinima);
      const maxHr = personalizeMaxHr(allBpms, restingHr);
      const earliestContext = new Date(
        Math.min(
          now.getTime() - 24 * 3600000,
          sleepCycles[0]?.start.getTime() ?? now.getTime(),
        ),
      );
      let heartRows = await this.loadHeartRowsSince(
        earliestContext,
        `dashboard:heart-context:${formatSqliteDateTime(earliestContext)}`,
      );
      if (heartRows.length === 0) {
        heartRows = await this.loadAllHeartRows();
      }

      const recovery = estimateRecoveryScore(latestSleep, sleepCycles, heartRows);
      const last24Hours = heartRows.filter((row) => now.getTime() - row.date.getTime() <= 24 * 3600000);
      const intradayRows = last24Hours.length > 0 ? last24Hours : heartRows;
      const heartCardSeries = createTimeBuckets(intradayRows, DASHBOARD_HEART_BUCKET_MINUTES);
      const latestDayKey = dateKey(heartRows.at(-1)?.date ?? now);
      const latestDayRows = heartRows.filter((row) => dateKey(row.date) === latestDayKey);
      const todayStrain = calculateStrain(latestDayRows, maxHr, restingHr);
      const strainSeries = buildDailyTrend('14d', heartRows, (rows) => calculateStrain(rows, maxHr, restingHr));

      return {
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
            value: latestSleep ? formatMetricNumber(minutesBetween(latestSleep.start, latestSleep.end), '').replace(' ', '') : '--',
            accent: 'violet',
            missingReason: latestSleep ? null : NO_SLEEP_REASON,
          },
        ],
        heartCard: {
          restingHr,
          averageHr: Math.round(mean(intradayRows.map((row) => row.bpm))),
          maxHr: sustainedPeakBpm(intradayRows.map((row) => row.bpm)),
          series: heartCardSeries,
        },
        sleepCard,
        strainCard: {
          score: todayStrain,
          label: todayStrain === null ? 'Waiting for effort' : todayStrain >= 14 ? 'Loaded' : todayStrain >= 8 ? 'Building' : 'Light',
          series: strainSeries,
          isEstimated: true,
          missingReason: strainSeries.length === 0 ? NO_HISTORY_REASON : null,
        },
        lastSyncLabel: deviceState?.last_synced_at ? `Last sync ${formatClock(parseSqliteDateTime(deviceState.last_synced_at))}` : 'Local seed loaded',
      };
    });
  }

  async setTargetWakeMinutes(minutes: number): Promise<void> {
    const nextTargetWakeMinutes = roundClockMinutes(
      normalizeClockMinutes(minutes),
      SLEEP_TARGET_STEP_MINUTES,
    );
    await persistSleepPreferences(this.db, {
      targetWakeMinutes: nextTargetWakeMinutes,
      alarmEnabled: false,
    });
    this.invalidateCaches('sleep');
  }

  async enableAlarm(targetWakeMinutes: number): Promise<void> {
    const nextTargetWakeMinutes = roundClockMinutes(
      normalizeClockMinutes(targetWakeMinutes),
      SLEEP_TARGET_STEP_MINUTES,
    );
    await persistSleepPreferences(this.db, {
      targetWakeMinutes: nextTargetWakeMinutes,
      alarmEnabled: true,
    });
    this.invalidateCaches('sleep');
  }

  async disableAlarm(targetWakeMinutes: number): Promise<void> {
    const nextTargetWakeMinutes = roundClockMinutes(
      normalizeClockMinutes(targetWakeMinutes),
      SLEEP_TARGET_STEP_MINUTES,
    );
    await persistSleepPreferences(this.db, {
      targetWakeMinutes: nextTargetWakeMinutes,
      alarmEnabled: false,
    });
    this.invalidateCaches('sleep');
  }

  async getSleepHistory(range: HistoryRange): Promise<SleepHistorySnapshot> {
    return this.readSnapshot(`sleep:${range}`, async () => {
      await this.ensurePrepared();

      const sleepCycles = await this.loadRecentSleepCycles(Math.max(rangeDays(range), 15));
      const preferences = await loadSleepPreferences(this.db, sleepCycles);
      const latestSleepForPlan = sleepCycles.at(-1) ?? null;
      const napActivities = latestSleepForPlan ? await this.loadNapActivitiesSince(latestSleepForPlan.end) : [];
      const sleepPlan = buildSleepPlanSnapshot(preferences, sleepCycles, napActivities);
      const sessions = sleepCycles.slice(-rangeDays(range)).reverse();
      const latestSleep = sessions[0] ?? null;

      if (!latestSleep) {
        return {
          headlineScore: null,
          headlineLabel: 'Waiting for sleep',
          bedtime: '--',
          wakeTime: '--',
          durationMinutes: null,
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
        const stages = aggregateSleepStages(stageRecords.filter((stage) => stage.sleepId === session.sleepId));
        return {
          id: session.id,
          dateLabel: formatShortDate(session.end),
          score: session.score,
          bedtime: formatClock(session.start),
          wakeTime: formatClock(session.end),
          durationMinutes: minutesBetween(session.start, session.end),
          efficiency: session.score,
          remMinutes: stages.filter((stage) => stage.stage === 'rem').reduce((sum, stage) => sum + stage.minutes, 0),
          deepMinutes: stages.filter((stage) => stage.stage === 'deep').reduce((sum, stage) => sum + stage.minutes, 0),
          consistency: Math.round((bedtimeConsistency + wakeConsistency) / 2),
          stages,
          isEstimated: true,
          missingReason: stages.length === 0 ? LIMITED_SENSOR_REASON : null,
          minBpm: session.minBpm,
          maxBpm: session.maxBpm,
          avgHrv: session.avgHrv,
        };
      });

      return {
        headlineScore: latestSleep.score,
        headlineLabel: describeSleepScore(latestSleep.score),
        bedtime: formatClock(latestSleep.start),
        wakeTime: formatClock(latestSleep.end),
        durationMinutes: minutesBetween(latestSleep.start, latestSleep.end),
        bedtimeConsistency: Math.round(bedtimeConsistency),
        wakeConsistency: Math.round(wakeConsistency),
        scoreTrend: sessions.map((session) => ({
          label: formatShortDate(session.end),
          value: session.score ?? 0,
        })),
        durationTrend: sessions.map((session) => ({
          label: formatShortDate(session.end),
          value: minutesBetween(session.start, session.end),
        })),
        sessions: mappedSessions,
        sleepPlan,
        isEstimated: true,
      };
    });
  }

  async getHeartHistory(range: HistoryRange): Promise<HeartHistorySnapshot> {
    return this.readSnapshot(`heart:${range}`, async () => {
      await this.ensurePrepared();

      const [latestHeartDate, dailyMinimaRows, sleepCycles] = await Promise.all([
        this.loadLatestHeartDate(),
        this.loadDailyHeartMinima(),
        this.loadRecentSleepCycles(14),
      ]);

      if (!latestHeartDate || dailyMinimaRows.length === 0) {
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
      const intradaySource = await this.loadHeartRowsSince(
        intradayStart,
        `heart:intraday:${formatSqliteDateTime(intradayStart)}`,
      );
      const dailyMinima = dailyMinimaRows.map((row) => row.min_bpm);
      const restingHr = personalizeRestingHr(sleepCycles, dailyMinima);
      const weeklyResting = dailyMinimaRows.slice(-rangeDays(range)).map((row) => ({
        label: formatShortDate(parseSqliteDateTime(`${row.day} 00:00:00`)),
        value: row.min_bpm,
      }));
      const previousMedian = median(weeklyResting.slice(0, -1).map((item) => item.value));

      return {
        restingHr,
        averageHr: Math.round(mean(intradaySource.map((row) => row.bpm))),
        maxHr: sustainedPeakBpm(intradaySource.map((row) => row.bpm)),
        intraday: createTimeBuckets(intradaySource, HEART_INTRADAY_BUCKET_MINUTES),
        weeklyResting,
        recoveryShift: previousMedian === null ? null : restingHr - previousMedian,
      };
    });
  }

  async getWellnessSnapshot(range: HistoryRange): Promise<WellnessSnapshot> {
    return this.readSnapshot(`wellness:${range}`, async () => {
      await this.ensurePrepared();

      const [latestHeartDate, recentSleepCycles, recentActivities, dailyMinimaRows, allBpms] = await Promise.all([
        this.loadLatestHeartDate(),
        this.loadRecentSleepCycles(rangeDays(range)),
        this.loadRecentActivities(5),
        this.loadDailyHeartMinima(),
        this.loadAllHeartBpms(),
      ]);

      if (!latestHeartDate || allBpms.length === 0) {
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
      const heartRows = await this.loadHeartRowsSince(
        new Date(earliestRelevantTimestamp),
        `wellness:heart-context:${range}:${formatSqliteDateTime(new Date(earliestRelevantTimestamp))}`,
      );
      const latestSleep = recentSleepCycles.at(-1) ?? null;
      const restingHr = personalizeRestingHr(recentSleepCycles, dailyMinimaRows.map((row) => row.min_bpm));
      const maxHr = personalizeMaxHr(allBpms, restingHr);
      const recoveryTrend = recentSleepCycles.map((sleep, index, sleeps) => {
        const score = estimateRecoveryScore(sleep, sleeps.slice(0, index + 1), heartRows).score;
        return {
          label: formatShortDate(sleep.end),
          value: score ?? 0,
        };
      });

      const stressRows = heartRows.filter((row) => row.stress !== null);
      const spo2Rows = heartRows.filter((row) => row.spo2 !== null);
      const tempRows = heartRows.filter((row) => row.skinTemp !== null);

      const buildMetric = (
        title: string,
        unit: string,
        accent: MetricSeries['accent'],
        rows: HeartRateRecord[],
        accessor: (row: HeartRateRecord) => number | null,
        detail: string,
        digits = 0,
      ): MetricSeries => {
        const values = rows.map(accessor).filter((value): value is number => value !== null);
        const latest = values.at(-1) ?? null;
        const average = values.length === 0 ? null : mean(values);
        const baseline = values.length < 2 ? null : values[Math.max(0, values.length - 8)];
        const delta = latest === null || baseline === null ? null : latest - baseline;
        return {
          title,
          latest: latest === null ? null : Number(latest.toFixed(digits)),
          average: average === null ? null : Number(average.toFixed(digits)),
          delta: delta === null ? null : Number(delta.toFixed(digits)),
          unit,
          detail: latest === null ? LIMITED_SENSOR_REASON : detail,
          accent,
          hasPartialData: values.length < 14,
          series: buildDailyTrend(range, rows, (items) => {
            const itemValues = items.map(accessor).filter((value): value is number => value !== null);
            return itemValues.length === 0 ? null : mean(itemValues);
          }),
          isEstimated: false,
          missingReason: latest === null ? LIMITED_SENSOR_REASON : null,
        };
      };

      const activities = recentActivities.map((activity): ActivitySummary => {
        const rows = rowsInRange(heartRows, activity.start, activity.end);
        return {
          id: activity.id,
          title: activity.activity,
          timeLabel: formatClock(activity.start),
          durationMinutes: minutesBetween(activity.start, activity.end),
          strain: calculateStrain(rows, maxHr, restingHr),
          calories: estimateCalories(rows, maxHr, restingHr),
          isEstimated: true,
          strainLabel: 'Estimated strain',
          caloriesLabel: 'Estimated calories',
        };
      });

      const recovery = estimateRecoveryScore(latestSleep, recentSleepCycles, heartRows);

      return {
        stress: buildMetric('Stress', '', 'alert', stressRows, (row) => row.stress, 'Lower recent variability points to calmer load.'),
        spo2: buildMetric('SpO2', '%', 'cyan', spo2Rows, (row) => row.spo2, 'Overnight oxygen stayed stable.', 0),
        skinTemperature: buildMetric('Skin Temperature', '°C', 'heart', tempRows, (row) => row.skinTemp, 'Night temperature stayed within baseline range.', 1),
        recoveryIndex: {
          title: 'Recovery Index',
          latest: recovery.score,
          average: recoveryTrend.length === 0 ? null : mean(recoveryTrend.map((point) => point.value)),
          delta: recoveryTrend.length < 2 ? null : recoveryTrend.at(-1)!.value - recoveryTrend[Math.max(0, recoveryTrend.length - 2)].value,
          unit: '',
          detail: recovery.score === null ? NO_SLEEP_REASON : 'Transparent readiness heuristic from sleep, HRV, resting HR, stress, and temperature.',
          accent: 'green',
          series: recoveryTrend,
          isEstimated: true,
          hasPartialData: recoveryTrend.length < 7,
          missingReason: recovery.score === null ? NO_SLEEP_REASON : null,
        },
        activities,
      };
    });
  }
}
