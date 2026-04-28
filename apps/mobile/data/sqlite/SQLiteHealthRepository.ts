import type { SQLiteDatabase } from 'expo-sqlite';

import type {
  ActivityRescanResult,
  HealthRepository,
  ManualActivityKind,
} from '@/data/HealthRepository';
import {
  ACTIVITY_DETECTOR_DAYPARTS,
  DEFAULT_ACTIVITY_DETECTOR_THRESHOLDS,
  detectActivityArtifacts,
  activityDetectorDaypartForDate,
} from '@/data/sqlite/activityDetector';
import type {
  ActivityDetectorDaypart,
  ActivityDetectorPeriod,
  ActivityDetectorPersonalization,
} from '@/data/sqlite/activityDetector';
import { generateSleepStageRecords, isAwakePpgValue } from '@/data/sqlite/sleepStages';
import type { SleepStageInputRow } from '@/data/sqlite/sleepStages';
import { DERIVED_DATA_SCHEMA_VERSION } from '@/db/schema';
import type {
  ActivityReviewState,
  ActivitySource,
  ActivitySummary,
  DashboardDayOption,
  DashboardDayState,
  DashboardInsight,
  DerivedRefreshState,
  FocusedHeartDetail,
  HeartCardData,
  HeartIntradayMarkerDetails,
  HeartIntradayMarker,
  HeartHistoryData,
  HistoryOverview,
  HistoryRange,
  MetricSeries,
  HeartTimelineSample,
  HeartTimelineWindow,
  RecoveryBreakdown,
  SleepCardData,
  SleepCompletionStatus,
  SleepHistoryData,
  SleepPlan,
  SleepSession,
  SleepStage,
  SleepStageSegment,
  TodayOverview,
  TrendMetric,
  TrendPoint,
  TrendData,
  WellnessData,
} from '@/types/health';
import { addMinutes, dateKey, formatAxisTime, formatClock, formatClockMinutes, formatLongDate, formatShortDate, formatSqliteDateTime, hoursBetween, minutesBetween, parseSqliteDateTime } from '@/utils/dateTime';
import { describeRecovery, describeSleepScore, formatMetricNumber } from '@/utils/formatters';
import { buildHeartCardDataFromWindow } from '@/utils/heartTimeline';
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
const LIMITED_LOAD_REASON = 'More heart data is needed before daily load can be estimated.';
const BUILDING_SLEEP_CONSISTENCY_REASON = 'More nights are needed before sleep consistency can be scored.';
const BUILDING_TEMPERATURE_BASELINE_REASON = 'A few nights of temperature data are needed before baseline shifts can be tracked.';
const MANUAL_SLEEP_HEART_DATA_ERROR = 'Sleep needs overlapping heart data in the selected window.';
const MANUAL_SLEEP_CONFLICT_ERROR = 'A sleep already exists for this day. Focus it and edit instead.';

const dashboardAggregateEnsurePromises = new WeakMap<SQLiteDatabase, Promise<void>>();
const heartIntradayEnsurePromises = new WeakMap<SQLiteDatabase, Promise<void>>();
const sleepFeatureEnsurePromises = new WeakMap<SQLiteDatabase, Promise<void>>();
const wellnessDayEnsurePromises = new WeakMap<SQLiteDatabase, Promise<void>>();

const DASHBOARD_LAYOUT_VERSION = 5;
const MIN_SLEEP_DURATION_MINUTES = 60;
const IN_PROGRESS_SLEEP_RECENCY_MINUTES = 90;
const MAX_SLEEP_PAUSE_MINUTES = 60;
const ACTIVITY_CHANGE_THRESHOLD_MINUTES = 15;
const MAX_TRANSIENT_AWAKE_STAGE_MINUTES = 1;
const MAX_FRAGMENTED_SUMMARY_STAGE_MINUTES = 2;
const STRESS_WINDOW = 120;
const SPO2_WINDOW = 30;
const DEFAULT_TARGET_WAKE_MINUTES = 7 * 60 + 30;
const RECENT_WAKE_INFERENCE_DAYS = 7;
const DASHBOARD_HEART_BUCKET_MINUTES = 5;
const DASHBOARD_DAY_METRIC_BUCKET_MINUTES = 60;
const DASHBOARD_SLEEP_METRIC_BUCKET_MINUTES = 30;
const HEART_INTRADAY_BUCKET_MINUTES = 5;
const HEART_INTRADAY_BUCKET_SECONDS = HEART_INTRADAY_BUCKET_MINUTES * 60;
const HEART_INTRADAY_METRIC_KEY = 'heart_bpm';
const HEART_ROW_QUERY_CHUNK_HOURS = 1;
const HEART_ROW_QUERY_CHUNK_MS = HEART_ROW_QUERY_CHUNK_HOURS * 3600000;
const DERIVED_REFRESH_CHUNK_HOURS = 12;
const DERIVED_REFRESH_CHUNK_MS = DERIVED_REFRESH_CHUNK_HOURS * 3600000;
const HEART_DETAIL_FINE_BUCKET_SECONDS = 15;
const HEART_GRAPH_FINE_BUCKET_SECONDS = 30;
const HEART_GRAPH_BUCKET_RESOLUTIONS_SECONDS = [
  HEART_DETAIL_FINE_BUCKET_SECONDS,
  HEART_GRAPH_FINE_BUCKET_SECONDS,
  HEART_INTRADAY_BUCKET_SECONDS,
] as const;
const SLEEP_FEATURE_BUCKET_SECONDS = 60;
const SLEEP_FEATURE_REFRESH_CHUNK_HOURS = 1;
const SLEEP_FEATURE_REFRESH_CHUNK_MS = SLEEP_FEATURE_REFRESH_CHUNK_HOURS * 3600000;
const SLEEP_FEATURE_PPG_SATURATION_THRESHOLD = 40000;
const TODAY_HEART_WINDOW_HOURS = 12;
const MAX_MANUAL_SLEEP_WINDOW_HOURS = 18;
const SLEEP_CONSISTENCY_WINDOW_NIGHTS = 7;
const MIN_SLEEP_CONSISTENCY_NIGHTS = 3;
const TEMPERATURE_BASELINE_WINDOW_NIGHTS = 14;
const MIN_TEMPERATURE_BASELINE_NIGHTS = 3;
const TEMPERATURE_BASELINE_NEUTRAL_DELTA = 0.15;

const SHOULD_LOG_MOBILE_PERF =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  (typeof process === 'undefined' || process.env.NODE_ENV !== 'test');

const HEART_RATE_FULL_SELECT_COLUMNS = `
  id,
  bpm,
  time,
  rr_intervals,
  stress,
  spo2,
  skin_temp,
  ppg_green,
  ppg_red_ir,
  spo2_red,
  spo2_ir,
  skin_temp_raw,
  ambient_light,
  led_drive_1,
  led_drive_2,
  resp_rate_raw,
  signal_quality,
  skin_contact,
  accel_gravity_x,
  accel_gravity_y,
  accel_gravity_z
`;

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
  ppg_green: number | null;
  ppg_red_ir: number | null;
  spo2_red: number | null;
  spo2_ir: number | null;
  skin_temp_raw: number | null;
  ambient_light: number | null;
  led_drive_1: number | null;
  led_drive_2: number | null;
  resp_rate_raw: number | null;
  signal_quality: number | null;
  skin_contact: number | null;
  accel_gravity_x: number | null;
  accel_gravity_y: number | null;
  accel_gravity_z: number | null;
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
  signalQuality: number | null;
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

interface HeartMetricSampleRow {
  bpm: number;
  time: string;
  stress: number | null;
  spo2: number | null;
  skin_temp: number | null;
}

interface HeartMetricSample {
  bpm: number;
  time: string;
  date: Date;
  stress: number | null;
  spo2: number | null;
  skinTemp: number | null;
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

interface HeartIntradayBucketSummaryRow extends HeartIntradayBucketRow {
  min_bpm: number;
  max_bpm: number;
}

interface IntradayMetricBucketRow {
  metric_key: string;
  bucket_seconds: number;
  bucket_start: string;
  sample_count: number;
  min_value: number | null;
  avg_value: number | null;
  max_value: number | null;
  first_value: number | null;
  last_value: number | null;
}

interface HeartIntradayBucketDetailRow {
  bucket_seconds: number;
  bucket_start: string;
  second_bpm: number | null;
  penultimate_bpm: number | null;
  max_triplet_avg: number | null;
}

interface IntradayMetricBucketStateRow {
  metric_key: string;
  bucket_seconds: number;
  source_row_count: number;
  source_last_sample_time: string | null;
  refreshed_at: string;
}

interface SleepFeatureBucketRow {
  bucket_seconds: number;
  bucket_start: string;
  sample_count: number;
  min_bpm: number | null;
  avg_bpm: number | null;
  max_bpm: number | null;
  rr_intervals: string;
  ppg_green_median: number | null;
  ppg_green_max: number | null;
  awake_ppg_count: number;
  saturated_ppg_count: number;
  motion_score: number | null;
  gravity_x: number | null;
  gravity_y: number | null;
  gravity_z: number | null;
  skin_contact_count: number;
  skin_contact_present_count: number;
  signal_quality_count: number;
  signal_quality_present_count: number;
  avg_skin_temp: number | null;
  avg_spo2: number | null;
}

interface SleepFeatureBucketStateRow {
  bucket_seconds: number;
  source_row_count: number;
  source_last_sample_time: string | null;
  refreshed_at: string;
}

interface SleepFeatureMetricSample {
  bpm: number;
  date: Date;
  rr: number[];
  spo2: number | null;
  skinTemp: number | null;
}

interface BucketedHeartWindow {
  latestHeartDate: Date | null;
  intradayStart: Date | null;
  rawRowCount: number;
  bucketSamples: HeartRateSample[];
  averageBpm: number | null;
  sustainedPeakBpm: number | null;
}

interface RawHeartWindow {
  latestHeartDate: Date | null;
  intradayStart: Date | null;
  rawRowCount: number;
  samples: HeartTimelineSample[];
  averageHr: number | null;
  maxHr: number | null;
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
  completion_status: string | null;
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
  completionStatus: SleepCompletionStatus;
  isInProgress: boolean;
}

interface ActivityRow {
  id: number;
  period_id: string;
  start: string;
  end: string;
  activity: string;
  confidence: number | null;
  source: string | null;
  review_state: string | null;
}

interface ActivityRecord {
  id: string;
  periodId: string;
  start: Date;
  end: Date;
  activity: 'Activity' | 'Walk' | 'Workout' | 'Nap';
  confidence: number | null;
  source: ActivitySource;
  reviewState: ActivityReviewState;
}

interface ActivityPersonalizationRow {
  activity_kind: string;
  daypart: string;
  positive_count: number;
  negative_count: number;
  min_duration_minutes: number;
  min_confidence: number;
  updated_at: string;
}

interface ActivityPersonalizationSourceRow {
  activity: string;
  review_state: string | null;
  start: string;
  end: string;
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
const SLEEP_CYCLE_SELECT_COLUMNS = 'id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, avg_skin_temp, score, completion_status';
const ACTIVITY_SELECT_COLUMNS = 'id, period_id, start, end, activity, confidence, source, review_state';
const MANUAL_ACTIVITY_KINDS = new Set<ManualActivityKind>(['Activity', 'Walk', 'Workout', 'Nap']);
const PERSONALIZABLE_ACTIVITY_NAMES = ['Activity', 'Walk', 'Workout'] as const;
const ACTIVITY_PERSONALIZATION_MIN_REVIEWED_SAMPLES = 2;
const ACTIVITY_PERSONALIZATION_MAX_DURATION_REDUCTION_MINUTES = 4;
const ACTIVITY_PERSONALIZATION_MAX_CONFIDENCE_DELTA = 0.05;
const ACTIVITY_PERSONALIZATION_CONFIDENCE_STEP = 0.01;
const ACTIVITY_PERSONALIZATION_DAYPART_MIN_REVIEWED_SAMPLES = 2;
const ACTIVITY_PERSONALIZATION_MIN_DURATION_BY_KIND = {
  activity: 12,
  walk: 12,
  workout: 10,
} as const;
const DETECTOR_KIND_BY_ACTIVITY = {
  Activity: 'activity',
  Walk: 'walk',
  Workout: 'workout',
} as const;

type PersonalizableActivityName = typeof PERSONALIZABLE_ACTIVITY_NAMES[number];
type DetectorPersonalizationKind = keyof typeof DEFAULT_ACTIVITY_DETECTOR_THRESHOLDS;
type PersistedActivityPersonalizationDaypart = 'all' | ActivityDetectorDaypart;

const PERSISTED_ACTIVITY_PERSONALIZATION_DAYPARTS: readonly PersistedActivityPersonalizationDaypart[] = [
  'all',
  ...ACTIVITY_DETECTOR_DAYPARTS,
];

function parseActivityDatabaseId(activityId: string): number | null {
  const match = /^(?:activity|manual)-(\d+)$/.exec(activityId);
  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

function parseSleepMarkerId(sleepId: string): string | null {
  const match = /^sleep-(.+)$/.exec(sleepId);
  return match?.[1] ?? null;
}

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

function buildAccelGravity(row: HeartRateQueryRow) {
  if (
    row.accel_gravity_x !== null &&
    row.accel_gravity_y !== null &&
    row.accel_gravity_z !== null
  ) {
    return [row.accel_gravity_x, row.accel_gravity_y, row.accel_gravity_z] as [number, number, number];
  }

  return null;
}

function buildSensorDataFromRow(row: HeartRateQueryRow): SensorDataRow | null {
  const accelGravity = buildAccelGravity(row);

  const sensorData: SensorDataRow = {
    ppg_green: row.ppg_green ?? undefined,
    ppg_red_ir: row.ppg_red_ir ?? undefined,
    spo2_red: row.spo2_red ?? undefined,
    spo2_ir: row.spo2_ir ?? undefined,
    skin_temp_raw: row.skin_temp_raw ?? undefined,
    ambient_light: row.ambient_light ?? undefined,
    led_drive_1: row.led_drive_1 ?? undefined,
    led_drive_2: row.led_drive_2 ?? undefined,
    resp_rate_raw: row.resp_rate_raw ?? undefined,
    signal_quality: row.signal_quality ?? undefined,
    skin_contact: row.skin_contact ?? undefined,
    accel_gravity: accelGravity ?? undefined,
  };

  return Object.values(sensorData).some((value) => value !== undefined && value !== null)
    ? sensorData
    : null;
}

function toHeartRateRecord(row: HeartRateQueryRow): HeartRateRecord {
  const sensorData = buildSensorDataFromRow(row);

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
    skinContact: row.skin_contact ?? sensorData?.skin_contact ?? null,
    gravity: buildAccelGravity(row),
    ppgGreen: row.ppg_green ?? sensorData?.ppg_green ?? null,
    signalQuality: row.signal_quality ?? sensorData?.signal_quality ?? null,
  };
}

function toHeartRateSample(row: HeartRateSampleRow): HeartRateSample {
  return {
    bpm: row.bpm,
    time: row.time,
    date: parseSqliteDateTime(row.time),
  };
}

function toHeartMetricSample(row: HeartMetricSampleRow): HeartMetricSample {
  return {
    bpm: row.bpm,
    time: row.time,
    date: parseSqliteDateTime(row.time),
    stress: row.stress,
    spo2: row.spo2,
    skinTemp: row.skin_temp,
  };
}

function toSleepCycleRecord(row: SleepCycleRow): SleepCycleRecord {
  const completionStatus: SleepCompletionStatus =
    row.completion_status === 'in_progress' ? 'in_progress' : 'complete';

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
    score: completionStatus === 'in_progress' ? null : row.score,
    asleepMinutes: null,
    completionStatus,
    isInProgress: completionStatus === 'in_progress',
  };
}

function isCompleteSleepCycle(sleep: SleepCycleRecord): boolean {
  return sleep.completionStatus === 'complete';
}

function completeSleepCycles(sleeps: readonly SleepCycleRecord[]) {
  return sleeps.filter(isCompleteSleepCycle);
}

function isPlausibleSleepCycleRecord(sleep: SleepCycleRecord) {
  const durationHours = (sleep.end.getTime() - sleep.start.getTime()) / 3600000;
  return durationHours > 0 && durationHours <= MAX_MANUAL_SLEEP_WINDOW_HOURS;
}

function toActivityRecord(row: ActivityRow): ActivityRecord {
  const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
    ? row.confidence
    : null;
  const source: ActivitySource = row.source === 'manual' ? 'manual' : 'detected';
  const reviewState: ActivityReviewState =
    row.review_state === 'confirmed'
      ? 'confirmed'
      : row.review_state === 'relabelled'
        ? 'relabelled'
      : row.review_state === 'dismissed'
        ? 'dismissed'
        : 'none';

  return {
    id: source === 'manual' ? `manual-${row.id}` : `activity-${row.id}`,
    periodId: row.period_id,
    start: parseSqliteDateTime(row.start),
    end: parseSqliteDateTime(row.end),
    activity:
      row.activity === 'Nap'
        ? 'Nap'
        : row.activity === 'Walk'
          ? 'Walk'
          : row.activity === 'Workout'
            ? 'Workout'
            : 'Activity',
        confidence,
        source,
        reviewState,
  };
}

function isPersonalizableActivityName(activity: string): activity is PersonalizableActivityName {
  return PERSONALIZABLE_ACTIVITY_NAMES.some((candidate) => candidate === activity);
}

function buildDefaultActivityDetectorPersonalization(): ActivityDetectorPersonalization {
  return {
    activity: { ...DEFAULT_ACTIVITY_DETECTOR_THRESHOLDS.activity },
    walk: { ...DEFAULT_ACTIVITY_DETECTOR_THRESHOLDS.walk },
    workout: { ...DEFAULT_ACTIVITY_DETECTOR_THRESHOLDS.workout },
  };
}

function buildActivityDetectorPersonalization(reviewedRows: readonly ActivityPersonalizationSourceRow[]) {
  const personalization = buildDefaultActivityDetectorPersonalization();
  const stats = new Map<
    PersonalizableActivityName,
    Map<
      PersistedActivityPersonalizationDaypart,
      {
        positiveCount: number;
        negativeCount: number;
        positiveDurations: number[];
      }
    >
  >(
    PERSONALIZABLE_ACTIVITY_NAMES.map((activity) => {
      const entries = new Map<
        PersistedActivityPersonalizationDaypart,
        {
          positiveCount: number;
          negativeCount: number;
          positiveDurations: number[];
        }
      >(
        PERSISTED_ACTIVITY_PERSONALIZATION_DAYPARTS.map((daypart) => [
          daypart,
          {
            positiveCount: 0,
            negativeCount: 0,
            positiveDurations: [],
          },
        ]),
      );

      return [activity, entries];
    }),
  );

  for (const row of reviewedRows) {
    if (!isPersonalizableActivityName(row.activity)) {
      continue;
    }

    const entries = stats.get(row.activity)!;
    const daypart = activityDetectorDaypartForDate(parseSqliteDateTime(row.start));
    const applicableDayparts: PersistedActivityPersonalizationDaypart[] = ['all', daypart];
    const durationMinutes = Math.max(
      1,
      minutesBetween(parseSqliteDateTime(row.start), parseSqliteDateTime(row.end)),
    );

    for (const applicableDaypart of applicableDayparts) {
      const entry = entries.get(applicableDaypart)!;

      if (row.review_state === 'dismissed') {
        entry.negativeCount += 1;
        continue;
      }

      if (row.review_state === 'confirmed' || row.review_state === 'relabelled') {
        entry.positiveCount += 1;
        entry.positiveDurations.push(durationMinutes);
      }
    }
  }

  const updatedAt = formatSqliteDateTime(new Date());
  const rows: ActivityPersonalizationRow[] = [];

  for (const activity of PERSONALIZABLE_ACTIVITY_NAMES) {
    const detectorKind = DETECTOR_KIND_BY_ACTIVITY[activity];
    const defaults = DEFAULT_ACTIVITY_DETECTOR_THRESHOLDS[detectorKind];
    const entries = stats.get(activity)!;

    for (const daypart of PERSISTED_ACTIVITY_PERSONALIZATION_DAYPARTS) {
      const entry = entries.get(daypart)!;
      const medianPositiveDuration = median(entry.positiveDurations);
      let minDurationMinutes = defaults.minDurationMinutes;
      const minimumSamples = daypart === 'all'
        ? ACTIVITY_PERSONALIZATION_MIN_REVIEWED_SAMPLES
        : ACTIVITY_PERSONALIZATION_DAYPART_MIN_REVIEWED_SAMPLES;

      if (entry.positiveCount >= minimumSamples && medianPositiveDuration !== null) {
        const reduction = clamp(
          defaults.minDurationMinutes - medianPositiveDuration,
          0,
          ACTIVITY_PERSONALIZATION_MAX_DURATION_REDUCTION_MINUTES,
        );
        minDurationMinutes = Math.max(
          ACTIVITY_PERSONALIZATION_MIN_DURATION_BY_KIND[detectorKind],
          defaults.minDurationMinutes - reduction,
        );
      }

      const reviewedCount = entry.positiveCount + entry.negativeCount;
      let minConfidence = defaults.minConfidence;
      if (reviewedCount >= minimumSamples) {
        const confidenceShift = clamp(
          (entry.negativeCount - entry.positiveCount) * ACTIVITY_PERSONALIZATION_CONFIDENCE_STEP,
          -ACTIVITY_PERSONALIZATION_MAX_CONFIDENCE_DELTA,
          ACTIVITY_PERSONALIZATION_MAX_CONFIDENCE_DELTA,
        );
        minConfidence = clamp(
          defaults.minConfidence + confidenceShift,
          defaults.minConfidence - ACTIVITY_PERSONALIZATION_MAX_CONFIDENCE_DELTA,
          defaults.minConfidence + ACTIVITY_PERSONALIZATION_MAX_CONFIDENCE_DELTA,
        );
      }

      if (daypart === 'all') {
        personalization[detectorKind] = {
          minDurationMinutes,
          minConfidence,
          dayparts: {},
        };
      } else {
        personalization[detectorKind] = {
          ...personalization[detectorKind],
          dayparts: {
            ...personalization[detectorKind]?.dayparts,
            [daypart]: {
              minDurationMinutes,
              minConfidence,
            },
          },
        };
      }

      rows.push({
        activity_kind: activity,
        daypart,
        positive_count: entry.positiveCount,
        negative_count: entry.negativeCount,
        min_duration_minutes: Number(minDurationMinutes.toFixed(2)),
        min_confidence: Number(minConfidence.toFixed(2)),
        updated_at: updatedAt,
      });
    }
  }

  return {
    personalization,
    rows,
  };
}

async function replaceActivityDetectorPersonalizationRows(
  db: SQLiteDatabase,
  rows: readonly ActivityPersonalizationRow[],
) {
  await withAggregateMutationLock(db, async () => {
    await withExclusiveTransaction(db, async (tx) => {
      await tx.execAsync('DELETE FROM activity_personalization;');

      for (const row of rows) {
        await tx.runAsync(
          `
            INSERT INTO activity_personalization (
              activity_kind,
              daypart,
              positive_count,
              negative_count,
              min_duration_minutes,
              min_confidence,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          row.activity_kind,
          row.daypart,
          row.positive_count,
          row.negative_count,
          row.min_duration_minutes,
          row.min_confidence,
          row.updated_at,
        );
      }
    });
  });
}

async function rebuildActivityDetectorPersonalization(db: SQLiteDatabase): Promise<ActivityDetectorPersonalization> {
  const reviewedRows = await db.getAllAsync<ActivityPersonalizationSourceRow>(
    `
      SELECT activity, review_state, start, end
      FROM activities
      WHERE activity IN ('Activity', 'Walk', 'Workout') AND review_state <> 'none'
      ORDER BY start ASC
    `,
  );
  const built = buildActivityDetectorPersonalization(reviewedRows);

  await replaceActivityDetectorPersonalizationRows(db, built.rows);

  return built.personalization;
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

function sleepClockMinutes(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function calculateSleepConsistencyScore(sleeps: readonly SleepCycleRecord[]) {
  const completeSleeps = completeSleepCycles(sleeps);
  if (completeSleeps.length < MIN_SLEEP_CONSISTENCY_NIGHTS) {
    return null;
  }

  const bedtimeValues = completeSleeps.map((sleep) => sleepClockMinutes(sleep.start));
  const wakeValues = completeSleeps.map((sleep) => sleepClockMinutes(sleep.end));
  const bedtimeMean = mean(bedtimeValues);
  const wakeMean = mean(wakeValues);
  const bedtimeConsistency = clamp(100 - stdDev(bedtimeValues, bedtimeMean) / Math.max(1, bedtimeMean) * 100, 0, 100);
  const wakeConsistency = clamp(100 - stdDev(wakeValues, wakeMean) / Math.max(1, wakeMean) * 100, 0, 100);

  return Math.round((bedtimeConsistency + wakeConsistency) / 2);
}

function buildSleepCycleTrendSeries(options: {
  sleeps: readonly SleepCycleRecord[];
  range: HistoryRange;
  endDate: Date;
  digits?: number;
  valueForSleep: (sleep: SleepCycleRecord, index: number, sleeps: readonly SleepCycleRecord[]) => number | null;
}) {
  const digits = options.digits ?? 0;
  const valuesByDay = new Map<string, number | null>();

  options.sleeps.forEach((sleep, index) => {
    const value = options.valueForSleep(sleep, index, options.sleeps);
    valuesByDay.set(dateKey(sleep.end), value === null ? null : Number(value.toFixed(digits)));
  });

  return buildFilledDailySeries(options.range, options.endDate, (day) => valuesByDay.get(day) ?? null);
}

function latestSeriesValue(series: readonly TrendPoint[]) {
  return series.at(-1)?.value ?? null;
}

function previousSeriesValue(series: readonly TrendPoint[]) {
  for (let index = series.length - 2; index >= 0; index -= 1) {
    const value = series[index]?.value ?? null;
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function buildTrendMetricSeries(options: {
  title: string;
  unit: string;
  accent: MetricSeries['accent'];
  detail: string;
  series: TrendPoint[];
  missingReason: string;
  digits?: number;
  minFilledPoints?: number;
  isEstimated?: boolean;
}) {
  const digits = options.digits ?? 0;
  const latest = latestSeriesValue(options.series);
  const previous = previousSeriesValue(options.series);
  const values = trendValues(options.series);

  return {
    title: options.title,
    latest: latest === null ? null : Number(latest.toFixed(digits)),
    average: values.length === 0 ? null : Number(mean(values).toFixed(digits)),
    delta:
      latest === null || previous === null
        ? null
        : Number((latest - previous).toFixed(digits)),
    unit: options.unit,
    detail: latest === null ? options.missingReason : options.detail,
    accent: options.accent,
    series: options.series,
    isEstimated: options.isEstimated ?? true,
    hasPartialData: values.length > 0 && values.length < (options.minFilledPoints ?? 4),
    missingReason: latest === null ? options.missingReason : null,
  } satisfies MetricSeries;
}

function describeSkinTemperatureDeviation(delta: number | null) {
  if (delta === null) {
    return BUILDING_TEMPERATURE_BASELINE_REASON;
  }

  if (Math.abs(delta) < TEMPERATURE_BASELINE_NEUTRAL_DELTA) {
    return 'Overnight temperature stayed close to your recent baseline.';
  }

  return delta > 0
    ? 'Overnight temperature stayed above your recent baseline.'
    : 'Overnight temperature stayed below your recent baseline.';
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
      label: formatAxisTime(new Date(bucketStart), { includeSeconds: bucketMinutes < 1 }),
      value: bucketSummary ? Math.round(bucketSummary.average) : null,
    });
  }

  return series;
}

function createMetricTimeBuckets<T extends { date: Date }>(
  points: readonly T[],
  bucketMinutes: number,
  valueForBucket: (bucket: readonly T[]) => number | null,
  startDate: Date,
  endDate: Date,
  digits = 0,
): TrendPoint[] {
  if (endDate.getTime() < startDate.getTime()) {
    return [];
  }

  const bucketMs = bucketMinutes * 60000;
  const buckets = new Map<number, T[]>();

  for (const point of points) {
    if (point.date < startDate || point.date > endDate) {
      continue;
    }

    const bucketStart = Math.floor(point.date.getTime() / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart);

    if (bucket) {
      bucket.push(point);
      continue;
    }

    buckets.set(bucketStart, [point]);
  }

  const firstBucket = Math.floor(startDate.getTime() / bucketMs) * bucketMs;
  const lastBucket = Math.floor(endDate.getTime() / bucketMs) * bucketMs;
  const series: TrendPoint[] = [];

  for (let bucketStart = firstBucket; bucketStart <= lastBucket; bucketStart += bucketMs) {
    const bucket = buckets.get(bucketStart) ?? [];
    const value = bucket.length === 0 ? null : valueForBucket(bucket);
    series.push({
      label: formatAxisTime(new Date(bucketStart)),
      value: value === null ? null : Number(value.toFixed(digits)),
    });
  }

  return series;
}

function buildDashboardWindowMetricSeries<T extends { date: Date }>(options: {
  title: string;
  accent: MetricSeries['accent'];
  unit: string;
  detail: string;
  missingReason: string;
  rows: readonly T[];
  startDate: Date;
  endDate: Date;
  bucketMinutes: number;
  valueForBucket: (bucket: readonly T[]) => number | null;
  digits?: number;
  minFilledBuckets?: number;
}): MetricSeries {
  const digits = options.digits ?? 0;
  const series = createMetricTimeBuckets(
    options.rows,
    options.bucketMinutes,
    options.valueForBucket,
    options.startDate,
    options.endDate,
    digits,
  );
  const values = trendValues(series);

  return {
    title: options.title,
    latest: values.length === 0 ? null : Number(values.at(-1)!.toFixed(digits)),
    average: values.length === 0 ? null : Number(mean(values).toFixed(digits)),
    delta: values.length < 2 ? null : Number((values.at(-1)! - values[0]!).toFixed(digits)),
    unit: options.unit,
    detail: values.length === 0 ? options.missingReason : options.detail,
    accent: options.accent,
    series,
    isEstimated: false,
    hasPartialData: values.length > 0 && values.length < (options.minFilledBuckets ?? 4),
    missingReason: values.length === 0 ? options.missingReason : null,
  } satisfies MetricSeries;
}

function endOfDashboardDayWindow(dayKey: string, isToday: boolean, latestHeartDate: Date | null) {
  if (isToday && latestHeartDate) {
    return latestHeartDate;
  }

  return addMinutes(nextDayFromDayKey(dayKey), -DASHBOARD_HEART_BUCKET_MINUTES);
}

function mergeNearbySleepPeriods(periods: ActivityDetectorPeriod[]): ActivityDetectorPeriod[] {
  const sorted = [...periods].sort((left, right) => left.start.getTime() - right.start.getTime());
  const merged: ActivityDetectorPeriod[] = [];

  for (const period of sorted) {
    const previous = merged.at(-1);
    if (previous && minutesBetween(previous.end, period.start) < MAX_SLEEP_PAUSE_MINUTES) {
      previous.end = period.end;
      previous.durationMinutes = minutesBetween(previous.start, previous.end);
      previous.endsAtDataEnd = period.endsAtDataEnd === true;
      continue;
    }

    merged.push({ ...period });
  }

  return merged;
}

function selectSleepAndNapPeriods(periods: ActivityDetectorPeriod[]) {
  const grouped = new Map<string, ActivityDetectorPeriod[]>();

  for (const period of periods) {
    const key = dateKey(period.end);
    grouped.set(key, [...(grouped.get(key) ?? []), period]);
  }

  const sleeps: ActivityDetectorPeriod[] = [];
  const naps: ActivityDetectorPeriod[] = [];

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

function latestHeartSampleDate(rows: readonly HeartRateRecord[]) {
  let latest: Date | null = null;

  for (const row of rows) {
    if (!latest || row.date.getTime() > latest.getTime()) {
      latest = row.date;
    }
  }

  return latest;
}

function isRecentSourceSample(latestSourceSampleAt: Date | null, now: Date) {
  return latestSourceSampleAt !== null && minutesBetween(latestSourceSampleAt, now) <= IN_PROGRESS_SLEEP_RECENCY_MINUTES;
}

function detectedSleepCompletionStatus(
  period: ActivityDetectorPeriod,
  latestSourceSampleAt: Date | null,
  now: Date,
): SleepCompletionStatus {
  return period.endsAtDataEnd === true && isRecentSourceSample(latestSourceSampleAt, now)
    ? 'in_progress'
    : 'complete';
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

function buildSleepCycle(
  period: ActivityDetectorPeriod,
  rows: HeartRateRecord[],
  completionStatus: SleepCompletionStatus = 'complete',
): SleepCycleRecord | null {
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
  const resolvedCompletionStatus: SleepCompletionStatus =
    completionStatus === 'in_progress' && adjustedEnd.getTime() === period.end.getTime()
      ? 'in_progress'
      : 'complete';

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
    completionStatus: resolvedCompletionStatus,
    isInProgress: resolvedCompletionStatus === 'in_progress',
    asleepMinutes:
      trimmedStageRows.length === 0
        ? minutesBetween(period.start, adjustedEnd)
        : calculateTimeAsleepMinutes(trimmedStageRows, period.start, adjustedEnd),
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
  const scoredCompleteSleeps: SleepCycleRecord[] = [];
  const results: SleepCycleRecord[] = [];

  for (const sleep of sleeps) {
    if (sleep.isInProgress) {
      results.push({ ...sleep, score: null });
      continue;
    }

    const recentNaps = naps.filter((nap) => nap.activity === 'Nap' && nap.start >= new Date((scoredCompleteSleeps.at(-1)?.end ?? new Date(sleep.start.getTime() - 86400000)).getTime()) && nap.end <= sleep.start);
    const needMinutes = calculateSleepNeedMinutes(
      scoredCompleteSleeps.map((priorSleep) => priorSleep.asleepMinutes ?? minutesBetween(priorSleep.start, priorSleep.end)),
    );
    const effectiveSleepMinutes = (sleep.asleepMinutes ?? minutesBetween(sleep.start, sleep.end)) + Math.round(napCreditHours(recentNaps) * 60);
    const scoredSleep = {
      ...sleep,
      score: clamp((effectiveSleepMinutes / needMinutes) * 100, 0, 100),
    };
    scoredCompleteSleeps.push(scoredSleep);
    results.push(scoredSleep);
  }

  return results;
}

function minutesForClock(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function inferTargetWakeMinutes(sleeps: SleepCycleRecord[]) {
  const wakeTimes = completeSleepCycles(sleeps).slice(-RECENT_WAKE_INFERENCE_DAYS).map((sleep) => minutesForClock(sleep.end));
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

function buildSleepPlan(
  preferences: SleepPreferences,
  sleeps: SleepCycleRecord[],
  activities: ActivityRecord[],
  now = new Date(),
): SleepPlan {
  const completeSleeps = completeSleepCycles(sleeps);
  const latestSleep = completeSleeps.at(-1) ?? null;
  const recentSleepDurations = completeSleeps.map((sleep) => sleep.asleepMinutes ?? minutesBetween(sleep.start, sleep.end));
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

function buildSleepStageRowsFromInputs(sleepId: string, rows: readonly SleepStageInputRow[]): SleepStageRecord[] {
  return generateSleepStageRecords(rows).map((record) => ({
    sleepId,
    start: record.start,
    end: record.end,
    stage: record.stage,
    isEstimated: record.isEstimated,
  }));
}

function toSleepStageInputRowFromFeatureBucket(row: SleepFeatureBucketRow): SleepStageInputRow | null {
  const bpm = row.avg_bpm ?? row.min_bpm ?? row.max_bpm;
  if (bpm === null || sanitizeRecordedBpm(Math.round(bpm)) === null) {
    return null;
  }

  return {
    date: parseSqliteDateTime(row.bucket_start),
    bpm: Math.round(bpm),
    rr: parseRrIntervals(row.rr_intervals),
    ppgGreen: row.ppg_green_median === null ? null : Math.round(row.ppg_green_median),
    gravity:
      row.gravity_x !== null && row.gravity_y !== null && row.gravity_z !== null
        ? [row.gravity_x, row.gravity_y, row.gravity_z]
        : null,
    skinContact:
      row.skin_contact_count > 0
        ? row.skin_contact_present_count / row.skin_contact_count >= 0.5
          ? 1
          : 0
        : null,
    signalQuality:
      row.signal_quality_count > 0
        ? row.signal_quality_present_count / row.signal_quality_count >= 0.5
          ? 1
          : 0
        : null,
  };
}

function toSleepFeatureMetricSample(row: SleepFeatureBucketRow): SleepFeatureMetricSample | null {
  const bpm = row.avg_bpm ?? row.min_bpm ?? row.max_bpm;
  if (bpm === null || sanitizeRecordedBpm(Math.round(bpm)) === null) {
    return null;
  }

  return {
    bpm: Math.round(bpm),
    date: parseSqliteDateTime(row.bucket_start),
    rr: parseRrIntervals(row.rr_intervals),
    spo2: row.avg_spo2,
    skinTemp: row.avg_skin_temp,
  };
}

function summarizeSleepFeatureBucketRows(rows: readonly SleepFeatureBucketRow[]) {
  let sampleCount = 0;
  let minBpm: number | null = null;
  let maxBpm: number | null = null;
  let weightedBpmTotal = 0;
  let weightedBpmCount = 0;
  let weightedTempTotal = 0;
  let weightedTempCount = 0;

  for (const row of rows) {
    const rowSampleCount = Math.max(0, row.sample_count);
    sampleCount += rowSampleCount;

    const rowMin = row.min_bpm === null ? null : sanitizeRecordedBpm(row.min_bpm);
    const rowMax = row.max_bpm === null ? null : sanitizeRecordedBpm(row.max_bpm);
    const rowAvg = row.avg_bpm === null ? null : sanitizeRecordedBpm(Math.round(row.avg_bpm));

    if (rowMin !== null) {
      minBpm = minBpm === null ? rowMin : Math.min(minBpm, rowMin);
    }
    if (rowMax !== null) {
      maxBpm = maxBpm === null ? rowMax : Math.max(maxBpm, rowMax);
    }
    if (row.avg_bpm !== null && rowAvg !== null && rowSampleCount > 0) {
      weightedBpmTotal += row.avg_bpm * rowSampleCount;
      weightedBpmCount += rowSampleCount;
    }
    if (row.avg_skin_temp !== null && rowSampleCount > 0) {
      weightedTempTotal += row.avg_skin_temp * rowSampleCount;
      weightedTempCount += rowSampleCount;
    }
  }

  if (sampleCount === 0 || minBpm === null || maxBpm === null || weightedBpmCount === 0) {
    return null;
  }

  const hrvSummary = summarizeNumbers(
    calculateRollingHrv(rows.flatMap((row) => parseRrIntervals(row.rr_intervals))),
  );

  return {
    sampleCount,
    minBpm,
    maxBpm,
    avgBpm: Math.round(weightedBpmTotal / weightedBpmCount),
    minHrv: hrvSummary?.min ?? 0,
    maxHrv: hrvSummary?.max ?? 0,
    avgHrv: hrvSummary ? Math.round(hrvSummary.average) : 0,
    avgSkinTemp: weightedTempCount > 0 ? weightedTempTotal / weightedTempCount : null,
  };
}

function buildManualSleepDraftRecord(options: {
  id: string;
  priorSleeps: readonly SleepCycleRecord[];
  sleepId: string;
  start: Date;
  end: Date;
  summary: {
    minBpm: number;
    maxBpm: number;
    avgBpm: number;
    minHrv: number;
    maxHrv: number;
    avgHrv: number;
    avgSkinTemp: number | null;
  };
}) {
  const baseSleep: SleepCycleRecord = {
    id: options.id,
    sleepId: options.sleepId,
    start: options.start,
    end: options.end,
    inBedEnd: options.end,
    minBpm: options.summary.minBpm,
    maxBpm: options.summary.maxBpm,
    avgBpm: options.summary.avgBpm,
    minHrv: options.summary.minHrv,
    maxHrv: options.summary.maxHrv,
    avgHrv: options.summary.avgHrv,
    avgSkinTemp: options.summary.avgSkinTemp,
    score: null,
    completionStatus: 'complete',
    isInProgress: false,
    asleepMinutes: minutesBetween(options.start, options.end),
  };

  return scoreSleepCycles(
    [...options.priorSleeps, baseSleep].sort((left, right) => left.end.getTime() - right.end.getTime()),
    [],
  ).find((sleep) => sleep.id === baseSleep.id && sleep.sleepId === baseSleep.sleepId) ?? baseSleep;
}

function buildPlaceholderSleepStageRows(sleepId: string, start: Date, end: Date): SleepStageRecord[] {
  return [{
    sleepId,
    start,
    end,
    stage: 'light',
    isEstimated: true,
  }];
}

function buildManualSleepPersistenceArtifactsFromFeatureBuckets(options: {
  featureRows: readonly SleepFeatureBucketRow[];
  id: string;
  priorSleeps: readonly SleepCycleRecord[];
  sleepId: string;
  start: Date;
  end: Date;
}) {
  const windowRows = options.featureRows.filter((row) => {
    const rowDate = parseSqliteDateTime(row.bucket_start);
    return rowDate >= options.start && rowDate <= options.end;
  });
  const summary = summarizeSleepFeatureBucketRows(windowRows);
  if (!summary) {
    throw new Error(MANUAL_SLEEP_HEART_DATA_ERROR);
  }

  const stages = buildSleepStageRowsFromInputs(
    options.sleepId,
    windowRows
      .map(toSleepStageInputRowFromFeatureBucket)
      .filter((row): row is SleepStageInputRow => row !== null),
  );
  const stageSummary = summarizeSleepStages(stages, options.start, options.end);
  const sleep = buildManualSleepDraftRecord({
    id: options.id,
    priorSleeps: options.priorSleeps,
    sleepId: options.sleepId,
    start: options.start,
    end: options.end,
    summary,
  });
  const scoredSleep = {
    ...sleep,
    asleepMinutes: stageSummary.timeAsleepMinutes,
  };
  const rescoredSleep = scoreSleepCycles(
    [...options.priorSleeps, scoredSleep].sort((left, right) => left.end.getTime() - right.end.getTime()),
    [],
  ).find((candidate) => candidate.id === scoredSleep.id && candidate.sleepId === scoredSleep.sleepId) ?? scoredSleep;

  return {
    sleep: rescoredSleep,
    stages,
  };
}

async function insertSleepStageRecords(tx: TransactionWriter, stages: readonly SleepStageRecord[]) {
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
}

async function recomputeManualSleepArtifactsFromFeatureBuckets(
  db: SQLiteDatabase,
  options: {
    id: string;
    sleepId: string;
    start: Date;
    end: Date;
  },
) {
  const featureRows = await ensureSleepFeatureBucketsForRange(db, options.start, options.end);
  const priorSleeps = await querySleepCycles(
    db,
    `
      SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
      FROM sleep_cycles
      WHERE sleep_id <> ?
      ORDER BY end ASC
    `,
    [options.sleepId],
  );
  const { sleep, stages } = buildManualSleepPersistenceArtifactsFromFeatureBuckets({
    featureRows,
    id: options.id,
    priorSleeps,
    sleepId: options.sleepId,
    start: options.start,
    end: options.end,
  });
  const expectedStartSql = formatSqliteDateTime(options.start);
  const expectedEndSql = formatSqliteDateTime(options.end);

  await withExclusiveTransaction(db, async (tx) => {
    const result = await tx.runAsync(
      `
        UPDATE sleep_cycles
        SET min_bpm = ?,
            max_bpm = ?,
            avg_bpm = ?,
            min_hrv = ?,
            max_hrv = ?,
            avg_hrv = ?,
            avg_skin_temp = ?,
            score = ?,
            completion_status = 'complete',
            synced = 0,
            source = 'manual',
            review_state = 'confirmed'
        WHERE sleep_id = ? AND start = ? AND end = ?
      `,
      sleep.minBpm,
      sleep.maxBpm,
      sleep.avgBpm,
      sleep.minHrv,
      sleep.maxHrv,
      sleep.avgHrv,
      sleep.avgSkinTemp,
      sleep.score,
      options.sleepId,
      expectedStartSql,
      expectedEndSql,
    );

    if ('changes' in result && result.changes === 0) {
      return;
    }

    await tx.runAsync(
      `
        DELETE FROM sleep_stage_segments
        WHERE sleep_id = ?
      `,
      options.sleepId,
    );
    await insertSleepStageRecords(tx, stages.length > 0 ? stages : buildPlaceholderSleepStageRows(options.sleepId, options.start, options.end));
  });
}

function scheduleManualSleepArtifactRefresh(
  db: SQLiteDatabase,
  options: {
    id: string;
    sleepId: string;
    start: Date;
    end: Date;
  },
) {
  const run = () => {
    void recomputeManualSleepArtifactsFromFeatureBuckets(db, options).catch((error) => {
      logMobilePerfError('sleep.manual.recomputeArtifacts', error, {
        sleepId: options.sleepId,
      });
    });
  };

  if (typeof setTimeout === 'function') {
    setTimeout(run, 0);
    return;
  }

  run();
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

function validateManualSleepWindow(start: Date, end: Date) {
  if (end.getTime() <= start.getTime()) {
    throw new Error('Sleep end must be after start.');
  }

  const durationHours = (end.getTime() - start.getTime()) / 3600000;
  if (durationHours > MAX_MANUAL_SLEEP_WINDOW_HOURS) {
    throw new Error(
      `Sleep edits can cover up to ${MAX_MANUAL_SLEEP_WINDOW_HOURS} hours. Split longer rest into sleep plus nap.`,
    );
  }
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

function calculateTimeAsleepMinutes(
  records: readonly SleepStageRecord[],
  start?: Date,
  end?: Date,
): number {
  const awakeMinutes = records.reduce((sum, record, index) => (
    record.stage === 'awake' && !isTransientAwakeStage(records, index)
      ? sum + exactMinutesBetween(record.start, record.end)
      : sum
  ), 0);

  if (start && end) {
    return Math.max(0, Math.round(exactMinutesBetween(start, end) - awakeMinutes));
  }

  const totalMinutes = records.reduce((sum, record, index) => (
    record.stage === 'awake' && !isTransientAwakeStage(records, index)
      ? sum
      : sum + exactMinutesBetween(record.start, record.end)
  ), 0);

  return Math.max(0, Math.round(totalMinutes));
}

function buildActivityRecords(periods: ActivityDetectorPeriod[], sleeps: SleepCycleRecord[]): ActivityRecord[] {
  return periods
    .filter((period) => period.durationMinutes >= ACTIVITY_CHANGE_THRESHOLD_MINUTES)
    .filter((period) => !sleeps.some((sleep) => period.start <= sleep.end && period.end >= sleep.start))
    .map((period) => ({
      id: `${period.kind}-${period.start.toISOString()}`,
      periodId: dateKey(period.end),
      start: period.start,
      end: period.end,
      activity:
        period.kind === 'workout'
          ? 'Workout'
          : period.kind === 'walk'
            ? 'Walk'
            : 'Activity',
      confidence: period.confidence,
      source: 'detected',
      reviewState: 'none',
    }));
}

function buildNapActivities(periods: ActivityDetectorPeriod[]): ActivityRecord[] {
  return periods.map((period) => ({
    id: `nap-${period.start.toISOString()}`,
    periodId: dateKey(period.end),
    start: period.start,
    end: period.end,
    activity: 'Nap' as const,
    confidence: period.confidence,
    source: 'detected',
    reviewState: 'none',
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

function strainScoreFromTrimp(trimp: number) {
  if (trimp <= 0) {
    return 0;
  }

  return Math.round((21 * Math.log(trimp + 1) / Math.log(7201)) * 100) / 100;
}

function calculateStrain<T extends { bpm: number; date: Date }>(rows: T[], maxHr: number, restingHr: number): number | null {
  if (rows.length < 600 || maxHr <= restingHr) {
    return null;
  }

  const duration = sampleDurationMinutes(rows);
  const reserve = maxHr - restingHr;
  const trimp = rows.reduce((sum, row) => sum + duration * zoneWeight(row.bpm, restingHr, reserve), 0);

  return strainScoreFromTrimp(trimp);
}

function buildCumulativeStrainSeries<T extends { bpm: number; date: Date }>(
  rows: readonly T[],
  startDate: Date,
  endDate: Date,
  bucketMinutes: number,
  maxHr: number,
  restingHr: number,
): TrendPoint[] {
  if (endDate.getTime() < startDate.getTime()) {
    return [];
  }

  const bucketMs = bucketMinutes * 60000;
  const firstBucket = Math.floor(startDate.getTime() / bucketMs) * bucketMs;
  const lastBucket = Math.floor(endDate.getTime() / bucketMs) * bucketMs;
  const validRows = rows.filter((row) => sanitizeRecordedBpm(row.bpm) !== null);

  if (maxHr <= restingHr) {
    return Array.from({ length: Math.max(0, Math.floor((lastBucket - firstBucket) / bucketMs) + 1) }, (_, index) => ({
      label: formatAxisTime(new Date(firstBucket + index * bucketMs)),
      value: null,
    }));
  }

  const duration = sampleDurationMinutes([...validRows]);
  const reserve = maxHr - restingHr;
  const buckets = new Map<number, T[]>();

  for (const row of validRows) {
    if (row.date < startDate || row.date > endDate) {
      continue;
    }

    const bucketStart = Math.floor(row.date.getTime() / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart);

    if (bucket) {
      bucket.push(row);
      continue;
    }

    buckets.set(bucketStart, [row]);
  }

  let cumulativeTrimp = 0;
  let cumulativeSamples = 0;
  const series: TrendPoint[] = [];

  for (let bucketStart = firstBucket; bucketStart <= lastBucket; bucketStart += bucketMs) {
    const bucket = buckets.get(bucketStart) ?? [];

    for (const row of bucket) {
      const bpm = sanitizeRecordedBpm(row.bpm);
      if (bpm === null) {
        continue;
      }

      cumulativeTrimp += duration * zoneWeight(bpm, restingHr, reserve);
      cumulativeSamples += 1;
    }

    series.push({
      label: formatAxisTime(new Date(bucketStart)),
      value: cumulativeSamples < 600 ? null : strainScoreFromTrimp(cumulativeTrimp),
    });
  }

  return series;
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
  const completeSleeps = completeSleepCycles(sleeps);
  const lastFourteen = completeSleeps
    .slice(-14)
    .map((sleep) => sanitizeRecordedBpm(sleep.minBpm))
    .filter((value): value is number => value !== null);
  const sleepMedian = median(lastFourteen);
  if (sleepMedian !== null) {
    return Math.round(sleepMedian);
  }

  const latestSleep = completeSleeps.at(-1);
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

function dateFromDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function startOfDayFromDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function nextDayFromDayKey(dayKey: string) {
  const date = startOfDayFromDayKey(dayKey);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

function emptyDashboardMetricSeries(
  title: string,
  accent: MetricSeries['accent'],
  unit: string,
  missingReason: string,
): MetricSeries {
  return {
    title,
    latest: null,
    average: null,
    delta: null,
    unit,
    detail: missingReason,
    accent,
    series: [],
    missingReason,
  };
}

function buildDashboardDayState(dayKey: string, availableDayKeys: readonly string[]): DashboardDayState {
  const selectedDate = dateFromDayKey(dayKey);
  const selectedIndex = availableDayKeys.indexOf(dayKey);
  const todayKey = dateKey(new Date());
  const availableDays: DashboardDayOption[] = availableDayKeys.map((availableDayKey) => {
    const availableDate = dateFromDayKey(availableDayKey);
    return {
      dayKey: availableDayKey,
      shortLabel: formatShortDate(availableDate),
      longLabel: formatLongDate(availableDate),
    };
  });

  return {
    dayKey,
    shortLabel: formatShortDate(selectedDate),
    longLabel: formatLongDate(selectedDate),
    isToday: dayKey === todayKey,
    olderDayKey: selectedIndex > 0 ? availableDayKeys[selectedIndex - 1] ?? null : null,
    olderDayLabel:
      selectedIndex > 0 && availableDayKeys[selectedIndex - 1]
        ? formatShortDate(dateFromDayKey(availableDayKeys[selectedIndex - 1]!))
        : null,
    newerDayKey:
      selectedIndex >= 0 && selectedIndex < availableDayKeys.length - 1
        ? availableDayKeys[selectedIndex + 1] ?? null
        : null,
    newerDayLabel:
      selectedIndex >= 0 && selectedIndex < availableDayKeys.length - 1 && availableDayKeys[selectedIndex + 1]
        ? formatShortDate(dateFromDayKey(availableDayKeys[selectedIndex + 1]!))
        : null,
    availableDays,
  };
}

function buildTrendMetric(metric: MetricSeries, id: TrendMetric['id']): TrendMetric {
  return {
    ...metric,
    id,
  };
}

function averageNullable(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length === 0 ? null : mean(valid);
}

function buildDashboardInsights(options: {
  recoveryScore: number | null;
  sleepCard: SleepCardData;
  selectedStrain: number | null;
  stressCard: MetricSeries;
  activities: readonly ActivitySummary[];
}): DashboardInsight[] {
  const insights: DashboardInsight[] = [];

  if (options.recoveryScore !== null) {
    insights.push({
      id: 'recovery',
      title: options.recoveryScore >= 70 ? 'Recovery is holding up' : 'Recovery is still catching up',
      detail:
        options.recoveryScore >= 70
          ? 'Sleep and load are staying near your recent baseline.'
          : 'Keep effort controlled if you want a stronger rebound tomorrow.',
      accent: options.recoveryScore >= 70 ? 'green' : 'alert',
    });
  }

  if (options.sleepCard.durationMinutes !== null) {
    insights.push({
      id: 'sleep',
      title:
        options.sleepCard.durationMinutes >= 450 ? 'Sleep duration stayed solid' : 'Sleep duration was below target',
      detail: `${Math.floor(options.sleepCard.durationMinutes / 60)}h ${options.sleepCard.durationMinutes % 60}m asleep with ${options.sleepCard.timeInBedMinutes ?? options.sleepCard.durationMinutes}m in bed.`,
      accent: options.sleepCard.durationMinutes >= 450 ? 'violet' : 'alert',
    });
  }

  if (options.activities.length > 0) {
    const topActivity = [...options.activities].sort((left, right) => right.durationMinutes - left.durationMinutes)[0];
    insights.push({
      id: 'activity',
      title: options.selectedStrain !== null && options.selectedStrain >= 10 ? 'Training load was meaningful' : 'Movement stayed manageable',
      detail: `${topActivity.title} was the longest recorded session at ${topActivity.durationMinutes}m.`,
      accent: options.selectedStrain !== null && options.selectedStrain >= 10 ? 'cyan' : 'green',
    });
  } else if (options.stressCard.latest !== null) {
    insights.push({
      id: 'stress',
      title: options.stressCard.latest <= 30 ? 'Stress stayed relatively calm' : 'Stress trended elevated',
      detail: options.stressCard.latest <= 30 ? 'Recent variability stayed settled through the selected day.' : 'Stress drifted high enough to watch recovery closely.',
      accent: options.stressCard.latest <= 30 ? 'green' : 'alert',
    });
  }

  return insights.slice(0, 3);
}

function buildEmptyHistoryOverview(now: Date): HistoryOverview {
  const dayKey = dateKey(now);
  return {
    dateLabel: formatLongDate(now),
    day: buildDashboardDayState(dayKey, [dayKey]),
    recovery: {
      score: null,
      label: 'Waiting',
      caption: 'Recovery',
      isEstimated: true,
      missingReason: NO_HISTORY_REASON,
    },
    heartCard: {
      restingHr: null,
      averageHr: null,
      maxHr: null,
      pointIntervalMinutes: HEART_INTRADAY_BUCKET_MINUTES,
      series: [],
      markers: [],
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
      completionStatus: 'complete',
      isInProgress: false,
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
    activitySummary: [],
    insights: [],
  };
}

function buildEmptyTodayOverview(now: Date, _deviceState: DeviceStateRow | null): TodayOverview {
  const emptyHistory = buildEmptyHistoryOverview(now);
  const defaultSleepNeedMinutes = BASE_SLEEP_NEED_MINUTES;
  const defaultOptimalBedtimeMinutes = calculateOptimalBedtimeMinutes(
    DEFAULT_TARGET_WAKE_MINUTES,
    defaultSleepNeedMinutes,
  );

  return {
    greeting: greetingForHour(now.getHours()),
    dateLabel: emptyHistory.dateLabel,
    day: emptyHistory.day,
    recovery: emptyHistory.recovery,
    tonightPlan: {
      targetWakeMinutes: DEFAULT_TARGET_WAKE_MINUTES,
      targetWakeTime: formatClockMinutes(DEFAULT_TARGET_WAKE_MINUTES),
      optimalBedtimeMinutes: defaultOptimalBedtimeMinutes,
      optimalBedtime: formatClockMinutes(defaultOptimalBedtimeMinutes),
      sleepNeedMinutes: defaultSleepNeedMinutes,
      sleepDebtMinutes: 0,
      napCreditMinutes: 0,
      alarmEnabled: false,
    },
    sleepCard: emptyHistory.sleepCard,
    strainCard: emptyHistory.strainCard,
    activitySummary: emptyHistory.activitySummary,
    insights: emptyHistory.insights,
  };
}

function dashboardSyncLabel(deviceState: DeviceStateRow | null): string {
  return deviceState?.last_synced_at
    ? `Last sync ${formatClock(parseSqliteDateTime(deviceState.last_synced_at))}`
    : 'Local seed loaded';
}

async function loadActivitiesOverlappingRange(db: SQLiteDatabase, start: Date, end: Date) {
  const startSql = formatSqliteDateTime(start);
  const endSql = formatSqliteDateTime(end);

  return queryActivities(
    db,
    `
      SELECT ${ACTIVITY_SELECT_COLUMNS}
      FROM activities
      WHERE start <= ? AND end >= ? AND review_state <> 'dismissed'
      ORDER BY start ASC
    `,
    [endSql, startSql],
  );
}

async function loadReviewedActivityOverlapsRange(db: SQLiteDatabase, start: Date, end: Date) {
  const startSql = formatSqliteDateTime(start);
  const endSql = formatSqliteDateTime(end);

  return queryActivities(
    db,
    `
      SELECT ${ACTIVITY_SELECT_COLUMNS}
      FROM activities
      WHERE start <= ? AND end >= ? AND review_state <> 'none'
      ORDER BY start ASC
    `,
    [endSql, startSql],
  );
}

async function loadPreservedSleepIds(
  db: SQLiteDatabase,
  sleepIds: readonly string[],
) {
  const uniqueSleepIds = [...new Set(sleepIds)];
  if (uniqueSleepIds.length === 0) {
    return [];
  }

  const placeholders = uniqueSleepIds.map(() => '?').join(', ');
  const rows = await db.getAllAsync<{ sleep_id: string }>(
    `
      SELECT sleep_id
      FROM sleep_cycles
      WHERE sleep_id IN (${placeholders})
        AND NOT (
          (source IS NULL OR source = 'detected')
          AND (review_state IS NULL OR review_state = 'none')
        )
    `,
    ...uniqueSleepIds,
  );

  return [...new Set(rows.map((row) => row.sleep_id))];
}

function activitiesOverlap(
  left: Pick<ActivityRecord, 'start' | 'end'>,
  right: Pick<ActivityRecord, 'start' | 'end'>,
) {
  return left.start <= right.end && left.end >= right.start;
}

function applyReviewedActivityGuardrails(
  detectedActivities: readonly ActivityRecord[],
  reviewedOverlaps: readonly ActivityRecord[],
) {
  if (detectedActivities.length === 0 || reviewedOverlaps.length === 0) {
    return [...detectedActivities];
  }

  return detectedActivities.filter((activity) => !reviewedOverlaps.some((reviewed) => activitiesOverlap(activity, reviewed)));
}

function applyPreservedSleepGuardrails(
  artifacts: ReturnType<typeof buildDerivedDetectionArtifacts>,
  preservedSleepIds: readonly string[],
) {
  if (artifacts.sleepCycles.length === 0 || preservedSleepIds.length === 0) {
    return artifacts;
  }

  const preservedIds = new Set(preservedSleepIds);

  return {
    ...artifacts,
    sleepCycles: artifacts.sleepCycles.filter((sleep) => !preservedIds.has(sleep.sleepId)),
    stages: artifacts.stages.filter((stage) => !preservedIds.has(stage.sleepId)),
  };
}

async function loadSleepStageRecordsForIds(
  db: SQLiteDatabase,
  sleepIds: readonly string[],
) {
  const uniqueSleepIds = [...new Set(sleepIds)];
  if (uniqueSleepIds.length === 0) {
    return [];
  }

  const placeholders = uniqueSleepIds.map(() => '?').join(', ');
  return querySleepStages(
    db,
    `
      SELECT id, sleep_id, start, end, stage, is_estimated
      FROM sleep_stage_segments
      WHERE sleep_id IN (${placeholders})
      ORDER BY sleep_id ASC, start ASC
    `,
    uniqueSleepIds,
  );
}

function groupSleepStageRecordsBySleepId(stageRecords: readonly SleepStageRecord[]) {
  const recordsBySleepId = new Map<string, SleepStageRecord[]>();

  for (const record of stageRecords) {
    const current = recordsBySleepId.get(record.sleepId);
    if (current) {
      current.push(record);
    } else {
      recordsBySleepId.set(record.sleepId, [record]);
    }
  }

  return recordsBySleepId;
}

function buildSleepStageSummaryMap(
  sleepCycles: readonly SleepCycleRecord[],
  stageRecords: readonly SleepStageRecord[],
) {
  const recordsBySleepId = groupSleepStageRecordsBySleepId(stageRecords);

  return new Map(
    sleepCycles.map((sleep) => [
      sleep.sleepId,
      summarizeSleepStages(recordsBySleepId.get(sleep.sleepId) ?? [], sleep.start, sleep.inBedEnd ?? sleep.end),
    ] as const),
  );
}

async function loadNapActivitiesForSleepScoreRange(
  db: SQLiteDatabase,
  sleepCycles: readonly SleepCycleRecord[],
) {
  if (sleepCycles.length === 0) {
    return [];
  }

  const earliestRelevantStart = new Date(sleepCycles[0].start.getTime() - 24 * 3600000);
  const latestRelevantEnd = sleepCycles.at(-1)?.start ?? sleepCycles[0].start;

  return queryActivities(
    db,
    `
      SELECT ${ACTIVITY_SELECT_COLUMNS}
      FROM activities
      WHERE activity = 'Nap' AND start >= ? AND end <= ? AND review_state <> 'dismissed'
      ORDER BY start ASC
    `,
    [formatSqliteDateTime(earliestRelevantStart), formatSqliteDateTime(latestRelevantEnd)],
  );
}

function rescoreSleepCyclesWithSummaries(
  sleepCycles: readonly SleepCycleRecord[],
  stageSummaries: ReadonlyMap<string, SleepStageSummary>,
  naps: readonly ActivityRecord[],
) {
  if (sleepCycles.length === 0) {
    return [];
  }

  return scoreSleepCycles(
    sleepCycles.map((sleep) => ({
      ...sleep,
      asleepMinutes:
        stageSummaries.get(sleep.sleepId)?.timeAsleepMinutes ??
        sleep.asleepMinutes ??
        minutesBetween(sleep.start, sleep.end),
    })),
    [...naps],
  );
}

async function loadHeartMarkerSleepDetails(
  db: SQLiteDatabase,
  sleepCycles: readonly SleepCycleRecord[],
): Promise<Map<string, HeartIntradayMarkerDetails>> {
  const sleepIds = [...new Set(sleepCycles.map((sleep) => sleep.sleepId))];
  if (sleepIds.length === 0) {
    return new Map();
  }

  const stageRecords = await loadSleepStageRecordsForIds(db, sleepIds);
  const summariesBySleepId = buildSleepStageSummaryMap(sleepCycles, stageRecords);

  return new Map(
    sleepCycles.map((sleep) => {
      const summary = summariesBySleepId.get(sleep.sleepId) ?? null;

      return [sleep.sleepId, buildHeartIntradaySleepDetails(sleep, summary)] as const;
    }),
  );
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

  const completeSleeps = completeSleepCycles(sleeps);
  const resolvedLatestSleep =
    latestSleep && isCompleteSleepCycle(latestSleep)
      ? latestSleep
      : completeSleeps.at(-1) ?? null;
  const priorSleeps = completeSleeps.slice(-15, -1);
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
  const latestTemp = resolvedLatestSleep ? averageTemperatureForRange(heartRows, resolvedLatestSleep.start, resolvedLatestSleep.end) : null;
  const tempDelta = latestTemp !== null && tempBaseline !== null ? latestTemp - tempBaseline : null;

  const breakdown: RecoveryBreakdown = {
    sleepScore: resolvedLatestSleep?.score ?? null,
    hrvComponent: relativeDelta(resolvedLatestSleep?.avgHrv ?? null, hrvBaseline),
    rhrComponent: relativeDelta(resolvedLatestSleep ? sanitizeRecordedBpm(resolvedLatestSleep.minBpm) : null, rhrBaseline),
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
  const completeSleeps = completeSleepCycles(sleeps);
  const resolvedLatestSleep =
    latestSleep && isCompleteSleepCycle(latestSleep)
      ? latestSleep
      : completeSleeps.at(-1) ?? null;
  const priorSleeps = completeSleeps.slice(-15, -1);
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
  const latestTemp = resolvedLatestSleep?.avgSkinTemp ?? null;
  const tempDelta = latestTemp !== null && tempBaseline !== null ? latestTemp - tempBaseline : null;

  const breakdown: RecoveryBreakdown = {
    sleepScore: resolvedLatestSleep?.score ?? null,
    hrvComponent: relativeDelta(resolvedLatestSleep?.avgHrv ?? null, hrvBaseline),
    rhrComponent: relativeDelta(resolvedLatestSleep ? sanitizeRecordedBpm(resolvedLatestSleep.minBpm) : null, rhrBaseline),
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

async function buildDashboardSupplement(options: {
  db: SQLiteDatabase;
  selectedDayKey: string;
  heartDayStats: readonly HeartDayStatRecord[];
  sleepCycles: readonly SleepCycleRecord[];
  selectedSleep: SleepCycleRecord | null;
  latestStress: number | null;
  restingHr: number;
  maxHr: number;
  selectedDayHeartRows: readonly HeartMetricSample[];
  selectedSleepFeatureRows: readonly SleepFeatureBucketRow[];
}) {
  const [availableDayKeys, activityRows] = await Promise.all([
    loadDashboardDayKeys(options.db, 30),
    loadActivitiesForDay(options.db, options.selectedDayKey, 5),
  ]);
  const day = buildDashboardDayState(
    options.selectedDayKey,
    availableDayKeys.includes(options.selectedDayKey) ? availableDayKeys : [...availableDayKeys, options.selectedDayKey],
  );
  const selectedDayStart = startOfDayFromDayKey(options.selectedDayKey);
  const selectedDayEnd = endOfDashboardDayWindow(
    options.selectedDayKey,
    day.isToday,
    options.selectedDayHeartRows.at(-1)?.date ?? null,
  );
  const overnightStart = options.selectedSleep?.start ?? selectedDayStart;
  const overnightEnd = options.selectedSleep?.end ?? selectedDayEnd;
  const selectedSleepMetricRows = options.selectedSleepFeatureRows
    .map(toSleepFeatureMetricSample)
    .filter((row): row is SleepFeatureMetricSample => row !== null);
  const hrvCard = options.selectedSleep
    ? buildDashboardWindowMetricSeries({
        title: 'HRV',
        accent: 'green',
        unit: 'ms',
        detail: 'Overnight HRV across the selected sleep window.',
        missingReason: NO_SLEEP_REASON,
        rows: selectedSleepMetricRows,
        startDate: overnightStart,
        endDate: overnightEnd,
        bucketMinutes: DASHBOARD_SLEEP_METRIC_BUCKET_MINUTES,
        valueForBucket: (bucket) => rrToRmssd(bucket.flatMap((row) => row.rr)),
      })
    : emptyDashboardMetricSeries('HRV', 'green', 'ms', NO_SLEEP_REASON);
  const stressCard = buildDashboardWindowMetricSeries({
    title: 'Stress',
    unit: '',
    accent: 'alert',
    detail: 'Stress drift across the selected day.',
    missingReason: LIMITED_SENSOR_REASON,
    rows: options.selectedDayHeartRows,
    startDate: selectedDayStart,
    endDate: selectedDayEnd,
    bucketMinutes: DASHBOARD_DAY_METRIC_BUCKET_MINUTES,
    valueForBucket: (bucket) => averageNullable(bucket.map((row) => row.stress)),
    minFilledBuckets: 6,
  });
  const daytimeSpo2Card = buildDashboardWindowMetricSeries({
    title: 'SpO2',
    unit: '%',
    accent: 'cyan',
    detail: 'Oxygen readings across the selected day.',
    missingReason: LIMITED_SENSOR_REASON,
    rows: options.selectedDayHeartRows,
    startDate: selectedDayStart,
    endDate: selectedDayEnd,
    bucketMinutes: DASHBOARD_DAY_METRIC_BUCKET_MINUTES,
    valueForBucket: (bucket) => averageNullable(bucket.map((row) => row.spo2)),
    minFilledBuckets: 4,
  });
  const overnightSpo2Card = options.selectedSleep
    ? buildDashboardWindowMetricSeries({
        title: 'SpO2',
        unit: '%',
        accent: 'cyan',
        detail: 'Overnight oxygen through the selected sleep window.',
        missingReason: LIMITED_SENSOR_REASON,
        rows: selectedSleepMetricRows,
        startDate: overnightStart,
        endDate: overnightEnd,
        bucketMinutes: DASHBOARD_SLEEP_METRIC_BUCKET_MINUTES,
        valueForBucket: (bucket) => averageNullable(bucket.map((row) => row.spo2)),
      })
    : null;
  const spo2Card =
    overnightSpo2Card && trendValues(overnightSpo2Card.series).length > 0 ? overnightSpo2Card : daytimeSpo2Card;
  const daytimeSkinTemperatureCard = buildDashboardWindowMetricSeries({
    title: 'Skin Temperature',
    unit: '°C',
    accent: 'heart',
    detail: 'Skin temperature across the selected day.',
    missingReason: LIMITED_SENSOR_REASON,
    rows: options.selectedDayHeartRows,
    startDate: selectedDayStart,
    endDate: selectedDayEnd,
    bucketMinutes: DASHBOARD_DAY_METRIC_BUCKET_MINUTES,
    valueForBucket: (bucket) => averageNullable(bucket.map((row) => row.skinTemp)),
    digits: 1,
    minFilledBuckets: 4,
  });
  const overnightSkinTemperatureCard = options.selectedSleep
    ? buildDashboardWindowMetricSeries({
        title: 'Skin Temperature',
        unit: '°C',
        accent: 'heart',
        detail: 'Overnight skin temperature through the selected sleep window.',
        missingReason: LIMITED_SENSOR_REASON,
        rows: selectedSleepMetricRows,
        startDate: overnightStart,
        endDate: overnightEnd,
        bucketMinutes: DASHBOARD_SLEEP_METRIC_BUCKET_MINUTES,
        valueForBucket: (bucket) => averageNullable(bucket.map((row) => row.skinTemp)),
        digits: 1,
      })
    : null;
  const skinTemperatureCard =
    overnightSkinTemperatureCard && trendValues(overnightSkinTemperatureCard.series).length > 0
      ? overnightSkinTemperatureCard
      : daytimeSkinTemperatureCard;

  const activityBuckets = await Promise.all(
    activityRows.map((activity) => loadHeartBucketRowsBetweenRange(options.db, activity.start, activity.end)),
  );
  const activitySummary = [...activityRows]
    .sort((left, right) => right.start.getTime() - left.start.getTime())
    .map((activity, index): ActivitySummary => {
      const rows = activityBuckets[index] ?? [];
      const durationMinutes = minutesBetween(activity.start, activity.end);
      return {
        id: activity.id,
        title: activity.activity,
        timeLabel: formatClock(activity.start),
        durationMinutes,
        strain: calculateStrainFromBucketRows(rows, options.maxHr, options.restingHr, durationMinutes),
        calories: estimateCaloriesFromBucketRows(rows, options.maxHr, options.restingHr, durationMinutes),
        isEstimated: true,
        confidence: activity.confidence,
        source: activity.source,
        reviewState: activity.reviewState,
        strainLabel: 'Estimated strain',
        caloriesLabel: 'Estimated calories',
      };
    });

  const dayStatsByDay = new Map(options.heartDayStats.map((stat) => [stat.day, stat]));
  const selectedStrain = dayStatsByDay.get(options.selectedDayKey)?.strainScore ?? null;
  const sleepCard = buildDashboardSleepCard(options.selectedSleep, []);

  return {
    day,
    hrvCard,
    stressCard,
    spo2Card,
    skinTemperatureCard,
    activitySummary,
    insights: buildDashboardInsights({
      recoveryScore: estimateRecoveryScoreFromSleeps(options.selectedSleep, [...options.sleepCycles], options.latestStress).score,
      sleepCard,
      selectedStrain,
      stressCard,
      activities: activitySummary,
    }),
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

function aggregateSleepStages(
  records: readonly SleepStageRecord[],
  start: Date,
  end: Date,
): SleepStageSegment[] {
  if (records.length === 0 || end.getTime() <= start.getTime()) {
    return [];
  }

  const merged: Array<{ stage: SleepStage; exactMinutes: number }> = [];
  let cursor = start;

  const pushStage = (stage: SleepStage, exactMinutes: number) => {
    if (exactMinutes <= 0) {
      return;
    }

    const previous = merged.at(-1);
    if (previous?.stage === stage) {
      previous.exactMinutes += exactMinutes;
      return;
    }

    merged.push({
      stage,
      exactMinutes,
    });
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const recordStart = new Date(Math.max(cursor.getTime(), record.start.getTime(), start.getTime()));
    const recordEnd = new Date(Math.min(record.end.getTime(), end.getTime()));

    if (recordStart.getTime() > cursor.getTime()) {
      pushStage('light', exactMinutesBetween(cursor, recordStart));
    }

    const exactMinutes = exactMinutesBetween(recordStart, recordEnd);
    if (exactMinutes <= 0) {
      if (recordEnd.getTime() > cursor.getTime()) {
        cursor = recordEnd;
      }
      continue;
    }

    if (isTransientAwakeStage(records, index)) {
      pushStage('light', exactMinutes);
      cursor = recordEnd;
      continue;
    }

    pushStage(record.stage, exactMinutes);
    cursor = recordEnd;
  }

  if (cursor.getTime() < end.getTime()) {
    pushStage('light', exactMinutesBetween(cursor, end));
  }

  return simplifySleepStageSummaries(merged).map((segment) => ({
    stage: segment.stage,
    minutes: Math.max(1, Math.round(segment.exactMinutes)),
  }));
}

function buildHeartIntradayMarkerRange(windowStart: Date, windowEnd: Date, start: Date, end: Date) {
  const rangeStartMs = windowStart.getTime();
  const rangeEndMs = windowEnd.getTime();
  const markerStartMs = Math.max(rangeStartMs, start.getTime());
  const markerEndMs = Math.min(rangeEndMs, end.getTime());

  if (markerEndMs <= markerStartMs) {
    return null;
  }

  const totalWindowMs = Math.max(1, rangeEndMs - rangeStartMs);
  return {
    start: new Date(markerStartMs),
    end: new Date(markerEndMs),
    startFraction: clamp((markerStartMs - rangeStartMs) / totalWindowMs, 0, 1),
    endFraction: clamp((markerEndMs - rangeStartMs) / totalWindowMs, 0, 1),
  };
}

function buildHeartIntradaySleepDetails(
  sleep: SleepCycleRecord,
  stageSummary?: SleepStageSummary | null,
): HeartIntradayMarkerDetails {
  const timeInBedMinutes =
    stageSummary?.timeInBedMinutes ?? Math.max(1, Math.round(exactMinutesBetween(sleep.start, sleep.inBedEnd ?? sleep.end)));

  return {
    durationMinutes: timeInBedMinutes,
    score: sleep.score,
    completionStatus: sleep.completionStatus,
    isInProgress: sleep.isInProgress,
    asleepMinutes: sleep.asleepMinutes ?? stageSummary?.timeAsleepMinutes ?? null,
    timeInBedMinutes,
    remMinutes: stageSummary?.remMinutes ?? null,
    deepMinutes: stageSummary?.deepMinutes ?? null,
    stages: stageSummary?.stages ?? [],
  };
}

function buildHeartIntradayActivityDetails(activity: ActivityRecord): HeartIntradayMarkerDetails {
  return {
    durationMinutes: Math.max(1, Math.round(exactMinutesBetween(activity.start, activity.end))),
    confidence: activity.confidence,
    source: activity.source,
    reviewState: activity.reviewState,
  };
}

function buildHeartIntradayMarkers(
  windowStart: Date,
  windowEnd: Date,
  sleepCycles: readonly SleepCycleRecord[],
  activities: readonly ActivityRecord[],
  sleepDetailsBySleepId: ReadonlyMap<string, HeartIntradayMarkerDetails> = new Map(),
): HeartIntradayMarker[] {
  const sleepMarkers = sleepCycles.flatMap((sleep) => {
    const range = buildHeartIntradayMarkerRange(windowStart, windowEnd, sleep.start, sleep.end);
    if (!range) {
      return [];
    }

    return [{
      id: `sleep-${sleep.sleepId}`,
      kind: 'sleep' as const,
      label: sleep.isInProgress ? 'In progress' : 'Sleep',
      timeLabel: sleep.isInProgress
        ? `${formatClock(range.start)} - synced through ${formatClock(range.end)}`
        : `${formatClock(range.start)} - ${formatClock(range.end)}`,
      startFraction: range.startFraction,
      endFraction: range.endFraction,
      startTimeMs: range.start.getTime(),
      endTimeMs: range.end.getTime(),
      details: sleepDetailsBySleepId.get(sleep.sleepId),
    } satisfies HeartIntradayMarker];
  });

  const activityMarkers = activities.flatMap((activity) => {
    const range = buildHeartIntradayMarkerRange(windowStart, windowEnd, activity.start, activity.end);
    if (!range) {
      return [];
    }

    return [{
      id: activity.id,
      kind: activity.activity === 'Nap' ? 'nap' : 'activity',
      label: activity.activity,
      timeLabel: `${formatClock(range.start)} - ${formatClock(range.end)}`,
      startFraction: range.startFraction,
      endFraction: range.endFraction,
      startTimeMs: range.start.getTime(),
      endTimeMs: range.end.getTime(),
      details: buildHeartIntradayActivityDetails(activity),
    } satisfies HeartIntradayMarker];
  });

  return [...sleepMarkers, ...activityMarkers].sort((left, right) => {
    if (left.startFraction !== right.startFraction) {
      return left.startFraction - right.startFraction;
    }

    if (left.endFraction !== right.endFraction) {
      return left.endFraction - right.endFraction;
    }

    return left.label.localeCompare(right.label);
  });
}

function medianHeartSampleGapSeconds(rows: readonly HeartRateSampleRow[]) {
  if (rows.length < 2) {
    return null;
  }

  const gaps: number[] = [];

  for (let index = 1; index < rows.length; index += 1) {
    const gapSeconds =
      (parseSqliteDateTime(rows[index].time).getTime() -
        parseSqliteDateTime(rows[index - 1].time).getTime()) /
      1000;

    if (gapSeconds > 0) {
      gaps.push(gapSeconds);
    }
  }

  return gaps.length > 0 ? median(gaps) : null;
}

function buildFocusedHeartDetailMarker(marker: HeartIntradayMarker): HeartIntradayMarker {
  return {
    ...marker,
    startFraction: 0,
    endFraction: 1,
  };
}

function summarizeSleepStages(
  records: readonly SleepStageRecord[],
  start: Date,
  end: Date,
): SleepStageSummary {
  const lastRecordedEnd = records.at(-1)?.end ?? null;
  const inBedEnd = lastRecordedEnd && lastRecordedEnd.getTime() > end.getTime() ? lastRecordedEnd : end;
  const sleepEnd = trimTrailingAwakeEnd(records, inBedEnd);
  const visibleRecords = records.filter((record) => record.start.getTime() < sleepEnd.getTime());
  const stages = aggregateSleepStages(visibleRecords, start, sleepEnd);
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

  const timeAsleepMinutes = Math.min(timeInBedMinutes, calculateTimeAsleepMinutes(visibleRecords, start, sleepEnd));
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
    queryAllHeartRows(db),
    db.getAllAsync<SleepCycleRow>(`SELECT ${SLEEP_CYCLE_SELECT_COLUMNS} FROM sleep_cycles ORDER BY start ASC`),
    db.getAllAsync<ActivityRow>(`SELECT ${ACTIVITY_SELECT_COLUMNS} FROM activities WHERE review_state <> 'dismissed' ORDER BY start ASC`),
    db.getAllAsync<SleepStageRow>('SELECT id, sleep_id, start, end, stage, is_estimated FROM sleep_stage_segments ORDER BY start ASC'),
    db.getAllAsync<DeviceStateRow>('SELECT id, name, last_seen_at, last_synced_at, firmware, battery_percent, charging_status, body_status, sync_error FROM device_state ORDER BY last_synced_at DESC LIMIT 1'),
  ]);

  return {
    heartRows,
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

async function loadHeartTimeBounds(db: SQLiteDatabase) {
  return db.getFirstAsync<{ min_time: string | null; max_time: string | null }>(
    `
      SELECT MIN(time) AS min_time, MAX(time) AS max_time
      FROM heart_rate
    `,
  );
}

async function queryHeartRowsBetween(
  db: SQLiteDatabase,
  start: Date,
  end: Date,
  options?: { includeEnd?: boolean },
) {
  const includeEnd = options?.includeEnd ?? true;
  if (end.getTime() < start.getTime() || (end.getTime() === start.getTime() && !includeEnd)) {
    return [];
  }

  if (end.getTime() === start.getTime()) {
    return queryHeartRows(
      db,
      `
        SELECT ${HEART_RATE_FULL_SELECT_COLUMNS}
        FROM heart_rate
        WHERE time = ?
        ORDER BY time ASC
      `,
      [formatSqliteDateTime(start)],
    );
  }

  const rows: HeartRateRecord[] = [];
  let chunkStartMs = start.getTime();

  while (chunkStartMs < end.getTime()) {
    const chunkEndMs = Math.min(chunkStartMs + HEART_ROW_QUERY_CHUNK_MS, end.getTime());
    const isFinalChunk = chunkEndMs >= end.getTime();
    const endComparator = isFinalChunk && includeEnd ? '<=' : '<';
    const chunkRows = await queryHeartRows(
      db,
      `
        SELECT ${HEART_RATE_FULL_SELECT_COLUMNS}
        FROM heart_rate
        WHERE time >= ? AND time ${endComparator} ?
        ORDER BY time ASC
      `,
      [
        formatSqliteDateTime(new Date(chunkStartMs)),
        formatSqliteDateTime(new Date(chunkEndMs)),
      ],
    );

    for (const row of chunkRows) {
      rows.push(row);
    }
    chunkStartMs = chunkEndMs;
  }

  return rows;
}

async function queryAllHeartRows(db: SQLiteDatabase) {
  const bounds = await loadHeartTimeBounds(db);
  if (!bounds?.min_time || !bounds.max_time) {
    return [];
  }

  return queryHeartRowsBetween(db, parseSqliteDateTime(bounds.min_time), parseSqliteDateTime(bounds.max_time));
}

async function queryHeartSampleRows(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return db.getAllAsync<HeartRateSampleRow>(sql, ...args);
}

async function queryHeartSampleRowsBetween(
  db: SQLiteDatabase,
  start: Date,
  end: Date,
  options?: { includeEnd?: boolean },
) {
  const includeEnd = options?.includeEnd ?? true;
  if (end.getTime() < start.getTime() || (end.getTime() === start.getTime() && !includeEnd)) {
    return [];
  }

  if (end.getTime() === start.getTime()) {
    return queryHeartSampleRows(
      db,
      `
        SELECT bpm, time
        FROM heart_rate
        WHERE time = ?
        ORDER BY time ASC
      `,
      [formatSqliteDateTime(start)],
    );
  }

  const rows: HeartRateSampleRow[] = [];
  let chunkStartMs = start.getTime();

  while (chunkStartMs < end.getTime()) {
    const chunkEndMs = Math.min(chunkStartMs + HEART_ROW_QUERY_CHUNK_MS, end.getTime());
    const isFinalChunk = chunkEndMs >= end.getTime();
    const endComparator = isFinalChunk && includeEnd ? '<=' : '<';
    const chunkRows = await queryHeartSampleRows(
      db,
      `
        SELECT bpm, time
        FROM heart_rate
        WHERE time >= ? AND time ${endComparator} ?
        ORDER BY time ASC
      `,
      [
        formatSqliteDateTime(new Date(chunkStartMs)),
        formatSqliteDateTime(new Date(chunkEndMs)),
      ],
    );

    for (const row of chunkRows) {
      rows.push(row);
    }
    chunkStartMs = chunkEndMs;
  }

  return rows;
}

async function queryHeartSamples(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await queryHeartSampleRows(db, sql, args)).map(toHeartRateSample);
}

async function queryHeartSamplesBetween(
  db: SQLiteDatabase,
  start: Date,
  end: Date,
  options?: { includeEnd?: boolean },
) {
  return (await queryHeartSampleRowsBetween(db, start, end, options)).map(toHeartRateSample);
}

async function queryHeartMetricRowsBetween(
  db: SQLiteDatabase,
  start: Date,
  end: Date,
  options?: { includeEnd?: boolean },
) {
  const includeEnd = options?.includeEnd ?? true;
  if (end.getTime() < start.getTime() || (end.getTime() === start.getTime() && !includeEnd)) {
    return [];
  }

  const selectSql = `
    SELECT
      bpm,
      time,
      stress,
      spo2,
      COALESCE(
        skin_temp,
        CASE
          WHEN skin_temp_raw >= 100 THEN skin_temp_raw * 0.04
          ELSE NULL
        END
      ) AS skin_temp
    FROM heart_rate
  `;

  if (end.getTime() === start.getTime()) {
    const rows = await db.getAllAsync<HeartMetricSampleRow>(
      `
        ${selectSql}
        WHERE time = ?
        ORDER BY time ASC
      `,
      formatSqliteDateTime(start),
    );
    return rows.map(toHeartMetricSample);
  }

  const rows: HeartMetricSample[] = [];
  let chunkStartMs = start.getTime();

  while (chunkStartMs < end.getTime()) {
    const chunkEndMs = Math.min(chunkStartMs + HEART_ROW_QUERY_CHUNK_MS, end.getTime());
    const isFinalChunk = chunkEndMs >= end.getTime();
    const endComparator = isFinalChunk && includeEnd ? '<=' : '<';
    const chunkRows = await db.getAllAsync<HeartMetricSampleRow>(
      `
        ${selectSql}
        WHERE time >= ? AND time ${endComparator} ?
        ORDER BY time ASC
      `,
      formatSqliteDateTime(new Date(chunkStartMs)),
      formatSqliteDateTime(new Date(chunkEndMs)),
    );

    for (const row of chunkRows) {
      rows.push(toHeartMetricSample(row));
    }
    chunkStartMs = chunkEndMs;
  }

  return rows;
}

async function querySleepCycles(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<SleepCycleRow>(sql, ...args))
    .map(toSleepCycleRecord)
    .filter(isPlausibleSleepCycleRecord);
}

async function queryActivities(db: SQLiteDatabase, sql: string, args: Array<string | number> = []) {
  return (await db.getAllAsync<ActivityRow>(sql, ...args)).map(toActivityRecord);
}

async function loadHeartMetricRowsForDay(db: SQLiteDatabase, dayKey: string) {
  return queryHeartMetricRowsBetween(
    db,
    startOfDayFromDayKey(dayKey),
    nextDayFromDayKey(dayKey),
    { includeEnd: false },
  );
}

async function countHeartRowsBetweenRange(db: SQLiteDatabase, start: Date, end: Date) {
  const row = await db.getFirstAsync<{ count: number }>(
    `
      SELECT COUNT(*) AS count
      FROM heart_rate
      WHERE time >= ? AND time <= ?
    `,
    formatSqliteDateTime(start),
    formatSqliteDateTime(end),
  );

  return row?.count ?? 0;
}

async function loadManualSleepDraftSummary(db: SQLiteDatabase, start: Date, end: Date) {
  const row = await db.getFirstAsync<{
    sample_count: number;
    min_bpm: number | null;
    avg_bpm: number | null;
    max_bpm: number | null;
    avg_skin_temp: number | null;
  }>(
    `
      SELECT
        COUNT(*) AS sample_count,
        MIN(bpm) AS min_bpm,
        AVG(bpm) AS avg_bpm,
        MAX(bpm) AS max_bpm,
        AVG(
          COALESCE(
            skin_temp,
            CASE
              WHEN skin_temp_raw >= 100 THEN skin_temp_raw * 0.04
              ELSE NULL
            END
          )
        ) AS avg_skin_temp
      FROM heart_rate
      WHERE time >= ? AND time <= ?
        AND bpm BETWEEN ? AND ?
    `,
    formatSqliteDateTime(start),
    formatSqliteDateTime(end),
    MIN_PLAUSIBLE_RECORDED_BPM,
    MAX_PLAUSIBLE_RECORDED_BPM,
  );

  if (!row || row.sample_count === 0 || row.min_bpm === null || row.avg_bpm === null || row.max_bpm === null) {
    throw new Error(MANUAL_SLEEP_HEART_DATA_ERROR);
  }

  return {
    minBpm: row.min_bpm,
    maxBpm: row.max_bpm,
    avgBpm: Math.round(row.avg_bpm),
    minHrv: 0,
    maxHrv: 0,
    avgHrv: 0,
    avgSkinTemp: row.avg_skin_temp,
  };
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

async function loadHeartIntradayBucketStateRow(
  db: SQLiteDatabase,
  bucketSeconds = HEART_INTRADAY_BUCKET_SECONDS,
) {
  const row = await db.getFirstAsync<{
    source_row_count: number;
    source_last_sample_time: string | null;
    refreshed_at: string;
  }>(
    `
      SELECT source_row_count, source_last_sample_time, refreshed_at
      FROM intraday_metric_bucket_state
      WHERE metric_key = ? AND bucket_seconds = ?
      LIMIT 1
    `,
    HEART_INTRADAY_METRIC_KEY,
    bucketSeconds,
  );

  if (!row) {
    return null;
  }

  return {
    source_heart_count: row.source_row_count,
    source_last_heart_time: row.source_last_sample_time,
    refreshed_at: row.refreshed_at,
  } satisfies HeartIntradayBucketStateRow;
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

async function persistIntradayMetricBucketStateRow(
  db: Pick<SQLiteDatabase, 'runAsync'>,
  row: IntradayMetricBucketStateRow,
) {
  await db.runAsync(
    `
      INSERT INTO intraday_metric_bucket_state (
        metric_key,
        bucket_seconds,
        source_row_count,
        source_last_sample_time,
        refreshed_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(metric_key, bucket_seconds) DO UPDATE SET
        source_row_count = excluded.source_row_count,
        source_last_sample_time = excluded.source_last_sample_time,
        refreshed_at = excluded.refreshed_at
    `,
    row.metric_key,
    row.bucket_seconds,
    row.source_row_count,
    row.source_last_sample_time,
    row.refreshed_at,
  );
}

async function loadSleepFeatureBucketStateRow(
  db: SQLiteDatabase,
  bucketSeconds = SLEEP_FEATURE_BUCKET_SECONDS,
) {
  return db.getFirstAsync<SleepFeatureBucketStateRow>(
    `
      SELECT bucket_seconds, source_row_count, source_last_sample_time, refreshed_at
      FROM sleep_feature_bucket_state
      WHERE bucket_seconds = ?
      LIMIT 1
    `,
    bucketSeconds,
  );
}

async function persistSleepFeatureBucketStateRow(
  db: Pick<SQLiteDatabase, 'runAsync'>,
  row: SleepFeatureBucketStateRow,
) {
  await db.runAsync(
    `
      INSERT INTO sleep_feature_bucket_state (
        bucket_seconds,
        source_row_count,
        source_last_sample_time,
        refreshed_at
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bucket_seconds) DO UPDATE SET
        source_row_count = excluded.source_row_count,
        source_last_sample_time = excluded.source_last_sample_time,
        refreshed_at = excluded.refreshed_at
    `,
    row.bucket_seconds,
    row.source_row_count,
    row.source_last_sample_time,
    row.refreshed_at,
  );
}

function normalizeTimeRange(fromTime: string, toTime: string) {
  return fromTime <= toTime
    ? { fromTime, toTime }
    : { fromTime: toTime, toTime: fromTime };
}

function bucketSecondsFromMinutes(bucketMinutes: number) {
  return Math.max(Math.round(bucketMinutes * 60), 1);
}

function bucketStartForDateWithSeconds(date: Date, bucketSeconds: number) {
  const bucketMs = bucketSeconds * 1000;
  return formatSqliteDateTime(new Date(Math.floor(date.getTime() / bucketMs) * bucketMs));
}

function bucketStartForSqliteTime(value: string, bucketMinutes = DASHBOARD_HEART_BUCKET_MINUTES) {
  return bucketStartForDateWithSeconds(parseSqliteDateTime(value), bucketSecondsFromMinutes(bucketMinutes));
}

function bucketStartForSqliteTimeWithSeconds(value: string, bucketSeconds: number) {
  return bucketStartForDateWithSeconds(parseSqliteDateTime(value), bucketSeconds);
}

function bucketStartForDate(date: Date, bucketMinutes = DASHBOARD_HEART_BUCKET_MINUTES) {
  return bucketStartForDateWithSeconds(date, bucketSecondsFromMinutes(bucketMinutes));
}

function bucketEndExclusive(bucketStart: string, bucketMinutes = DASHBOARD_HEART_BUCKET_MINUTES) {
  return formatSqliteDateTime(addMinutes(parseSqliteDateTime(bucketStart), bucketMinutes));
}

function bucketEndExclusiveWithSeconds(bucketStart: string, bucketSeconds: number) {
  return formatSqliteDateTime(new Date(parseSqliteDateTime(bucketStart).getTime() + bucketSeconds * 1000));
}

function summarizeIntradayBucketRows(
  bucketStart: string,
  rows: readonly HeartRateSampleRow[],
): HeartIntradayBucketSummaryRow | null {
  const validRows = rows.filter((row) => sanitizeRecordedBpm(row.bpm) !== null);
  if (validRows.length === 0) {
    return null;
  }

  let total = 0;
  let minBpm = validRows[0]!.bpm;
  let maxBpm = validRows[0]!.bpm;
  let maxTripletAvg: number | null = null;

  for (let index = 0; index < validRows.length; index += 1) {
    const bpm = validRows[index].bpm;
    total += bpm;

    if (bpm < minBpm) {
      minBpm = bpm;
    }

    if (bpm > maxBpm) {
      maxBpm = bpm;
    }

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
    min_bpm: minBpm,
    max_bpm: maxBpm,
  };
}

function buildIntradayBucketRows(
  rows: readonly HeartRateSampleRow[],
  bucketSeconds = bucketSecondsFromMinutes(DASHBOARD_HEART_BUCKET_MINUTES),
) {
  const grouped = new Map<string, HeartRateSampleRow[]>();

  for (const row of rows) {
    const bucketStart = bucketStartForSqliteTimeWithSeconds(row.time, bucketSeconds);
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

function sleepFeatureGravityDelta(left: [number, number, number] | null, right: [number, number, number] | null) {
  if (!left || !right) {
    return null;
  }

  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function summarizeSleepFeatureBucket(
  bucketStart: string,
  rows: readonly HeartRateRecord[],
  bucketSeconds = SLEEP_FEATURE_BUCKET_SECONDS,
): SleepFeatureBucketRow | null {
  const validRows = rows.filter((row) => sanitizeRecordedBpm(row.bpm) !== null);
  if (validRows.length === 0) {
    return null;
  }

  const bpmSummary = summarizeHeartRows(validRows);
  if (!bpmSummary) {
    return null;
  }

  const ppgValues = validRows
    .map((row) => row.ppgGreen)
    .filter((value): value is number => value !== null);
  const gravityRows = validRows.filter((row) => row.gravity !== null);
  const motionValues: number[] = [];
  const skinContactValues = validRows
    .map((row) => row.skinContact)
    .filter((value): value is number => value !== null);
  const signalQualityValues = validRows
    .map((row) => row.signalQuality)
    .filter((value): value is number => value !== null);
  const skinTempValues = validRows
    .map((row) => resolvedSkinTemp(row))
    .filter((value): value is number => value !== null);
  const spo2Values = validRows
    .map((row) => row.spo2)
    .filter((value): value is number => value !== null);

  for (let index = 1; index < validRows.length; index += 1) {
    const delta = sleepFeatureGravityDelta(validRows[index - 1].gravity, validRows[index].gravity);
    if (delta !== null) {
      motionValues.push(delta);
    }
  }

  return {
    bucket_seconds: bucketSeconds,
    bucket_start: bucketStart,
    sample_count: validRows.length,
    min_bpm: bpmSummary.min,
    avg_bpm: bpmSummary.average,
    max_bpm: bpmSummary.max,
    rr_intervals: validRows.flatMap((row) => row.rr).filter((value) => value > 0).join(','),
    ppg_green_median: median(ppgValues),
    ppg_green_max: ppgValues.length === 0 ? null : Math.max(...ppgValues),
    awake_ppg_count: ppgValues.filter(isAwakePpgValue).length,
    saturated_ppg_count: ppgValues.filter((value) => value >= SLEEP_FEATURE_PPG_SATURATION_THRESHOLD).length,
    motion_score: motionValues.length === 0 ? null : mean(motionValues),
    gravity_x: gravityRows.length === 0 ? null : mean(gravityRows.map((row) => row.gravity![0])),
    gravity_y: gravityRows.length === 0 ? null : mean(gravityRows.map((row) => row.gravity![1])),
    gravity_z: gravityRows.length === 0 ? null : mean(gravityRows.map((row) => row.gravity![2])),
    skin_contact_count: skinContactValues.length,
    skin_contact_present_count: skinContactValues.filter((value) => value > 0).length,
    signal_quality_count: signalQualityValues.length,
    signal_quality_present_count: signalQualityValues.filter((value) => value > 0).length,
    avg_skin_temp: skinTempValues.length === 0 ? null : mean(skinTempValues),
    avg_spo2: spo2Values.length === 0 ? null : mean(spo2Values),
  };
}

function buildSleepFeatureBucketRows(
  rows: readonly HeartRateRecord[],
  bucketSeconds = SLEEP_FEATURE_BUCKET_SECONDS,
) {
  const grouped = new Map<string, HeartRateRecord[]>();

  for (const row of rows) {
    const bucketStart = bucketStartForSqliteTimeWithSeconds(row.time, bucketSeconds);
    const bucketRows = grouped.get(bucketStart);

    if (bucketRows) {
      bucketRows.push(row);
      continue;
    }

    grouped.set(bucketStart, [row]);
  }

  return [...grouped.entries()].flatMap(([bucketStart, bucketRows]) => {
    const summary = summarizeSleepFeatureBucket(bucketStart, bucketRows, bucketSeconds);
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

  return strainScoreFromTrimp(trimp);
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

function buildDerivedDetectionArtifacts(
  heartRows: HeartRateRecord[],
  personalization?: ActivityDetectorPersonalization,
) {
  const detectionArtifacts = detectActivityArtifacts(heartRows, personalization);
  const latestSourceSampleAt = latestHeartSampleDate(heartRows);
  const processedAt = new Date();
  const sleepCandidates = mergeNearbySleepPeriods(
    detectionArtifacts.sleepCandidates,
  ).filter((period) => period.durationMinutes >= MIN_SLEEP_DURATION_MINUTES);
  const { sleeps: primarySleepPeriods, naps: napPeriods } = selectSleepAndNapPeriods(sleepCandidates);
  const napActivities = buildNapActivities(napPeriods);
  const sleepCycles = scoreSleepCycles(
    primarySleepPeriods
      .map((period) => buildSleepCycle(
        period,
        heartRows,
        detectedSleepCompletionStatus(period, latestSourceSampleAt, processedAt),
      ))
      .filter((period): period is SleepCycleRecord => period !== null),
    napActivities,
  );
  const activities = [...napActivities, ...buildActivityRecords(detectionArtifacts.activityCandidates, sleepCycles)];
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
        INSERT INTO sleep_cycles (id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm, min_hrv, max_hrv, avg_hrv, avg_skin_temp, score, completion_status, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
      sleep.completionStatus,
    );
  }

  for (const activity of artifacts.activities) {
    await tx.runAsync(
      `
        INSERT OR IGNORE INTO activities (period_id, start, end, activity, synced, confidence, source, review_state)
        VALUES (?, ?, ?, ?, 0, ?, 'detected', 'none')
      `,
      activity.periodId,
      formatSqliteDateTime(activity.start),
      formatSqliteDateTime(activity.end),
      activity.activity,
      activity.confidence,
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
        AND (source IS NULL OR source = 'detected')
        AND (review_state IS NULL OR review_state = 'none')
    `,
    rangeEnd,
    rangeStart,
  );
  await tx.runAsync(
    `
      DELETE FROM activities
      WHERE start <= ? AND end >= ? AND source = 'detected' AND review_state = 'none'
    `,
    rangeEnd,
    rangeStart,
  );
  await insertDerivedArtifacts(tx, artifacts);
}

async function clearAllDerivedTables(tx: TransactionWriter) {
  await tx.execAsync(`
    DELETE FROM sleep_stage_segments
    WHERE sleep_id IN (
      SELECT sleep_id
      FROM sleep_cycles
      WHERE (source IS NULL OR source = 'detected')
        AND (review_state IS NULL OR review_state = 'none')
    );
    DELETE FROM sleep_cycles
    WHERE (source IS NULL OR source = 'detected')
      AND (review_state IS NULL OR review_state = 'none');
    DELETE FROM activities WHERE source = 'detected' AND review_state = 'none';
  `);
}

async function deleteUnconfirmedDetectedActivities(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ count: number }>(
    `
      SELECT COUNT(*) AS count
      FROM activities
      WHERE source = 'detected' AND review_state = 'none'
    `,
  );
  const removedCount = row?.count ?? 0;

  if (removedCount > 0) {
    await db.runAsync(
      `
        DELETE FROM activities
        WHERE source = 'detected' AND review_state = 'none'
      `,
    );
  }

  return removedCount;
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
      SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
      FROM sleep_cycles
      ORDER BY start DESC
      LIMIT ?
    `,
    [limit],
  );
  return rows.reverse();
}

async function loadDashboardDayKeys(db: SQLiteDatabase, limit: number) {
  const rows = await withAggregateReadLock(db, () =>
    db.getAllAsync<{ day: string }>(
      `
        SELECT day
        FROM heart_day_stats
        ORDER BY day DESC
        LIMIT ?
      `,
      limit,
    ),
  );

  return rows.reverse().map((row) => row.day);
}

async function loadHeartDayStatsThroughDay(db: SQLiteDatabase, dayKey: string, limit: number) {
  const rows = await withAggregateReadLock(db, () =>
    db.getAllAsync<HeartDayStatRow>(
      `
        SELECT day, min_bpm, avg_bpm, max_bpm, strain_score
        FROM heart_day_stats
        WHERE day <= ?
        ORDER BY day DESC
        LIMIT ?
      `,
      dayKey,
      limit,
    ),
  );

  return rows.reverse().map(toHeartDayStatRecord);
}

async function loadSleepCyclesThroughDay(db: SQLiteDatabase, dayKey: string, limit: number) {
  const nextDaySql = formatSqliteDateTime(nextDayFromDayKey(dayKey));
  const rows = await querySleepCycles(
    db,
    `
      SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
      FROM sleep_cycles
      WHERE end < ?
      ORDER BY end DESC
      LIMIT ?
    `,
    [nextDaySql, limit],
  );

  return rows.reverse();
}

async function loadSleepCycleForDay(db: SQLiteDatabase, dayKey: string) {
  const dayStartSql = formatSqliteDateTime(startOfDayFromDayKey(dayKey));
  const nextDaySql = formatSqliteDateTime(nextDayFromDayKey(dayKey));
  const rows = await querySleepCycles(
    db,
    `
      SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
      FROM sleep_cycles
      WHERE end >= ? AND end < ?
      ORDER BY end DESC
      LIMIT 1
    `,
    [dayStartSql, nextDaySql],
  );

  return rows[0] ?? null;
}

async function loadSleepCycleBySleepId(db: SQLiteDatabase, sleepId: string) {
  const rows = await querySleepCycles(
    db,
    `
      SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
      FROM sleep_cycles
      WHERE sleep_id = ?
      LIMIT 1
    `,
    [sleepId],
  );

  return rows[0] ?? null;
}

async function loadLatestHeartRowBefore(db: SQLiteDatabase, beforeExclusive: Date) {
  return db.getFirstAsync<{ time: string; stress: number | null }>(
    `
      SELECT time, stress
      FROM heart_rate
      WHERE time < ?
      ORDER BY time DESC
      LIMIT 1
    `,
    formatSqliteDateTime(beforeExclusive),
  );
}

async function loadLatestHeartTimeForDay(db: SQLiteDatabase, dayKey: string) {
  const dayStartSql = formatSqliteDateTime(startOfDayFromDayKey(dayKey));
  const nextDaySql = formatSqliteDateTime(nextDayFromDayKey(dayKey));
  const row = await db.getFirstAsync<{ time: string }>(
    `
      SELECT time
      FROM heart_rate
      WHERE time >= ? AND time < ?
      ORDER BY time DESC
      LIMIT 1
    `,
    dayStartSql,
    nextDaySql,
  );

  return row?.time ?? null;
}

async function loadActivitiesForDay(db: SQLiteDatabase, dayKey: string, limit: number) {
  const dayStartSql = formatSqliteDateTime(startOfDayFromDayKey(dayKey));
  const nextDaySql = formatSqliteDateTime(nextDayFromDayKey(dayKey));

  return queryActivities(
    db,
    `
      SELECT ${ACTIVITY_SELECT_COLUMNS}
      FROM activities
      WHERE start >= ? AND start < ? AND activity <> 'Nap' AND review_state <> 'dismissed'
      ORDER BY start DESC
      LIMIT ?
    `,
    [dayStartSql, nextDaySql, limit],
  );
}

async function loadHeartBucketRowsBetweenRange(
  db: SQLiteDatabase,
  start: Date,
  end: Date,
  bucketSeconds = HEART_INTRADAY_BUCKET_SECONDS,
) {
  const startBucket = bucketStartForDateWithSeconds(start, bucketSeconds);
  const endBucket = bucketStartForDateWithSeconds(end, bucketSeconds);

  return withAggregateReadLock(db, () => loadStoredHeartIntradayBucketRows(db, startBucket, endBucket, bucketSeconds));
}

async function loadStoredHeartIntradayBucketRows(
  db: Pick<SQLiteDatabase, 'getAllAsync'>,
  startBucket: string,
  endBucket: string,
  bucketSeconds = HEART_INTRADAY_BUCKET_SECONDS,
) {
  return db.getAllAsync<HeartIntradayBucketRow>(
    `
      SELECT
        buckets.bucket_start,
        buckets.sample_count,
        buckets.avg_value AS avg_bpm,
        buckets.first_value AS first_bpm,
        details.second_bpm,
        details.penultimate_bpm,
        buckets.last_value AS last_bpm,
        details.max_triplet_avg
      FROM intraday_metric_buckets AS buckets
      LEFT JOIN heart_intraday_bucket_details AS details
        ON details.bucket_seconds = buckets.bucket_seconds
       AND details.bucket_start = buckets.bucket_start
      WHERE buckets.metric_key = ?
        AND buckets.bucket_seconds = ?
        AND buckets.bucket_start >= ?
        AND buckets.bucket_start <= ?
      ORDER BY buckets.bucket_start ASC
    `,
    HEART_INTRADAY_METRIC_KEY,
    bucketSeconds,
    startBucket,
    endBucket,
  );
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

function toIntradayMetricBucketRow(
  bucket: HeartIntradayBucketSummaryRow,
  bucketSeconds: number,
): IntradayMetricBucketRow {
  return {
    metric_key: HEART_INTRADAY_METRIC_KEY,
    bucket_seconds: bucketSeconds,
    bucket_start: bucket.bucket_start,
    sample_count: bucket.sample_count,
    min_value: bucket.min_bpm,
    avg_value: bucket.avg_bpm,
    max_value: bucket.max_bpm,
    first_value: bucket.first_bpm,
    last_value: bucket.last_bpm,
  };
}

function toHeartIntradayBucketDetailRow(
  bucket: HeartIntradayBucketRow,
  bucketSeconds: number,
): HeartIntradayBucketDetailRow {
  return {
    bucket_seconds: bucketSeconds,
    bucket_start: bucket.bucket_start,
    second_bpm: bucket.second_bpm,
    penultimate_bpm: bucket.penultimate_bpm,
    max_triplet_avg: bucket.max_triplet_avg,
  };
}

async function replaceIntradayMetricBucketRange(
  db: SQLiteDatabase,
  bucketRangeStart: string,
  bucketRangeEnd: string,
  bucketSeconds: number,
  bucketRows: readonly IntradayMetricBucketRow[],
  options?: { replaceAll?: boolean },
) {
  await withExclusiveTransaction(db, async (tx) => {
    if (options?.replaceAll) {
      await tx.runAsync(
        'DELETE FROM intraday_metric_buckets WHERE metric_key = ? AND bucket_seconds = ?',
        HEART_INTRADAY_METRIC_KEY,
        bucketSeconds,
      );
    } else {
      await tx.runAsync(
        `
          DELETE FROM intraday_metric_buckets
          WHERE metric_key = ?
            AND bucket_seconds = ?
            AND bucket_start >= ?
            AND bucket_start <= ?
        `,
        HEART_INTRADAY_METRIC_KEY,
        bucketSeconds,
        bucketRangeStart,
        bucketRangeEnd,
      );
    }

    for (const bucket of bucketRows) {
      await tx.runAsync(
        `
          INSERT INTO intraday_metric_buckets (
            metric_key,
            bucket_seconds,
            bucket_start,
            sample_count,
            min_value,
            avg_value,
            max_value,
            first_value,
            last_value
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        bucket.metric_key,
        bucket.bucket_seconds,
        bucket.bucket_start,
        bucket.sample_count,
        bucket.min_value,
        bucket.avg_value,
        bucket.max_value,
        bucket.first_value,
        bucket.last_value,
      );
    }
  });
}

async function replaceHeartIntradayBucketDetailRange(
  db: SQLiteDatabase,
  bucketRangeStart: string,
  bucketRangeEnd: string,
  bucketSeconds: number,
  bucketRows: readonly HeartIntradayBucketDetailRow[],
  options?: { replaceAll?: boolean },
) {
  await withExclusiveTransaction(db, async (tx) => {
    if (options?.replaceAll) {
      await tx.runAsync(
        'DELETE FROM heart_intraday_bucket_details WHERE bucket_seconds = ?',
        bucketSeconds,
      );
    } else {
      await tx.runAsync(
        `
          DELETE FROM heart_intraday_bucket_details
          WHERE bucket_seconds = ?
            AND bucket_start >= ?
            AND bucket_start <= ?
        `,
        bucketSeconds,
        bucketRangeStart,
        bucketRangeEnd,
      );
    }

    for (const bucket of bucketRows) {
      await tx.runAsync(
        `
          INSERT INTO heart_intraday_bucket_details (
            bucket_seconds,
            bucket_start,
            second_bpm,
            penultimate_bpm,
            max_triplet_avg
          )
          VALUES (?, ?, ?, ?, ?)
        `,
        bucket.bucket_seconds,
        bucket.bucket_start,
        bucket.second_bpm,
        bucket.penultimate_bpm,
        bucket.max_triplet_avg,
      );
    }
  });
}

async function deleteSleepFeatureBucketRange(
  tx: TransactionWriter,
  bucketRangeStart: string,
  bucketRangeEnd: string,
  bucketSeconds: number,
  options?: { replaceAll?: boolean },
) {
  if (options?.replaceAll) {
    await tx.runAsync('DELETE FROM sleep_feature_buckets WHERE bucket_seconds = ?', bucketSeconds);
    return;
  }

  await tx.runAsync(
    `
      DELETE FROM sleep_feature_buckets
      WHERE bucket_seconds = ?
        AND bucket_start >= ?
        AND bucket_start <= ?
    `,
    bucketSeconds,
    bucketRangeStart,
    bucketRangeEnd,
  );
}

async function insertSleepFeatureBucketRows(
  tx: TransactionWriter,
  bucketRows: readonly SleepFeatureBucketRow[],
) {
  for (const bucket of bucketRows) {
    await tx.runAsync(
      `
        INSERT INTO sleep_feature_buckets (
          bucket_seconds,
          bucket_start,
          sample_count,
          min_bpm,
          avg_bpm,
          max_bpm,
          rr_intervals,
          ppg_green_median,
          ppg_green_max,
          awake_ppg_count,
          saturated_ppg_count,
          motion_score,
          gravity_x,
          gravity_y,
          gravity_z,
          skin_contact_count,
          skin_contact_present_count,
          signal_quality_count,
          signal_quality_present_count,
          avg_skin_temp,
          avg_spo2
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      bucket.bucket_seconds,
      bucket.bucket_start,
      bucket.sample_count,
      bucket.min_bpm,
      bucket.avg_bpm,
      bucket.max_bpm,
      bucket.rr_intervals,
      bucket.ppg_green_median,
      bucket.ppg_green_max,
      bucket.awake_ppg_count,
      bucket.saturated_ppg_count,
      bucket.motion_score,
      bucket.gravity_x,
      bucket.gravity_y,
      bucket.gravity_z,
      bucket.skin_contact_count,
      bucket.skin_contact_present_count,
      bucket.signal_quality_count,
      bucket.signal_quality_present_count,
      bucket.avg_skin_temp,
      bucket.avg_spo2,
    );
  }
}

async function loadSleepFeatureBucketRowsBetweenRange(
  db: SQLiteDatabase,
  start: Date,
  end: Date,
  bucketSeconds = SLEEP_FEATURE_BUCKET_SECONDS,
) {
  const startBucket = bucketStartForDateWithSeconds(start, bucketSeconds);
  const endBucket = bucketStartForDateWithSeconds(end, bucketSeconds);

  return withAggregateReadLock(db, () =>
    db.getAllAsync<SleepFeatureBucketRow>(
      `
        SELECT
          bucket_seconds,
          bucket_start,
          sample_count,
          min_bpm,
          avg_bpm,
          max_bpm,
          rr_intervals,
          ppg_green_median,
          ppg_green_max,
          awake_ppg_count,
          saturated_ppg_count,
          motion_score,
          gravity_x,
          gravity_y,
          gravity_z,
          skin_contact_count,
          skin_contact_present_count,
          signal_quality_count,
          signal_quality_present_count,
          avg_skin_temp,
          avg_spo2
        FROM sleep_feature_buckets
        WHERE bucket_seconds = ?
          AND bucket_start >= ?
          AND bucket_start <= ?
        ORDER BY bucket_start ASC
      `,
      bucketSeconds,
      startBucket,
      endBucket,
    ),
  );
}

async function refreshSleepFeatureBucketsForRange(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
  options?: { replaceAll?: boolean },
) {
  await withAggregateMutationLock(db, async () => {
    const heartCount = await countHeartRows(db);
    const previousState = await loadSleepFeatureBucketStateRow(db);

    if (heartCount === 0) {
      await withExclusiveTransaction(db, async (tx) => {
        await tx.execAsync(`
          DELETE FROM sleep_feature_buckets;
          DELETE FROM sleep_feature_bucket_state;
        `);
      });
      return;
    }

    const normalized = normalizeTimeRange(fromTime, toTime);
    const bucketRangeStart = bucketStartForSqliteTimeWithSeconds(normalized.fromTime, SLEEP_FEATURE_BUCKET_SECONDS);
    const bucketRangeEnd = bucketStartForSqliteTimeWithSeconds(normalized.toTime, SLEEP_FEATURE_BUCKET_SECONDS);
    const finalExclusiveMs = parseSqliteDateTime(
      bucketEndExclusiveWithSeconds(bucketRangeEnd, SLEEP_FEATURE_BUCKET_SECONDS),
    ).getTime();

    await withExclusiveTransaction(db, async (tx) => {
      await deleteSleepFeatureBucketRange(
        tx,
        bucketRangeStart,
        bucketRangeEnd,
        SLEEP_FEATURE_BUCKET_SECONDS,
        options,
      );
    });

    let chunkStartMs = parseSqliteDateTime(bucketRangeStart).getTime();
    while (chunkStartMs < finalExclusiveMs) {
      const chunkEndMs = Math.min(chunkStartMs + SLEEP_FEATURE_REFRESH_CHUNK_MS, finalExclusiveMs);
      const heartRows = await queryHeartRowsBetween(
        db,
        new Date(chunkStartMs),
        new Date(chunkEndMs),
        { includeEnd: false },
      );
      const bucketRows = buildSleepFeatureBucketRows(heartRows, SLEEP_FEATURE_BUCKET_SECONDS);

      if (bucketRows.length > 0) {
        await withExclusiveTransaction(db, async (tx) => {
          await insertSleepFeatureBucketRows(tx, bucketRows);
        });
      }

      chunkStartMs = chunkEndMs;
    }

    const latestHeart = await db.getFirstAsync<TimeRow>(
      `
        SELECT time
        FROM heart_rate
        ORDER BY time DESC
        LIMIT 1
      `,
    );
    if (options?.replaceAll || previousState) {
      await persistSleepFeatureBucketStateRow(db, {
        bucket_seconds: SLEEP_FEATURE_BUCKET_SECONDS,
        source_row_count: heartCount,
        source_last_sample_time: latestHeart?.time ?? null,
        refreshed_at: formatSqliteDateTime(new Date()),
      });
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
          DELETE FROM heart_intraday_bucket_state;
          DELETE FROM intraday_metric_buckets;
          DELETE FROM intraday_metric_bucket_state;
          DELETE FROM heart_intraday_bucket_details;
        `);
      });
      return;
    }

    const normalized = normalizeTimeRange(fromTime, toTime);
    for (const bucketSeconds of HEART_GRAPH_BUCKET_RESOLUTIONS_SECONDS) {
      const bucketRangeStart = bucketStartForSqliteTimeWithSeconds(normalized.fromTime, bucketSeconds);
      const bucketRangeEnd = bucketStartForSqliteTimeWithSeconds(normalized.toTime, bucketSeconds);
      const bucketRows = buildIntradayBucketRows(
        await queryHeartSampleRowsBetween(
          db,
          parseSqliteDateTime(bucketRangeStart),
          parseSqliteDateTime(bucketEndExclusiveWithSeconds(bucketRangeEnd, bucketSeconds)),
          { includeEnd: false },
        ),
        bucketSeconds,
      );

      await replaceIntradayMetricBucketRange(
        db,
        bucketRangeStart,
        bucketRangeEnd,
        bucketSeconds,
        bucketRows.map((bucket) => toIntradayMetricBucketRow(bucket, bucketSeconds)),
        options,
      );
      await replaceHeartIntradayBucketDetailRange(
        db,
        bucketRangeStart,
        bucketRangeEnd,
        bucketSeconds,
        bucketRows.map((bucket) => toHeartIntradayBucketDetailRow(bucket, bucketSeconds)),
        options,
      );
    }

    const latestHeart = await db.getFirstAsync<TimeRow>(
      `
        SELECT time
        FROM heart_rate
        ORDER BY time DESC
        LIMIT 1
      `,
    );
    for (const bucketSeconds of HEART_GRAPH_BUCKET_RESOLUTIONS_SECONDS) {
      await persistIntradayMetricBucketStateRow(db, {
        metric_key: HEART_INTRADAY_METRIC_KEY,
        bucket_seconds: bucketSeconds,
        source_row_count: heartCount,
        source_last_sample_time: latestHeart?.time ?? null,
        refreshed_at: formatSqliteDateTime(new Date()),
      });
    }
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
    const heartRows = await queryHeartSamplesBetween(
      db,
      dayStart,
      dayEndExclusive,
      { includeEnd: false },
    );

    const recentSleepCycles = completeSleepCycles(await loadRecentSleepCyclesForDashboard(db, 15));
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
  await refreshSleepFeatureBucketsForRange(db, fromTime, toTime);
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
  const metricRows = await queryHeartRowsBetween(
    db,
    parseSqliteDateTime(metricWindowStartTime),
    parseSqliteDateTime(normalized.toTime),
  );
  logMobilePerf('derived.range.queryMetrics', metricQueryStartedAt, {
    rows: metricRows.length,
  });

  const detectionQueryStartedAt = Date.now();
  const detectionRows = await queryHeartRowsBetween(
    db,
    detectionStart,
    detectionEnd,
  );
  logMobilePerf('derived.range.queryDetection', detectionQueryStartedAt, {
    rows: detectionRows.length,
  });

  const metricBuildStartedAt = Date.now();
  const metricUpdates = buildDerivedMetricMaps(metricRows);
  logMobilePerf('derived.range.buildMetrics', metricBuildStartedAt, {
    rows: metricRows.length,
  });

  const personalizationStartedAt = Date.now();
  const detectorPersonalization = await rebuildActivityDetectorPersonalization(db);
  logMobilePerf('derived.range.buildActivityPersonalization', personalizationStartedAt, {
    reviewedKinds: Object.keys(detectorPersonalization).length,
  });

  const artifactBuildStartedAt = Date.now();
  const artifacts = buildDerivedDetectionArtifacts(detectionRows, detectorPersonalization);
  logMobilePerf('derived.range.buildArtifacts', artifactBuildStartedAt, {
    rows: detectionRows.length,
    sleepCycles: artifacts.sleepCycles.length,
    activities: artifacts.activities.length,
    stages: artifacts.stages.length,
  });

  const reviewedActivityQueryStartedAt = Date.now();
  const reviewedActivityOverlaps = await loadReviewedActivityOverlapsRange(db, detectionStart, detectionEnd);
  const activityGuardedArtifacts = {
    ...artifacts,
    activities: applyReviewedActivityGuardrails(artifacts.activities, reviewedActivityOverlaps),
  };
  logMobilePerf('derived.range.applyActivityGuardrails', reviewedActivityQueryStartedAt, {
    reviewedOverlaps: reviewedActivityOverlaps.length,
    suppressedActivities: artifacts.activities.length - activityGuardedArtifacts.activities.length,
  });

  const preservedSleepQueryStartedAt = Date.now();
  const preservedSleepIds = await loadPreservedSleepIds(
    db,
    activityGuardedArtifacts.sleepCycles.map((sleep) => sleep.sleepId),
  );
  const guardedArtifacts = applyPreservedSleepGuardrails(activityGuardedArtifacts, preservedSleepIds);
  logMobilePerf('derived.range.applySleepGuardrails', preservedSleepQueryStartedAt, {
    preservedSleepIds: preservedSleepIds.length,
    suppressedSleepCycles: activityGuardedArtifacts.sleepCycles.length - guardedArtifacts.sleepCycles.length,
    suppressedSleepStages: activityGuardedArtifacts.stages.length - guardedArtifacts.stages.length,
  });

  const overlapQueryStartedAt = Date.now();
  const overlappingSleepRows = await db.getAllAsync<{ sleep_id: string }>(
    `
      SELECT sleep_id
      FROM sleep_cycles
      WHERE start <= ? AND end >= ?
        AND (source IS NULL OR source = 'detected')
        AND (review_state IS NULL OR review_state = 'none')
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
      guardedArtifacts,
    );
    logMobilePerf('derived.range.replaceArtifacts', artifactWriteStartedAt, {
      sleepCycles: guardedArtifacts.sleepCycles.length,
      activities: guardedArtifacts.activities.length,
      stages: guardedArtifacts.stages.length,
    });
  });

  const statsStartedAt = Date.now();
  await refreshSleepFeatureBucketsForRange(db, normalized.fromTime, normalized.toTime);
  logMobilePerf('derived.range.refreshSleepFeatures', statsStartedAt);
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

async function refreshDerivedDataRangeChunked(
  db: SQLiteDatabase,
  fromTime: string,
  toTime: string,
) {
  const normalized = normalizeTimeRange(fromTime, toTime);
  const rangeStartMs = parseSqliteDateTime(normalized.fromTime).getTime();
  const rangeEndMs = parseSqliteDateTime(normalized.toTime).getTime();

  if (rangeEndMs <= rangeStartMs) {
    await refreshDerivedDataRange(db, normalized.fromTime, normalized.toTime);
    return;
  }

  let chunkStartMs = rangeStartMs;
  while (chunkStartMs < rangeEndMs) {
    const chunkEndMs = Math.min(chunkStartMs + DERIVED_REFRESH_CHUNK_MS, rangeEndMs);
    await refreshDerivedDataRange(
      db,
      formatSqliteDateTime(new Date(chunkStartMs)),
      formatSqliteDateTime(new Date(chunkEndMs)),
    );

    if (chunkEndMs >= rangeEndMs) {
      break;
    }

    chunkStartMs = chunkEndMs;
  }
}

export async function refreshDerivedData(db: SQLiteDatabase) {
  const refreshStartedAt = Date.now();
  const [heartCount, bounds] = await Promise.all([
    countHeartRows(db),
    loadHeartTimeBounds(db),
  ]);
  const refreshedAt = formatSqliteDateTime(new Date());

  if (heartCount === 0 || !bounds?.min_time || !bounds.max_time) {
    await withExclusiveTransaction(db, async (tx) => {
      await clearAllDerivedTables(tx);
      await tx.execAsync(`
        DELETE FROM heart_day_stats;
        DELETE FROM heart_global_stats;
        DELETE FROM wellness_day_stats;
        DELETE FROM sleep_feature_buckets;
        DELETE FROM sleep_feature_bucket_state;
      `);
    });
    await persistDerivedDataStateRow(db, {
      derived_schema_version: DERIVED_DATA_SCHEMA_VERSION,
      source_heart_count: 0,
      refreshed_at: refreshedAt,
      rebuild_status: 'idle',
      pending_from_time: null,
      pending_to_time: null,
      last_processed_from_time: null,
      last_processed_to_time: null,
      last_error: null,
    });
    logMobilePerf('derived.full.empty', refreshStartedAt, {
      rows: heartCount,
    });
    return;
  }

  await withExclusiveTransaction(db, async (tx) => {
    await clearAllDerivedTables(tx);
    await tx.execAsync(`
      DELETE FROM heart_day_stats;
      DELETE FROM heart_global_stats;
      DELETE FROM wellness_day_stats;
      DELETE FROM sleep_feature_buckets;
      DELETE FROM sleep_feature_bucket_state;
    `);
  });

  await refreshDerivedDataRangeChunked(db, bounds.min_time, bounds.max_time);
  await persistSleepFeatureBucketStateRow(db, {
    bucket_seconds: SLEEP_FEATURE_BUCKET_SECONDS,
    source_row_count: heartCount,
    source_last_sample_time: bounds.max_time,
    refreshed_at: formatSqliteDateTime(new Date()),
  });

  await persistDerivedDataStateRow(db, {
    derived_schema_version: DERIVED_DATA_SCHEMA_VERSION,
    source_heart_count: heartCount,
    refreshed_at: refreshedAt,
    rebuild_status: 'idle',
    pending_from_time: null,
    pending_to_time: null,
    last_processed_from_time: bounds.min_time,
    last_processed_to_time: bounds.max_time,
    last_error: null,
  });
  logMobilePerf('derived.full.total', refreshStartedAt, {
    rows: heartCount,
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
      state.derived_schema_version !== DERIVED_DATA_SCHEMA_VERSION
    ) {
      const fullRefreshStartedAt = Date.now();
      await refreshDerivedData(db);
      logMobilePerf('derived.pending.fullRefresh', fullRefreshStartedAt, {
        heartCount,
      });
      return true;
    }

    if (state.pending_from_time === null && state.pending_to_time === null && state.source_heart_count !== heartCount) {
      const bounds = await loadHeartTimeBounds(db);
      const canProcessAppend =
        heartCount >= state.source_heart_count &&
        state.last_processed_to_time !== null &&
        bounds?.max_time !== null &&
        bounds?.max_time !== undefined &&
        bounds.max_time > state.last_processed_to_time;

      if (canProcessAppend && bounds?.max_time) {
        await persistDerivedDataStateRow(db, {
          rebuild_status: 'pending',
          pending_from_time: state.last_processed_to_time,
          pending_to_time: bounds.max_time,
          last_error: null,
        });
        continue;
      }

      const fullRefreshStartedAt = Date.now();
      await refreshDerivedData(db);
      logMobilePerf('derived.pending.countDriftFullRefresh', fullRefreshStartedAt, {
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
      await refreshDerivedDataRangeChunked(db, currentRange.fromTime, currentRange.toTime);
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
  const existing = dashboardAggregateEnsurePromises.get(db);
  if (existing) {
    await existing;
    return;
  }

  const next = (async () => {
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
  })();

  dashboardAggregateEnsurePromises.set(db, next);
  try {
    await next;
  } finally {
    if (dashboardAggregateEnsurePromises.get(db) === next) {
      dashboardAggregateEnsurePromises.delete(db);
    }
  }
}

async function ensureHeartIntradayBucketsReady(db: SQLiteDatabase) {
  const existing = heartIntradayEnsurePromises.get(db);
  if (existing) {
    await existing;
    return;
  }

  const next = (async () => {
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
    const states = await withAggregateReadLock(db, () =>
      Promise.all(
        HEART_GRAPH_BUCKET_RESOLUTIONS_SECONDS.map((bucketSeconds) =>
          loadHeartIntradayBucketStateRow(db, bucketSeconds),
        ),
      ),
    );

    if (
      states.every(
        (state) =>
          state &&
          state.source_heart_count === heartCount &&
          state.source_last_heart_time === (latestHeart?.time ?? null),
      )
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
  })();

  heartIntradayEnsurePromises.set(db, next);
  try {
    await next;
  } finally {
    if (heartIntradayEnsurePromises.get(db) === next) {
      heartIntradayEnsurePromises.delete(db);
    }
  }
}

async function ensureSleepFeatureBucketsReady(db: SQLiteDatabase) {
  const existing = sleepFeatureEnsurePromises.get(db);
  if (existing) {
    await existing;
    return;
  }

  const next = (async () => {
    const ensureStartedAt = Date.now();
    await waitForAggregateMutations(db);
    const heartCount = await countHeartRows(db);

    if (heartCount === 0) {
      logMobilePerf('sleepFeatures.ensure.empty', ensureStartedAt, {
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
    const state = await withAggregateReadLock(db, () => loadSleepFeatureBucketStateRow(db));

    if (
      state &&
      state.source_row_count === heartCount &&
      state.source_last_sample_time === (latestHeart?.time ?? null)
    ) {
      logMobilePerf('sleepFeatures.ensure.hit', ensureStartedAt, {
        heartCount,
      });
      return;
    }

    const bounds = await loadHeartTimeBounds(db);
    if (bounds?.min_time && bounds.max_time) {
      await refreshSleepFeatureBucketsForRange(db, bounds.min_time, bounds.max_time, {
        replaceAll: true,
      });
    }

    logMobilePerf('sleepFeatures.ensure.rebuild', ensureStartedAt, {
      heartCount,
    });
  })();

  sleepFeatureEnsurePromises.set(db, next);
  try {
    await next;
  } finally {
    if (sleepFeatureEnsurePromises.get(db) === next) {
      sleepFeatureEnsurePromises.delete(db);
    }
  }
}

async function ensureSleepFeatureBucketsForRange(db: SQLiteDatabase, start: Date, end: Date) {
  const existingRows = await loadSleepFeatureBucketRowsBetweenRange(db, start, end);
  if (existingRows.some((row) => row.sample_count > 0)) {
    return existingRows;
  }

  const heartCount = await countHeartRowsBetweenRange(db, start, end);
  if (heartCount === 0) {
    throw new Error(MANUAL_SLEEP_HEART_DATA_ERROR);
  }

  await refreshSleepFeatureBucketsForRange(db, formatSqliteDateTime(start), formatSqliteDateTime(end));
  return loadSleepFeatureBucketRowsBetweenRange(db, start, end);
}

async function ensureWellnessDayStatsReady(db: SQLiteDatabase) {
  const existing = wellnessDayEnsurePromises.get(db);
  if (existing) {
    await existing;
    return;
  }

  const next = (async () => {
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
  })();

  wellnessDayEnsurePromises.set(db, next);
  try {
    await next;
  } finally {
    if (wellnessDayEnsurePromises.get(db) === next) {
      wellnessDayEnsurePromises.delete(db);
    }
  }
}

async function loadDashboardIntradayRows(
  db: SQLiteDatabase,
  latestHeartTime: string | null,
  options?: { ensureBuckets?: boolean },
) {
  return loadIntradayHeartWindow(db, latestHeartTime, {
    ...options,
    windowHours: TODAY_HEART_WINDOW_HOURS,
  });
}

async function loadIntradayHeartWindow(
  db: SQLiteDatabase,
  latestHeartTime: string | null,
  options?: { bucketSeconds?: number; ensureBuckets?: boolean; useStoredBuckets?: boolean; windowHours?: number },
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
  const bucketSeconds = options?.bucketSeconds ?? HEART_INTRADAY_BUCKET_SECONDS;
  const windowHours = options?.windowHours ?? 24;
  const intradayStart = new Date(latestHeartDate.getTime() - windowHours * 3600000);
  const firstBucketStart = bucketStartForDateWithSeconds(intradayStart, bucketSeconds);
  const lastBucketStart = bucketStartForSqliteTimeWithSeconds(latestHeartTime, bucketSeconds);

  const loadRawWindow = async () => {
    const rawRows = await queryHeartSampleRowsBetween(db, intradayStart, latestHeartDate);
    const bucketRows = buildIntradayBucketRows(rawRows);
    const rawWindow = summarizeBucketWindow(bucketRows);

    return {
      latestHeartDate,
      intradayStart,
      rawRowCount: rawWindow.rawRowCount,
      bucketSamples: rawWindow.bucketSamples,
      averageBpm: rawWindow.averageBpm,
      sustainedPeakBpm: rawWindow.sustainedPeakBpm,
    } satisfies BucketedHeartWindow;
  };

  if (options?.useStoredBuckets === false) {
    return loadRawWindow();
  }

  if (options?.ensureBuckets !== false) {
    await ensureHeartIntradayBucketsReady(db);
  }

  const storedBuckets =
    firstBucketStart > lastBucketStart
      ? []
      : await withAggregateReadLock(db, () =>
          loadStoredHeartIntradayBucketRows(db, firstBucketStart, lastBucketStart, bucketSeconds),
        );

  if (options?.ensureBuckets === false && storedBuckets.length === 0 && firstBucketStart <= lastBucketStart) {
    return loadRawWindow();
  }

  const summarizedWindow = summarizeBucketWindow(storedBuckets);

  return {
    latestHeartDate,
    intradayStart,
    rawRowCount: summarizedWindow.rawRowCount,
    bucketSamples: summarizedWindow.bucketSamples,
    averageBpm: summarizedWindow.averageBpm,
    sustainedPeakBpm: summarizedWindow.sustainedPeakBpm,
  };
}

async function loadRawHeartWindow(
  db: SQLiteDatabase,
  latestHeartTime: string | null,
  windowHours: number,
): Promise<RawHeartWindow> {
  if (!latestHeartTime) {
    return {
      latestHeartDate: null,
      intradayStart: null,
      rawRowCount: 0,
      samples: [],
      averageHr: null,
      maxHr: null,
    };
  }

  const latestHeartDate = parseSqliteDateTime(latestHeartTime);
  const intradayStart = new Date(latestHeartDate.getTime() - windowHours * 3600000);
  const samples = await queryHeartSamplesBetween(db, intradayStart, latestHeartDate);
  const summary = summarizeHeartRows(samples);

  return {
    latestHeartDate,
    intradayStart,
    rawRowCount: samples.length,
    samples,
    averageHr: summary ? Math.round(summary.average) : null,
    maxHr: sustainedPeakBpm(filterPlausibleRecordedBpms(samples.map((sample) => sample.bpm))),
  };
}

async function loadLatestDashboardHeartCard(
  db: SQLiteDatabase,
  latestHeartTime: string | null,
  sleepCycles: readonly SleepCycleRecord[],
) {
  const heartWindow = await loadDashboardIntradayRows(db, latestHeartTime);

  if (!heartWindow.intradayStart || !heartWindow.latestHeartDate) {
    return {
      heartWindow,
      heartCardSeries: [],
      heartCardMarkers: [],
    };
  }

  const heartMarkerActivities = await loadActivitiesOverlappingRange(
    db,
    heartWindow.intradayStart,
    heartWindow.latestHeartDate,
  );
  const heartMarkerSleepDetails = await loadHeartMarkerSleepDetails(db, sleepCycles);

  return {
    heartWindow,
    heartCardSeries:
      heartWindow.bucketSamples.length > 0
        ? createTimeBuckets(
            heartWindow.bucketSamples,
            DASHBOARD_HEART_BUCKET_MINUTES,
            heartWindow.intradayStart,
            heartWindow.latestHeartDate,
          )
        : [],
    heartCardMarkers: buildHeartIntradayMarkers(
      heartWindow.intradayStart,
      heartWindow.latestHeartDate,
      sleepCycles,
      heartMarkerActivities,
      heartMarkerSleepDetails,
    ),
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

function buildDashboardSleepCard(latestSleep: SleepCycleRecord | null, stageRecords: SleepStageRecord[]): SleepCardData {
  if (!latestSleep) {
    return {
      score: null,
      durationMinutes: null,
      timeInBedMinutes: null,
      stages: [],
      startLabel: '--',
      middleLabel: '--',
      endLabel: '--',
      completionStatus: 'complete',
      isInProgress: false,
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
    completionStatus: latestSleep.completionStatus,
    isInProgress: latestSleep.isInProgress,
    isEstimated: stageRecords.some((stage) => stage.isEstimated),
    missingReason: stageRecords.length === 0 ? LIMITED_SENSOR_REASON : null,
  };
}

async function buildTodayOverview(db: SQLiteDatabase): Promise<TodayOverview> {
  const buildStartedAt = Date.now();
  const now = new Date();
  await ensureDashboardAggregatesReady(db);

  const [heartCount, heartState, heartDayStats, sleepCycles, deviceState] = await Promise.all([
    countHeartRows(db),
    loadLatestHeartState(db),
    withAggregateReadLock(db, () => loadRecentHeartDayStats(db, 14)),
    loadRecentSleepCyclesForDashboard(db, 15),
    loadLatestDeviceStateRow(db),
  ]);

  if (heartCount === 0) {
    logMobilePerf('today.overview.total', buildStartedAt, {
      heartCount,
    });
    return buildEmptyTodayOverview(now, deviceState);
  }

  const rawLatestSleep = sleepCycles.at(-1) ?? null;
  const [allSleepStageRecords, scoreNapActivities] = await Promise.all([
    loadSleepStageRecordsForIds(db, sleepCycles.map((sleep) => sleep.sleepId)),
    loadNapActivitiesForSleepScoreRange(db, sleepCycles),
  ]);
  const sleepSummaryById = buildSleepStageSummaryMap(sleepCycles, allSleepStageRecords);
  const rescoredSleepCycles = rescoreSleepCyclesWithSummaries(sleepCycles, sleepSummaryById, scoreNapActivities);
  const latestSleep = rawLatestSleep
    ? rescoredSleepCycles.find((sleep) => sleep.sleepId === rawLatestSleep.sleepId) ?? rawLatestSleep
    : null;
  const completeRescoredSleepCycles = completeSleepCycles(rescoredSleepCycles);
  const latestCompleteSleep = completeRescoredSleepCycles.at(-1) ?? null;
  const [sleepPreferences, napActivities] = await Promise.all([
    loadSleepPreferences(db, completeRescoredSleepCycles),
    latestCompleteSleep
      ? queryActivities(
          db,
          `
            SELECT ${ACTIVITY_SELECT_COLUMNS}
            FROM activities
            WHERE activity = 'Nap' AND start >= ? AND review_state <> 'dismissed'
            ORDER BY start ASC
          `,
          [formatSqliteDateTime(latestCompleteSleep.end)],
        )
      : Promise.resolve([]),
  ]);

  const latestHeartDate = heartState.latest_heart_time ? parseSqliteDateTime(heartState.latest_heart_time) : now;
  const selectedDayKey = dateKey(latestHeartDate);
  const selectedDayStart = startOfDayFromDayKey(selectedDayKey);
  const selectedDayEnd = endOfDashboardDayWindow(selectedDayKey, true, latestHeartDate);
  const [selectedDayHeartRows, selectedSleepFeatureRows, stageRecords] = await Promise.all([
    loadHeartMetricRowsForDay(db, selectedDayKey),
    latestCompleteSleep ? ensureSleepFeatureBucketsForRange(db, latestCompleteSleep.start, latestCompleteSleep.end) : Promise.resolve([]),
    Promise.resolve(
      latestSleep
        ? allSleepStageRecords.filter((stage) => stage.sleepId === latestSleep.sleepId)
        : [],
    ),
  ]);

  const dailyMinima = heartDayStats.map((stat) => stat.minBpm);
  const restingHr = personalizeRestingHr(completeRescoredSleepCycles, dailyMinima);
  const maxHr = personalizeMaxHrFromObservedPeak(heartState.observed_peak_bpm, restingHr);
  const recovery = estimateRecoveryScoreFromSleeps(latestCompleteSleep, completeRescoredSleepCycles, heartState.latest_stress);
  const tonightPlan = buildSleepPlan(sleepPreferences, completeRescoredSleepCycles, napActivities);
  const sleepCard = buildDashboardSleepCard(latestSleep, stageRecords);
  const dayStatsByDay = new Map(heartDayStats.map((stat) => [stat.day, stat]));
  const todayStrain = dayStatsByDay.get(selectedDayKey)?.strainScore ?? null;
  const strainSeries = buildCumulativeStrainSeries(
    selectedDayHeartRows,
    selectedDayStart,
    selectedDayEnd,
    DASHBOARD_HEART_BUCKET_MINUTES,
    maxHr,
    restingHr,
  );
  const resolvedStrain = trendValues(strainSeries).at(-1) ?? todayStrain;
  const strainMissingReason =
    trendValues(strainSeries).length === 0
      ? selectedDayHeartRows.length > 0
        ? LIMITED_LOAD_REASON
        : NO_HISTORY_REASON
      : null;
  const supplement = await buildDashboardSupplement({
    db,
    selectedDayKey,
    heartDayStats,
    sleepCycles: completeRescoredSleepCycles,
    selectedSleep: latestCompleteSleep,
    latestStress: heartState.latest_stress,
    restingHr,
    maxHr,
    selectedDayHeartRows,
    selectedSleepFeatureRows,
  });

  const overview = {
    greeting: supplement.day.isToday ? greetingForHour(now.getHours()) : 'Overview',
    dateLabel: formatLongDate(latestHeartDate),
    day: supplement.day,
    recovery: {
      score: recovery.score,
      label: describeRecovery(recovery.score),
      caption: 'Recovery',
      isEstimated: true,
      missingReason: recovery.missingReason,
      breakdown: recovery.breakdown,
    },
    tonightPlan,
    sleepCard,
    strainCard: {
      score: resolvedStrain,
      label:
        resolvedStrain === null
          ? 'Waiting for effort'
          : resolvedStrain >= 14
            ? 'Loaded'
            : resolvedStrain >= 8
              ? 'Building'
              : 'Light',
      series: strainSeries,
      isEstimated: true,
      missingReason: strainMissingReason,
    },
    activitySummary: supplement.activitySummary,
    insights: supplement.insights,
  } satisfies TodayOverview;

  logMobilePerf('today.overview.total', buildStartedAt, {
    activities: overview.activitySummary.length,
    day: overview.day.dayKey,
    insights: overview.insights.length,
    heartCount,
  });

  return overview;
}

export async function clearDashboardAggregatesForDebug(db: SQLiteDatabase) {
  await withExclusiveTransaction(db, async (tx) => {
    await tx.execAsync(`
      DELETE FROM heart_day_stats;
      DELETE FROM heart_global_stats;
      DELETE FROM heart_intraday_bucket_state;
      DELETE FROM intraday_metric_buckets;
      DELETE FROM intraday_metric_bucket_state;
      DELETE FROM heart_intraday_bucket_details;
      DELETE FROM sleep_feature_buckets;
      DELETE FROM sleep_feature_bucket_state;
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
  await refreshSleepFeatureBucketsForRange(db, bounds.min_time, bounds.max_time, {
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

export class SQLiteHealthRepository implements HealthRepository {
  private preparePromise: Promise<void> | null = null;
  private mutationPromise: Promise<void> | null = null;

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

  private readSnapshot<T>(_key: string, loader: () => Promise<T>) {
    return loader();
  }

  private readQuery<T>(_key: string, loader: () => Promise<T>) {
    return loader();
  }

  async getDashboardHeartTimelineWindow(range: HistoryRange): Promise<HeartTimelineWindow> {
    return this.readSnapshot(`heart:dashboard:window:${range}`, async () => {
      const startedAt = Date.now();

      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();
        await waitForAggregateMutations(this.db);

        const [latestHeartDate, dailyMinimaRows, sleepCycles] = await Promise.all([
          this.loadLatestHeartDate(),
          this.loadDailyHeartMinima(),
          this.loadRecentSleepCycles(Math.max(rangeDays(range), 14)),
        ]);

        if (!latestHeartDate || dailyMinimaRows.length === 0) {
          logMobilePerf('repository.getDashboardHeartTimelineWindow.empty', startedAt, {
            range,
          });
          return {
            restingHr: null,
            averageHr: null,
            maxHr: null,
            latestHeartDate: null,
            intradayStart: null,
            samples: [],
            markers: [],
            missingReason: NO_HISTORY_REASON,
          } satisfies HeartTimelineWindow;
        }

        const windowHours = rangeDays(range) * 24;
        const intradayWindowStart = new Date(latestHeartDate.getTime() - windowHours * 3600000);
        const latestHeartTime = formatSqliteDateTime(latestHeartDate);
        const windowStartedAt = Date.now();

        const bucketWindow = await loadIntradayHeartWindow(this.db, latestHeartTime, {
          bucketSeconds: HEART_INTRADAY_BUCKET_SECONDS,
          windowHours,
        });
        const rawWindow = {
          latestHeartDate: bucketWindow.latestHeartDate,
          intradayStart: bucketWindow.intradayStart,
          rawRowCount: bucketWindow.rawRowCount,
          samples: bucketWindow.bucketSamples,
          averageHr: bucketWindow.averageBpm,
          maxHr: bucketWindow.sustainedPeakBpm,
        } satisfies RawHeartWindow;

        logMobilePerf('repository.getDashboardHeartTimelineWindow.window', windowStartedAt, {
          range,
          rows: rawWindow.rawRowCount,
        });

        const heartMarkerSleepDetails = await loadHeartMarkerSleepDetails(this.db, sleepCycles);
        const intradayMarkers = buildHeartIntradayMarkers(
          intradayWindowStart,
          latestHeartDate,
          sleepCycles,
          await this.loadActivitiesOverlapping(intradayWindowStart, latestHeartDate),
          heartMarkerSleepDetails,
        );
        const sanitizedDailyMinimaRows = dailyMinimaRows.map((row) => ({
          day: row.day,
          min_bpm: sanitizeRecordedBpm(row.min_bpm),
        }));
        const dailyMinima = sanitizedDailyMinimaRows
          .map((row) => row.min_bpm)
          .filter((value): value is number => value !== null);
        const restingHr = personalizeRestingHr(completeSleepCycles(sleepCycles), dailyMinima);

        const snapshot = {
          restingHr,
          averageHr: rawWindow.averageHr,
          maxHr: rawWindow.maxHr,
          latestHeartDate: rawWindow.latestHeartDate,
          intradayStart: rawWindow.intradayStart,
          samples: rawWindow.samples,
          markers: intradayMarkers,
          missingReason: rawWindow.samples.length === 0 ? NO_HISTORY_REASON : null,
        } satisfies HeartTimelineWindow;

        logMobilePerf('repository.getDashboardHeartTimelineWindow', startedAt, {
          range,
          rows: snapshot.samples.length,
        });

        return snapshot;
      } catch (error) {
        logMobilePerfError('repository.getDashboardHeartTimelineWindow', error, {
          range,
        });
        throw error;
      }
    });
  }

  async getTodayOverview(): Promise<TodayOverview> {
    return this.readSnapshot('dashboard:todayOverview', async () => {
      const startedAt = Date.now();

      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();
        await waitForAggregateMutations(this.db);

        const overview = await buildTodayOverview(this.db);
        logMobilePerf('repository.getTodayOverview', startedAt, {
          activities: overview.activitySummary.length,
          day: overview.day.dayKey,
          insights: overview.insights.length,
        });

        return overview;
      } catch (error) {
        logMobilePerfError('repository.getTodayOverview', error);
        throw error;
      }
    });
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
          await processPendingDerivedRefresh(this.db);
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

  async processPendingDerivedRefresh(): Promise<boolean> {
    return this.runRepositoryMutation(async () => {
      const processed = await processPendingDerivedRefresh(this.db);

      return processed;
    });
  }

  async rescanActivities(): Promise<ActivityRescanResult> {
    return this.runRepositoryMutation(async () => {
      const removedUnconfirmedActivities = await deleteUnconfirmedDetectedActivities(this.db);

      await refreshDerivedData(this.db);

      return {
        removedUnconfirmedActivities,
      };
    });
  }

  async createManualActivity(activity: ManualActivityKind, start: Date, end: Date): Promise<string> {
    if (!MANUAL_ACTIVITY_KINDS.has(activity)) {
      throw new Error(`Unsupported manual activity kind: ${activity}`);
    }

    if (end.getTime() <= start.getTime()) {
      throw new Error('Manual activity end must be after start.');
    }

    return this.runRepositoryMutation(async () => {
      const startSql = formatSqliteDateTime(start);
      const endSql = formatSqliteDateTime(end);

      await this.db.runAsync(
        `
          INSERT INTO activities (period_id, start, end, activity, synced, source, review_state)
          VALUES (?, ?, ?, ?, 0, 'manual', 'confirmed')
          ON CONFLICT(start) DO UPDATE SET
            period_id = excluded.period_id,
            end = excluded.end,
            activity = excluded.activity,
            synced = 0,
            source = 'manual',
            review_state = 'confirmed'
        `,
        dateKey(end),
        startSql,
        endSql,
        activity,
      );

      const row = await this.db.getFirstAsync<{ id: number }>(
        `
          SELECT id
          FROM activities
          WHERE start = ?
          LIMIT 1
        `,
        startSql,
      );

      await rebuildActivityDetectorPersonalization(this.db);

      return row ? `manual-${row.id}` : `manual-${startSql}`;
    });
  }

  async createManualSleep(start: Date, end: Date): Promise<string> {
    validateManualSleepWindow(start, end);

    return this.runRepositoryMutation(async () => {
      const sleepId = dateKey(end);
      const existing = await loadSleepCycleBySleepId(this.db, sleepId);
      if (existing) {
        throw new Error(MANUAL_SLEEP_CONFLICT_ERROR);
      }

      const [draftSummary, priorSleeps] = await Promise.all([
        loadManualSleepDraftSummary(this.db, start, end),
        querySleepCycles(
          this.db,
          `
            SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
            FROM sleep_cycles
            ORDER BY end ASC
          `,
        ),
      ]);
      const sleep = buildManualSleepDraftRecord({
        id: sleepId,
        priorSleeps,
        sleepId,
        start,
        end,
        summary: draftSummary,
      });
      const stages = buildPlaceholderSleepStageRows(sleepId, start, end);

      await withExclusiveTransaction(this.db, async (tx) => {
        await tx.runAsync(
          `
            INSERT INTO sleep_cycles (
              id, sleep_id, start, end, min_bpm, max_bpm, avg_bpm,
              min_hrv, max_hrv, avg_hrv, avg_skin_temp, score, completion_status, synced, source, review_state
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 0, 'manual', 'confirmed')
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

        await insertSleepStageRecords(tx, stages);
      });

      scheduleManualSleepArtifactRefresh(this.db, {
        id: sleep.id,
        sleepId,
        start,
        end,
      });

      return `sleep-${sleepId}`;
    });
  }

  async updateActivity(activityId: string, activity: ManualActivityKind, start: Date, end: Date): Promise<void> {
    if (!MANUAL_ACTIVITY_KINDS.has(activity)) {
      throw new Error(`Unsupported manual activity kind: ${activity}`);
    }

    if (end.getTime() <= start.getTime()) {
      throw new Error('Manual activity end must be after start.');
    }

    const databaseId = parseActivityDatabaseId(activityId);
    if (databaseId === null) {
      throw new Error(`Unknown activity id: ${activityId}`);
    }

    await this.runRepositoryMutation(async () => {
      await this.db.runAsync(
        `
          UPDATE activities
          SET period_id = ?, start = ?, end = ?, activity = ?, source = 'manual', review_state = 'confirmed', synced = 0
          WHERE id = ?
        `,
        dateKey(end),
        formatSqliteDateTime(start),
        formatSqliteDateTime(end),
        activity,
        databaseId,
      );

      await rebuildActivityDetectorPersonalization(this.db);
    });
  }

  async updateSleep(sleepMarkerId: string, start: Date, end: Date): Promise<void> {
    validateManualSleepWindow(start, end);

    const currentSleepId = parseSleepMarkerId(sleepMarkerId);
    if (!currentSleepId) {
      throw new Error(`Unknown sleep id: ${sleepMarkerId}`);
    }

    await this.runRepositoryMutation(async () => {
      const existing = await loadSleepCycleBySleepId(this.db, currentSleepId);
      if (!existing) {
        throw new Error(`Sleep not found: ${sleepMarkerId}`);
      }

      const nextSleepId = dateKey(end);
      if (nextSleepId !== currentSleepId) {
        const conflictingSleep = await loadSleepCycleBySleepId(this.db, nextSleepId);
        if (conflictingSleep) {
          throw new Error(MANUAL_SLEEP_CONFLICT_ERROR);
        }
      }

      const [draftSummary, priorSleeps] = await Promise.all([
        loadManualSleepDraftSummary(this.db, start, end),
        querySleepCycles(
          this.db,
          `
            SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
            FROM sleep_cycles
            ORDER BY end ASC
          `,
        ),
      ]);
      const sleep = buildManualSleepDraftRecord({
        id: existing.id,
        priorSleeps: priorSleeps.filter((candidate) => candidate.sleepId !== currentSleepId),
        sleepId: nextSleepId,
        start,
        end,
        summary: draftSummary,
      });
      const stages = buildPlaceholderSleepStageRows(nextSleepId, start, end);

      await withExclusiveTransaction(this.db, async (tx) => {
        await tx.runAsync(
          `
            DELETE FROM sleep_stage_segments
            WHERE sleep_id = ?
          `,
          currentSleepId,
        );

        await tx.runAsync(
          `
            UPDATE sleep_cycles
            SET sleep_id = ?,
                start = ?,
                end = ?,
                min_bpm = ?,
                max_bpm = ?,
                avg_bpm = ?,
                min_hrv = ?,
                max_hrv = ?,
                avg_hrv = ?,
                avg_skin_temp = ?,
                score = ?,
                completion_status = 'complete',
                synced = 0,
                source = 'manual',
                review_state = 'confirmed'
            WHERE sleep_id = ?
          `,
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
          currentSleepId,
        );

        await insertSleepStageRecords(tx, stages);
      });

      scheduleManualSleepArtifactRefresh(this.db, {
        id: sleep.id,
        sleepId: nextSleepId,
        start,
        end,
      });
    });
  }

  async confirmActivity(activityId: string): Promise<void> {
    const databaseId = parseActivityDatabaseId(activityId);
    if (databaseId === null) {
      throw new Error(`Unknown activity id: ${activityId}`);
    }

    await this.runRepositoryMutation(async () => {
      await this.db.runAsync(
        `
          UPDATE activities
          SET review_state = 'confirmed', synced = 0
          WHERE id = ?
        `,
        databaseId,
      );

      await rebuildActivityDetectorPersonalization(this.db);
    });
  }

  async dismissActivity(activityId: string): Promise<void> {
    const databaseId = parseActivityDatabaseId(activityId);
    if (databaseId === null) {
      throw new Error(`Unknown activity id: ${activityId}`);
    }

    await this.runRepositoryMutation(async () => {
      await this.db.runAsync(
        `
          UPDATE activities
          SET review_state = 'dismissed', synced = 0
          WHERE id = ?
        `,
        databaseId,
      );

      await rebuildActivityDetectorPersonalization(this.db);
    });
  }

  async relabelActivity(activityId: string, activity: ManualActivityKind): Promise<void> {
    if (!MANUAL_ACTIVITY_KINDS.has(activity)) {
      throw new Error(`Unsupported manual activity kind: ${activity}`);
    }

    const databaseId = parseActivityDatabaseId(activityId);
    if (databaseId === null) {
      throw new Error(`Unknown activity id: ${activityId}`);
    }

    await this.runRepositoryMutation(async () => {
      const row = await this.db.getFirstAsync<{ source: string | null }>(
        `
          SELECT source
          FROM activities
          WHERE id = ?
          LIMIT 1
        `,
        databaseId,
      );

      if (!row) {
        throw new Error(`Activity not found: ${activityId}`);
      }

      await this.db.runAsync(
        `
          UPDATE activities
          SET activity = ?, review_state = ?, synced = 0
          WHERE id = ?
        `,
        activity,
        row.source === 'manual' ? 'confirmed' : 'relabelled',
        databaseId,
      );

      await rebuildActivityDetectorPersonalization(this.db);
    });
  }

  private async loadLatestHeartDate() {
    const row = await this.readQuery<TimeRow | null>('heart:latest-time', () =>
      this.db.getFirstAsync<TimeRow>('SELECT time FROM heart_rate ORDER BY time DESC LIMIT 1'),
    );
    return row ? parseSqliteDateTime(row.time) : null;
  }

  private async loadAllHeartRows() {
    return this.readQuery('heart:all-rows', () => queryAllHeartRows(this.db));
  }

  private async loadHeartRowsSince(start: Date, readKey: string) {
    return this.readQuery(readKey, async () => {
      const latestHeartDate = await this.loadLatestHeartDate();
      return latestHeartDate ? queryHeartRowsBetween(this.db, start, latestHeartDate) : [];
    });
  }

  private async loadWellnessMetricDayAggregatesSince(start: Date, readKey: string) {
    const startDay = dateKey(start);
    return this.readQuery(readKey, () =>
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

  private async loadWellnessMetricSummarySince(start: Date, readKey: string) {
    const startSql = formatSqliteDateTime(start);
    const startDay = dateKey(start);
    return this.readQuery(readKey, () =>
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
    readKey: string,
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

    return this.readQuery(readKey, async () => {
      const rows = await this.db.getAllAsync<NullableNumberRow>(sql, startSql, limit);
      return rows.map((row) => row.value).filter((value): value is number => value !== null);
    });
  }

  private async loadHeartSamplesBetween(start: Date, end: Date, readKey: string) {
    return this.readQuery(readKey, () => queryHeartSamplesBetween(this.db, start, end));
  }

  private async loadHeartBucketRowsBetween(start: Date, end: Date, readKey: string) {
    const startBucket = bucketStartForDate(start);
    const endBucket = bucketStartForDate(end);

    return this.readQuery(readKey, async () => {
      return withAggregateReadLock(this.db, () =>
        loadStoredHeartIntradayBucketRows(this.db, startBucket, endBucket),
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
          SELECT ${SLEEP_CYCLE_SELECT_COLUMNS}
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
    return this.readQuery(`sleep-stages:${sortedIds.join('|')}`, () => loadSleepStageRecordsForIds(this.db, sortedIds));
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
        SELECT ${ACTIVITY_SELECT_COLUMNS}
        FROM activities
        WHERE activity = 'Nap' AND start >= ? AND review_state <> 'dismissed'
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
          SELECT ${ACTIVITY_SELECT_COLUMNS}
          FROM activities
          WHERE review_state <> 'dismissed'
          ORDER BY start DESC
          LIMIT ?
        `,
        [limit],
      ),
    );
  }

  private async loadActivitiesOverlapping(start: Date, end: Date) {
    const startSql = formatSqliteDateTime(start);
    const endSql = formatSqliteDateTime(end);

    return this.readQuery(`activities:overlap:${startSql}:${endSql}`, () =>
      loadActivitiesOverlappingRange(this.db, start, end),
    );
  }

  private async buildHistoryOverviewForDay(dayKey: string): Promise<HistoryOverview> {
    await this.ensurePrepared();
    await Promise.all([
      ensureDashboardAggregatesReady(this.db),
      ensureHeartIntradayBucketsReady(this.db),
    ]);

    const [heartCount, availableDayKeys, heartState] = await Promise.all([
      countHeartRows(this.db),
      loadDashboardDayKeys(this.db, 30),
      loadLatestHeartState(this.db),
    ]);

    if (heartCount === 0 || availableDayKeys.length === 0) {
      return buildEmptyHistoryOverview(new Date());
    }

    const selectedDayKey = availableDayKeys.includes(dayKey) ? dayKey : availableDayKeys.at(-1)!;
    const selectedDate = dateFromDayKey(selectedDayKey);
    const [heartDayStats, sleepCycles, selectedSleepRaw, selectedHeartRow, latestHeartTime] = await Promise.all([
      loadHeartDayStatsThroughDay(this.db, selectedDayKey, 14),
      loadSleepCyclesThroughDay(this.db, selectedDayKey, 15),
      loadSleepCycleForDay(this.db, selectedDayKey),
      loadLatestHeartRowBefore(this.db, nextDayFromDayKey(selectedDayKey)),
      loadLatestHeartTimeForDay(this.db, selectedDayKey),
    ]);
    const [allSleepStageRecords, scoreNapActivities] = await Promise.all([
      this.loadSleepStagesForIds(sleepCycles.map((sleep) => sleep.sleepId)),
      loadNapActivitiesForSleepScoreRange(this.db, sleepCycles),
    ]);
    const sleepSummaryById = buildSleepStageSummaryMap(sleepCycles, allSleepStageRecords);
    const rescoredSleepCycles = rescoreSleepCyclesWithSummaries(sleepCycles, sleepSummaryById, scoreNapActivities);
    const selectedSleep = selectedSleepRaw
      ? rescoredSleepCycles.find((sleep) => sleep.sleepId === selectedSleepRaw.sleepId) ?? selectedSleepRaw
      : null;
    const completeRescoredSleepCycles = completeSleepCycles(rescoredSleepCycles);
    const selectedCompleteSleep =
      selectedSleep && isCompleteSleepCycle(selectedSleep)
        ? selectedSleep
        : completeRescoredSleepCycles.at(-1) ?? null;
    const dailyMinima = heartDayStats.map((stat) => stat.minBpm);
    const restingHr = personalizeRestingHr(completeRescoredSleepCycles, dailyMinima);
    const maxHr = personalizeMaxHrFromObservedPeak(heartState.observed_peak_bpm, restingHr);
    const recovery = estimateRecoveryScoreFromSleeps(selectedCompleteSleep, completeRescoredSleepCycles, selectedHeartRow?.stress ?? null);
    const selectedDayStart = startOfDayFromDayKey(selectedDayKey);
    const selectedDayLatestHeartDate = latestHeartTime ? parseSqliteDateTime(latestHeartTime) : null;
    const selectedDayEnd = endOfDashboardDayWindow(
      selectedDayKey,
      selectedDayKey === dateKey(new Date()),
      selectedDayLatestHeartDate,
    );

    const [selectedDayHeartRows, selectedSleepFeatureRows, stageRecords, heartDayBucketRows] = await Promise.all([
      loadHeartMetricRowsForDay(this.db, selectedDayKey),
      selectedCompleteSleep ? ensureSleepFeatureBucketsForRange(this.db, selectedCompleteSleep.start, selectedCompleteSleep.end) : Promise.resolve([]),
      Promise.resolve(
        selectedSleep
          ? allSleepStageRecords.filter((stage) => stage.sleepId === selectedSleep.sleepId)
          : [],
      ),
      loadHeartBucketRowsBetweenRange(this.db, selectedDayStart, selectedDayEnd),
    ]);
    const [heartMarkerActivities, supplement] = await Promise.all([
      this.loadActivitiesOverlapping(selectedDayStart, selectedDayEnd),
      buildDashboardSupplement({
        db: this.db,
        selectedDayKey,
        heartDayStats,
        sleepCycles: completeRescoredSleepCycles,
        selectedSleep: selectedCompleteSleep,
        latestStress: selectedHeartRow?.stress ?? null,
        restingHr,
        maxHr,
        selectedDayHeartRows,
        selectedSleepFeatureRows,
      }),
    ]);
    const heartDayWindow = summarizeBucketWindow(heartDayBucketRows);
    const heartCardSeries =
      heartDayWindow.bucketSamples.length > 0
        ? createTimeBuckets(
            heartDayWindow.bucketSamples,
            DASHBOARD_HEART_BUCKET_MINUTES,
            selectedDayStart,
            selectedDayEnd,
          )
        : [];
    const heartCardMarkers = buildHeartIntradayMarkers(
      selectedDayStart,
      selectedDayEnd,
      selectedSleep ? [selectedSleep] : [],
      heartMarkerActivities,
      selectedSleep
        ? new Map([
            [
              selectedSleep.sleepId,
              buildHeartIntradaySleepDetails(
                selectedSleep,
                sleepSummaryById.get(selectedSleep.sleepId) ??
                  summarizeSleepStages(stageRecords, selectedSleep.start, selectedSleep.inBedEnd ?? selectedSleep.end),
              ),
            ],
          ])
        : undefined,
    );
    const sleepCard = buildDashboardSleepCard(selectedSleep, stageRecords);
    const dayStatsByDay = new Map(heartDayStats.map((stat) => [stat.day, stat]));
    const selectedStrain = dayStatsByDay.get(selectedDayKey)?.strainScore ?? null;
    const strainSeries = buildCumulativeStrainSeries(
      selectedDayHeartRows,
      selectedDayStart,
      selectedDayEnd,
      DASHBOARD_HEART_BUCKET_MINUTES,
      maxHr,
      restingHr,
    );
    const resolvedStrain = trendValues(strainSeries).at(-1) ?? selectedStrain;
    const strainMissingReason =
      trendValues(strainSeries).length === 0
        ? selectedDayHeartRows.length > 0
          ? LIMITED_LOAD_REASON
          : NO_HISTORY_REASON
        : null;

    return {
      dateLabel: formatLongDate(selectedDate),
      day: supplement.day,
      recovery: {
        score: recovery.score,
        label: describeRecovery(recovery.score),
        caption: 'Recovery',
        isEstimated: true,
        missingReason: recovery.missingReason,
        breakdown: recovery.breakdown,
      },
      heartCard: {
        restingHr,
        averageHr: heartDayWindow.averageBpm,
        maxHr: heartDayWindow.sustainedPeakBpm,
        pointIntervalMinutes: HEART_INTRADAY_BUCKET_MINUTES,
        series: heartCardSeries,
        markers: heartCardMarkers,
        missingReason: heartCardSeries.length === 0 ? NO_HISTORY_REASON : null,
      },
      sleepCard,
      strainCard: {
        score: resolvedStrain,
        label:
          resolvedStrain === null
            ? 'Waiting for effort'
            : resolvedStrain >= 14
              ? 'Loaded'
              : resolvedStrain >= 8
                ? 'Building'
                : 'Light',
        series: strainSeries,
        isEstimated: true,
        missingReason: strainMissingReason,
      },
      activitySummary: supplement.activitySummary,
      insights: supplement.insights,
    } satisfies HistoryOverview;
  }

  async getHistoryOverview(dayKey: string): Promise<HistoryOverview> {
    return this.readSnapshot(`history:overview:${dayKey}`, async () => {
      const startedAt = Date.now();

      try {
        await this.waitForRepositoryMutations();
        const overview = await this.buildHistoryOverviewForDay(dayKey);
        logMobilePerf('repository.getHistoryOverview', startedAt, {
          dayKey: overview.day.dayKey,
          markers: overview.heartCard.markers.length,
          points: overview.heartCard.series.length,
        });
        return overview;
      } catch (error) {
        logMobilePerfError('repository.getHistoryOverview', error, {
          dayKey,
        });
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
    });
  }

  async getSleepHistory(range: HistoryRange): Promise<SleepHistoryData> {
    return this.readSnapshot(`sleep:${range}`, async () => {
      const startedAt = Date.now();
      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();

        const sleepCycles = await this.loadRecentSleepCycles(Math.max(rangeDays(range), 15));
        const [stageRecords, scoreNapActivities] = await Promise.all([
          this.loadSleepStagesForIds(sleepCycles.map((sleep) => sleep.sleepId)),
          loadNapActivitiesForSleepScoreRange(this.db, sleepCycles),
        ]);
        const sleepSummaries = buildSleepStageSummaryMap(sleepCycles, stageRecords);
        const rescoredSleepCycles = rescoreSleepCyclesWithSummaries(sleepCycles, sleepSummaries, scoreNapActivities);
        const completeRescoredSleepCycles = completeSleepCycles(rescoredSleepCycles);
        const preferences = await loadSleepPreferences(this.db, completeRescoredSleepCycles);
        const latestSleepForPlan = completeRescoredSleepCycles.at(-1) ?? null;
        const napActivities = latestSleepForPlan ? await this.loadNapActivitiesSince(latestSleepForPlan.end) : [];
        const sleepPlan = buildSleepPlan(preferences, completeRescoredSleepCycles, napActivities);
        const sessions = rescoredSleepCycles.slice(-rangeDays(range)).reverse();
        const completeSessionsForStats = completeRescoredSleepCycles.slice(-rangeDays(range));
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
            completionStatus: 'complete',
            isInProgress: false,
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

        const hasConsistencyBaseline = completeSessionsForStats.length >= MIN_SLEEP_CONSISTENCY_NIGHTS;
        const bedtimeValues = completeSessionsForStats.map((session) => session.start.getHours() * 60 + session.start.getMinutes());
        const wakeValues = completeSessionsForStats.map((session) => session.end.getHours() * 60 + session.end.getMinutes());
        const bedtimeMean = bedtimeValues.length > 0 ? mean(bedtimeValues) : 0;
        const wakeMean = wakeValues.length > 0 ? mean(wakeValues) : 0;
        const bedtimeConsistency = hasConsistencyBaseline
          ? clamp(100 - stdDev(bedtimeValues, bedtimeMean) / Math.max(1, bedtimeMean) * 100, 0, 100)
          : null;
        const wakeConsistency = hasConsistencyBaseline
          ? clamp(100 - stdDev(wakeValues, wakeMean) / Math.max(1, wakeMean) * 100, 0, 100)
          : null;

        const mappedSessions: SleepSession[] = sessions.map((session) => {
          const summary = sleepSummaries.get(session.sleepId) ?? summarizeSleepStages([], session.start, session.end);

          return {
            id: session.id,
            dateLabel: formatShortDate(session.end),
            score: session.score,
            bedtime: formatClock(summary.start),
            wakeTime: formatClock(summary.end),
            completionStatus: session.completionStatus,
            isInProgress: session.isInProgress,
            durationMinutes: summary.timeAsleepMinutes,
            timeInBedMinutes: summary.timeInBedMinutes,
            efficiency:
              summary.timeInBedMinutes > 0
                ? summary.timeAsleepMinutes / summary.timeInBedMinutes * 100
                : null,
            remMinutes: summary.remMinutes,
            deepMinutes: summary.deepMinutes,
            consistency:
              session.isInProgress || bedtimeConsistency === null || wakeConsistency === null
                ? null
                : Math.round((bedtimeConsistency + wakeConsistency) / 2),
            stages: summary.stages,
            isEstimated: true,
            missingReason: summary.stages.length === 0 ? LIMITED_SENSOR_REASON : null,
            minBpm: session.minBpm,
            maxBpm: session.maxBpm,
            avgHrv: session.avgHrv,
          };
        });
        const trendSleepCycles = completeRescoredSleepCycles.slice(-rangeDays(range));
        const sleepScoreByDay = new Map(trendSleepCycles.map((session) => [dateKey(session.end), session.score]));
        const sleepDurationByDay = new Map(
          trendSleepCycles.map((session) => {
            const summary = sleepSummaries.get(session.sleepId);
            return [dateKey(session.end), summary?.timeAsleepMinutes ?? session.asleepMinutes ?? minutesBetween(session.start, session.end)] as const;
          }),
        );
        const latestSession = mappedSessions[0] ?? null;
        const trendEndDate = latestSleepForPlan?.end ?? latestSleep.end;

        const snapshot = {
          headlineScore: latestSession?.score ?? latestSleep.score,
          headlineLabel: latestSession?.isInProgress ? 'In progress' : describeSleepScore(latestSession?.score ?? latestSleep.score),
          bedtime: latestSession?.bedtime ?? formatClock(latestSleep.start),
          wakeTime: latestSession?.wakeTime ?? formatClock(latestSleep.end),
          completionStatus: latestSession?.completionStatus ?? latestSleep.completionStatus,
          isInProgress: latestSession?.isInProgress ?? latestSleep.isInProgress,
          durationMinutes: latestSession?.durationMinutes ?? minutesBetween(latestSleep.start, latestSleep.end),
          timeInBedMinutes: latestSession?.timeInBedMinutes ?? minutesBetween(latestSleep.start, latestSleep.end),
          bedtimeConsistency: bedtimeConsistency === null ? null : Math.round(bedtimeConsistency),
          wakeConsistency: wakeConsistency === null ? null : Math.round(wakeConsistency),
          scoreTrend: buildFilledDailySeries(range, trendEndDate, (day) => sleepScoreByDay.get(day) ?? null),
          durationTrend: buildFilledDailySeries(range, trendEndDate, (day) => sleepDurationByDay.get(day) ?? null),
          sessions: mappedSessions,
          sleepPlan,
          isEstimated: true,
        } satisfies SleepHistoryData;
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

  async getHeartHistory(range: HistoryRange): Promise<HeartHistoryData> {
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
            intradayMarkers: [],
            weeklyResting: [],
            recoveryShift: null,
            missingReason: NO_HISTORY_REASON,
          };
        }

        const intradayStart = new Date(latestHeartDate.getTime() - 24 * 3600000);
        const intraday = await loadIntradayHeartWindow(this.db, formatSqliteDateTime(latestHeartDate));
        const intradayWindowStart = intraday.intradayStart ?? intradayStart;
        const completeSleepCyclesForMetrics = completeSleepCycles(sleepCycles);
        const heartMarkerSleepDetails = await loadHeartMarkerSleepDetails(this.db, sleepCycles);
        const intradayMarkers = buildHeartIntradayMarkers(
          intradayWindowStart,
          latestHeartDate,
          sleepCycles,
          await this.loadActivitiesOverlapping(intradayWindowStart, latestHeartDate),
          heartMarkerSleepDetails,
        );
        const sanitizedDailyMinimaRows = dailyMinimaRows.map((row) => ({
          day: row.day,
          min_bpm: sanitizeRecordedBpm(row.min_bpm),
        }));
        const dailyMinima = sanitizedDailyMinimaRows
          .map((row) => row.min_bpm)
          .filter((value): value is number => value !== null);
        const restingHr = personalizeRestingHr(completeSleepCyclesForMetrics, dailyMinima);
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
            intradayWindowStart,
            latestHeartDate,
          ),
          intradayMarkers,
          weeklyResting,
          recoveryShift: previousMedian === null ? null : restingHr - previousMedian,
        } satisfies HeartHistoryData;
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

  async getDashboardHeartTimeline(range: HistoryRange): Promise<HeartCardData> {
    return this.readSnapshot(`heart:dashboard:${range}`, async () => {
      const window = await this.getDashboardHeartTimelineWindow(range);
      return buildHeartCardDataFromWindow(window);
    });
  }

  async getFocusedHeartDetail(marker: HeartIntradayMarker): Promise<FocusedHeartDetail> {
    const startTimeMs = marker.startTimeMs ?? null;
    const endTimeMs = marker.endTimeMs ?? null;
    const readKey = `heart:focus:${marker.id}:${startTimeMs ?? 'missing'}:${endTimeMs ?? 'missing'}`;

    return this.readSnapshot(readKey, async () => {
      const startedAt = Date.now();

      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();
        await waitForAggregateMutations(this.db);
        await ensureHeartIntradayBucketsReady(this.db);

        if (startTimeMs === null || endTimeMs === null || endTimeMs <= startTimeMs) {
          return {
            averageHr: null,
            maxHr: null,
            pointIntervalMinutes: HEART_INTRADAY_BUCKET_MINUTES,
            series: [],
            marker: buildFocusedHeartDetailMarker(marker),
            missingReason: NO_HISTORY_REASON,
          } satisfies FocusedHeartDetail;
        }

        const startDate = new Date(startTimeMs);
        const endDate = new Date(endTimeMs);
        const bucketRows = await loadHeartBucketRowsBetweenRange(
          this.db,
          startDate,
          endDate,
          HEART_INTRADAY_BUCKET_SECONDS,
        );
        const bucketSamples = bucketRows.map(toHeartIntradayBucketSample);
        const summary = summarizeBucketWindow(bucketRows);
        const series = createTimeBuckets(
          bucketSamples,
          HEART_INTRADAY_BUCKET_MINUTES,
          startDate,
          endDate,
        );

        const snapshot = {
          averageHr: summary.averageBpm,
          maxHr: summary.sustainedPeakBpm,
          pointIntervalMinutes: HEART_INTRADAY_BUCKET_MINUTES,
          series,
          marker: buildFocusedHeartDetailMarker(marker),
          missingReason: series.length === 0 ? NO_HISTORY_REASON : null,
        } satisfies FocusedHeartDetail;

        logMobilePerf('repository.getFocusedHeartDetail', startedAt, {
          markerId: marker.id,
          points: snapshot.series.length,
          pointIntervalMinutes: snapshot.pointIntervalMinutes,
        });

        return snapshot;
      } catch (error) {
        logMobilePerfError('repository.getFocusedHeartDetail', error, {
          markerId: marker.id,
        });
        throw error;
      }
    });
  }

  async getWellnessData(range: HistoryRange): Promise<WellnessData> {
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
        const completeRecentSleepCycles = completeSleepCycles(recentSleepCycles);
        logMobilePerf('repository.getWellnessData.loadBaseline', baselineStartedAt, {
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

          logMobilePerf('repository.getWellnessData.empty', startedAt, {
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
          completeRecentSleepCycles[0]?.start.getTime() ?? latestHeartDate.getTime(),
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
        logMobilePerf('repository.getWellnessData.loadMetricRows', metricRowsStartedAt, {
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
        logMobilePerf('repository.getWellnessData.loadActivityRows', activityRowsStartedAt, {
          range,
          activities: recentActivities.length,
          bucketRows: activityHeartBuckets.reduce((sum, rows) => sum + rows.length, 0),
          samples: activityHeartBuckets.reduce((sum, rows) => sum + totalBucketSampleCount(rows), 0),
        });

        const computeStartedAt = Date.now();
        const latestSleep = completeRecentSleepCycles.at(-1) ?? null;
        const restingHr = personalizeRestingHr(completeRecentSleepCycles, dailyMinimaRows.map((row) => row.min_bpm));
        const maxHr = personalizeMaxHrFromObservedPeak(heartState.observed_peak_bpm, restingHr);
        const latestStress = heartState.latest_stress;
        const recoveryByDay = new Map(
          completeRecentSleepCycles.map((sleep, index, sleeps) => [
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
            confidence: activity.confidence,
            source: activity.source,
            reviewState: activity.reviewState,
            strainLabel: 'Estimated strain',
            caloriesLabel: 'Estimated calories',
          };
        });

        const recovery = estimateRecoveryScoreFromSleeps(latestSleep, completeRecentSleepCycles, latestStress);
        const data = {
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
        } satisfies WellnessData;
        logMobilePerf('repository.getWellnessData.compute', computeStartedAt, {
          range,
          dayRows: metricDayAggregates.length,
          activities: data.activities.length,
        });
        logMobilePerf('repository.getWellnessData', startedAt, {
          range,
          activities: data.activities.length,
        });
        return data;
      } catch (error) {
        logMobilePerfError('repository.getWellnessData', error, {
          range,
        });
        throw error;
      }
    });
  }

  async getTrendData(range: HistoryRange): Promise<TrendData> {
    return this.readSnapshot(`trends:${range}`, async () => {
      const startedAt = Date.now();
      try {
        await this.waitForRepositoryMutations();
        await this.ensurePrepared();
        await waitForAggregateMutations(this.db);
        await ensureDashboardAggregatesReady(this.db);

        const [sleep, heart, wellness, latestHeartDate] = await Promise.all([
          this.getSleepHistory(range),
          this.getHeartHistory(range),
          this.getWellnessData(range),
          this.loadLatestHeartDate(),
        ]);
        const trendSleepCycles = completeSleepCycles(await this.loadRecentSleepCycles(
          rangeDays(range) + TEMPERATURE_BASELINE_WINDOW_NIGHTS,
        ));
        const selectedSleepCycles = trendSleepCycles.slice(-rangeDays(range));
        const latestTrendSleep = selectedSleepCycles.at(-1) ?? null;

        const emptyMetric = (
          id: TrendMetric['id'],
          title: string,
          accent: TrendMetric['accent'],
          unit: string,
          missingReason: string,
        ): TrendMetric =>
          buildTrendMetric(
            {
              title,
              latest: null,
              average: null,
              delta: null,
              unit,
              detail: missingReason,
              accent,
              series: [],
              missingReason,
            },
            id,
          );

        if (!latestHeartDate) {
          return {
            range,
            latestLabel: 'No history',
            primaryMetrics: [
              emptyMetric('recovery', 'Recovery', 'green', '%', NO_HISTORY_REASON),
              emptyMetric('hrv', 'HRV', 'green', 'ms', NO_SLEEP_REASON),
              emptyMetric('restingHr', 'Resting HR', 'cyan', 'bpm', NO_HISTORY_REASON),
              emptyMetric('sleepScore', 'Sleep Score', 'violet', '%', NO_SLEEP_REASON),
            ],
            secondaryMetrics: [
              emptyMetric('sleepDuration', 'Sleep Duration', 'cyan', 'h', NO_SLEEP_REASON),
              emptyMetric('sleepConsistency', 'Sleep Consistency', 'violet', '%', BUILDING_SLEEP_CONSISTENCY_REASON),
              emptyMetric('stress', 'Stress', 'alert', '', NO_HISTORY_REASON),
              emptyMetric('skinTemperatureDeviation', 'Skin Temp Deviation', 'heart', '°C', BUILDING_TEMPERATURE_BASELINE_REASON),
            ],
            missingReason: NO_HISTORY_REASON,
          } satisfies TrendData;
        }

        const sleepScoreValues = trendValues(sleep.scoreTrend);
        const restingValues = trendValues(heart.weeklyResting);
        const hrvSeries = latestTrendSleep
          ? buildSleepCycleTrendSeries({
              sleeps: selectedSleepCycles,
              range,
              endDate: latestTrendSleep.end,
              valueForSleep: (session) => (session.avgHrv > 0 ? session.avgHrv : null),
            })
          : [];
        const sleepDurationSeries = sleep.durationTrend.map((point) => ({
          ...point,
          value: point.value === null ? null : Number((point.value / 60).toFixed(1)),
        }));
        const sleepConsistencySeries = latestTrendSleep
          ? buildSleepCycleTrendSeries({
              sleeps: selectedSleepCycles,
              range,
              endDate: latestTrendSleep.end,
              valueForSleep: (_sleep, index) => {
                const globalIndex = trendSleepCycles.length - selectedSleepCycles.length + index;
                const windowStart = Math.max(0, globalIndex - (SLEEP_CONSISTENCY_WINDOW_NIGHTS - 1));
                return calculateSleepConsistencyScore(trendSleepCycles.slice(windowStart, globalIndex + 1));
              },
            })
          : [];
        const skinTemperatureDeviationSeries = latestTrendSleep
          ? buildSleepCycleTrendSeries({
              sleeps: selectedSleepCycles,
              range,
              endDate: latestTrendSleep.end,
              digits: 1,
              valueForSleep: (_sleep, index) => {
                const globalIndex = trendSleepCycles.length - selectedSleepCycles.length + index;
                const current = trendSleepCycles[globalIndex] ?? null;
                if (!current || current.avgSkinTemp === null) {
                  return null;
                }

                const priorTemps = trendSleepCycles
                  .slice(Math.max(0, globalIndex - TEMPERATURE_BASELINE_WINDOW_NIGHTS), globalIndex)
                  .map((sleepCycle) => sleepCycle.avgSkinTemp)
                  .filter((value): value is number => value !== null);

                if (priorTemps.length < MIN_TEMPERATURE_BASELINE_NIGHTS) {
                  return null;
                }

                const priorMedianTemp = median(priorTemps);
                return priorMedianTemp === null ? null : current.avgSkinTemp - priorMedianTemp;
              },
            })
          : [];
        const latestTemperatureDeviation = latestSeriesValue(skinTemperatureDeviationSeries);
        const hrvMissingReason = selectedSleepCycles.length === 0 ? NO_SLEEP_REASON : LIMITED_SENSOR_REASON;
        const consistencyMissingReason = selectedSleepCycles.length === 0 ? NO_SLEEP_REASON : BUILDING_SLEEP_CONSISTENCY_REASON;
        const temperatureMissingReason = selectedSleepCycles.length === 0 ? NO_SLEEP_REASON : BUILDING_TEMPERATURE_BASELINE_REASON;

        const data = {
          range,
          latestLabel: formatLongDate(latestHeartDate),
          primaryMetrics: [
            buildTrendMetric(
              {
                ...wellness.recoveryIndex,
                title: 'Recovery',
                unit: '%',
              },
              'recovery',
            ),
            buildTrendMetric(
              buildTrendMetricSeries({
                title: 'HRV',
                unit: 'ms',
                accent: 'green',
                detail: 'Overnight HRV across the selected range.',
                series: hrvSeries,
                missingReason: hrvMissingReason,
                minFilledPoints: 3,
              }),
              'hrv',
            ),
            buildTrendMetric(
              {
                title: 'Resting HR',
                latest: heart.restingHr,
                average: restingValues.length === 0 ? null : mean(restingValues),
                delta:
                  restingValues.length < 2
                    ? null
                    : restingValues.at(-1)! - restingValues.at(-2)!,
                unit: 'bpm',
                detail:
                  heart.restingHr === null
                    ? heart.missingReason ?? NO_HISTORY_REASON
                    : 'Nightly resting heart rate across the selected range.',
                accent: 'cyan',
                series: heart.weeklyResting,
                missingReason: heart.restingHr === null ? heart.missingReason ?? NO_HISTORY_REASON : null,
              },
              'restingHr',
            ),
            buildTrendMetric(
              {
                title: 'Sleep Score',
                latest: sleep.headlineScore,
                average: sleepScoreValues.length === 0 ? null : mean(sleepScoreValues),
                delta:
                  sleepScoreValues.length < 2
                    ? null
                    : sleepScoreValues.at(-1)! - sleepScoreValues.at(-2)!,
                unit: '%',
                detail:
                  sleep.headlineScore === null
                    ? sleep.missingReason ?? NO_SLEEP_REASON
                    : 'Nightly sleep score across the selected range.',
                accent: 'violet',
                series: sleep.scoreTrend,
                missingReason: sleep.headlineScore === null ? sleep.missingReason ?? NO_SLEEP_REASON : null,
              },
              'sleepScore',
            ),
          ],
          secondaryMetrics: [
            buildTrendMetric(
              buildTrendMetricSeries({
                title: 'Sleep Duration',
                unit: 'h',
                accent: 'cyan',
                detail: 'Nightly time asleep across the selected range.',
                series: sleepDurationSeries,
                digits: 1,
                missingReason: sleep.missingReason ?? NO_SLEEP_REASON,
                minFilledPoints: 3,
              }),
              'sleepDuration',
            ),
            buildTrendMetric(
              buildTrendMetricSeries({
                title: 'Sleep Consistency',
                unit: '%',
                accent: 'violet',
                detail: 'Rolling bedtime and wake-time stability across recent nights.',
                series: sleepConsistencySeries,
                missingReason: consistencyMissingReason,
                minFilledPoints: 3,
              }),
              'sleepConsistency',
            ),
            buildTrendMetric(
              {
                ...wellness.stress,
                title: 'Stress',
              },
              'stress',
            ),
            buildTrendMetric(
              buildTrendMetricSeries({
                title: 'Skin Temp Deviation',
                unit: '°C',
                accent: 'heart',
                detail: describeSkinTemperatureDeviation(latestTemperatureDeviation),
                series: skinTemperatureDeviationSeries,
                digits: 1,
                missingReason: temperatureMissingReason,
                minFilledPoints: 3,
              }),
              'skinTemperatureDeviation',
            ),
          ],
        } satisfies TrendData;

        logMobilePerf('repository.getTrendData', startedAt, {
          range,
          primaryMetrics: data.primaryMetrics.length,
        });
        return data;
      } catch (error) {
        logMobilePerfError('repository.getTrendData', error, {
          range,
        });
        throw error;
      }
    });
  }
}
