import { gql } from '@apollo/client';
import { skipToken, useQuery } from '@apollo/client/react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';

import {
  buildEnrichedSleepCycleBundle,
  buildFilledDailySeries,
  buildWellnessMetricSeries,
  calculateStrainFromBucketRows,
  estimateCaloriesFromBucketRows,
  estimateRecoveryScoreFromSleeps,
  personalizeMaxHrFromObservedPeak,
  personalizeRestingHr,
  rangeDays,
  toActivityRecord,
  toSleepCycleRecord,
  toSleepStageRecord,
  type ActivityRecord,
  type ActivityRow,
  type EnrichedSleepCycleBundle,
  type HeartIntradayBucketRow,
  type SleepCycleRow,
  type SleepStageRow,
} from '@/data/sqlite/SQLiteHealthRepository';
import { getSQLiteApolloClient } from '@/services/graphql/sqliteApolloClient';
import type { ActivitySummary, HistoryRange, MetricSeries, WellnessData } from '@/types/health';
import { dateKey, formatClock, formatSqliteDateTime, minutesBetween, parseSqliteDateTime } from '@/utils/dateTime';
import { mean } from '@/utils/math';
import { logMobilePerf, logMobilePerfError } from '@/utils/mobilePerf';
import {
  MAX_PLAUSIBLE_RESPIRATORY_RATE_RAW,
  MIN_PLAUSIBLE_RESPIRATORY_RATE_RAW,
  normalizeRespiratoryRateRaw,
} from '@/utils/respiratoryRate';

const HEART_INTRADAY_METRIC_KEY = 'heart_bpm';
const HEART_INTRADAY_BUCKET_SECONDS = 5 * 60;
const NO_HISTORY_REASON = 'No local history yet. Sync the wearable from Settings to unlock this view.';
const NO_SLEEP_REASON = 'No overnight sleep has been detected yet. Leave the wearable on long enough for a full sleep window.';

const WELLNESS_BASELINE_QUERY = gql`
  query WellnessBaseline($sleepLimit: Int!) {
    heart_global_stats(limit: 1) {
      id
      observed_peak_bpm
      latest_heart_time
      latest_stress
    }
    heart_rate(order_by: [{ time: desc }], limit: 1) {
      id
      time
      stress
    }
    heart_day_stats(order_by: [{ day: asc }], limit: 10000) {
      day
      min_bpm
    }
    sleep_cycles(order_by: [{ start: desc }], limit: $sleepLimit) {
      id
      sleep_id
      start
      end
      min_bpm
      max_bpm
      avg_bpm
      min_hrv
      max_hrv
      avg_hrv
      avg_skin_temp
      score
      completion_status
    }
    sleep_stage_segments(order_by: [{ start: asc }], limit: 10000) {
      id
      sleep_id
      start
      end
      stage
      is_estimated
    }
    activities(
      where: { review_state: { _neq: "dismissed" } }
      order_by: [{ start: desc }]
      limit: 5
    ) {
      id
      period_id
      start
      end
      activity
      confidence
      source
      review_state
    }
  }
`;

const WELLNESS_METRICS_QUERY = gql`
  query WellnessMetrics(
    $activityBucketEnd: String!
    $activityBucketStart: String!
    $bucketSeconds: Int!
    $maxRespiratoryRateRaw: Int!
    $metricKey: String!
    $minRespiratoryRateRaw: Int!
    $startDay: String!
    $startSql: String!
  ) {
    wellness_day_stats(
      where: { day: { _gte: $startDay } }
      order_by: [{ day: asc }]
      limit: 10000
    ) {
      day
      stress_count
      avg_stress
      spo2_count
      avg_spo2
      respiratory_rate_count
      avg_respiratory_rate
      skin_temp_count
      avg_skin_temp
    }
    recent_stress_values: heart_rate(
      where: { time: { _gte: $startSql }, stress: { _is_null: false } }
      order_by: [{ time: desc }]
      limit: 8
    ) {
      id
      time
      stress
    }
    recent_spo2_values: heart_rate(
      where: { time: { _gte: $startSql }, spo2: { _is_null: false } }
      order_by: [{ time: desc }]
      limit: 8
    ) {
      id
      time
      spo2
    }
    recent_respiratory_rate_values: heart_rate(
      where: {
        time: { _gte: $startSql }
        resp_rate_raw: { _gte: $minRespiratoryRateRaw, _lte: $maxRespiratoryRateRaw }
      }
      order_by: [{ time: desc }]
      limit: 8
    ) {
      id
      time
      resp_rate_raw
    }
    recent_skin_temp_values: heart_rate(
      where: { time: { _gte: $startSql }, skin_temp: { _is_null: false } }
      order_by: [{ time: desc }]
      limit: 8
    ) {
      id
      time
      skin_temp
    }
    intraday_metric_buckets(
      where: {
        metric_key: { _eq: $metricKey }
        bucket_seconds: { _eq: $bucketSeconds }
        bucket_start: { _gte: $activityBucketStart, _lte: $activityBucketEnd }
      }
      order_by: [{ bucket_start: asc }]
      limit: 10000
    ) {
      metric_key
      bucket_seconds
      bucket_start
      sample_count
      avg_value
      first_value
      last_value
    }
  }
`;

interface WellnessBaselineData {
  activities: ActivityRow[];
  heart_day_stats: Array<{
    day: string;
    min_bpm: number;
  }>;
  heart_global_stats: Array<{
    id: number;
    latest_heart_time: string | null;
    latest_stress: number | null;
    observed_peak_bpm: number | null;
  }>;
  heart_rate: Array<{
    id: number;
    stress: number | null;
    time: string;
  }>;
  sleep_cycles: SleepCycleRow[];
  sleep_stage_segments: SleepStageRow[];
}

interface WellnessMetricsData {
  intraday_metric_buckets: Array<{
    avg_value: number | null;
    bucket_seconds: number;
    bucket_start: string;
    first_value: number | null;
    last_value: number | null;
    metric_key: string;
    sample_count: number;
  }>;
  recent_respiratory_rate_values: Array<{
    id: number;
    resp_rate_raw: number | null;
    time: string;
  }>;
  recent_skin_temp_values: Array<{
    id: number;
    skin_temp: number | null;
    time: string;
  }>;
  recent_spo2_values: Array<{
    id: number;
    spo2: number | null;
    time: string;
  }>;
  recent_stress_values: Array<{
    id: number;
    stress: number | null;
    time: string;
  }>;
  wellness_day_stats: WellnessDayStatRow[];
}

interface WellnessDayStatRow {
  avg_respiratory_rate: number | null;
  avg_skin_temp: number | null;
  avg_spo2: number | null;
  avg_stress: number | null;
  day: string;
  respiratory_rate_count: number;
  skin_temp_count: number;
  spo2_count: number;
  stress_count: number;
}

interface WellnessBaselineContext {
  dailyMinima: number[];
  enrichedSleep: EnrichedSleepCycleBundle;
  latestHeartDate: Date | null;
  latestStress: number | null;
  observedPeakBpm: number | null;
  recentActivities: ActivityRecord[];
}

interface WellnessMetricVariables {
  activityBucketEnd: string;
  activityBucketStart: string;
  bucketSeconds: number;
  maxRespiratoryRateRaw: number;
  metricKey: string;
  minRespiratoryRateRaw: number;
  startDay: string;
  startSql: string;
}

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function bucketStartForDate(date: Date, bucketSeconds = HEART_INTRADAY_BUCKET_SECONDS) {
  const bucketMs = bucketSeconds * 1000;
  return formatSqliteDateTime(new Date(Math.floor(date.getTime() / bucketMs) * bucketMs));
}

function emptyMetric(title: string, accent: MetricSeries['accent']): MetricSeries {
  return {
    title,
    latest: null,
    average: null,
    delta: null,
    unit: '',
    detail: NO_HISTORY_REASON,
    accent,
    series: [],
    missingReason: NO_HISTORY_REASON,
  };
}

function emptyWellnessData(): WellnessData {
  return {
    stress: emptyMetric('Stress', 'alert'),
    spo2: emptyMetric('SpO2', 'cyan'),
    respiratoryRate: emptyMetric('Respiratory Rate', 'violet'),
    skinTemperature: emptyMetric('Skin Temperature', 'heart'),
    recoveryIndex: emptyMetric('Recovery Index', 'green'),
    activities: [],
    missingReason: NO_HISTORY_REASON,
  };
}

function numericValues(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function weightedAverage(rows: WellnessDayStatRow[], countKey: keyof WellnessDayStatRow, averageKey: keyof WellnessDayStatRow) {
  let count = 0;
  let weightedSum = 0;

  for (const row of rows) {
    const rowCount = row[countKey];
    const rowAverage = row[averageKey];
    if (typeof rowCount !== 'number' || typeof rowAverage !== 'number') {
      continue;
    }

    count += rowCount;
    weightedSum += rowAverage * rowCount;
  }

  return count === 0 ? null : weightedSum / count;
}

function sumCounts(rows: WellnessDayStatRow[], countKey: keyof WellnessDayStatRow) {
  return rows.reduce((sum, row) => {
    const value = row[countKey];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);
}

function trendValues(points: Array<{ value: number | null }>): number[] {
  return points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
}

function buildBaselineContext(data: WellnessBaselineData): WellnessBaselineContext {
  const global = data.heart_global_stats[0] ?? null;
  const latestHeartRow = data.heart_rate[0] ?? null;
  const latestHeartTime =
    global?.latest_heart_time && latestHeartRow?.time
      ? global.latest_heart_time > latestHeartRow.time
        ? global.latest_heart_time
        : latestHeartRow.time
      : global?.latest_heart_time ?? latestHeartRow?.time ?? null;
  const latestStress =
    latestHeartTime === latestHeartRow?.time
      ? latestHeartRow?.stress ?? null
      : global?.latest_stress ?? null;
  const sleepCycles = data.sleep_cycles.map(toSleepCycleRecord).reverse();
  const stageRecords = data.sleep_stage_segments.map(toSleepStageRecord);

  return {
    dailyMinima: numericValues(data.heart_day_stats.map((row) => row.min_bpm)),
    enrichedSleep: buildEnrichedSleepCycleBundle(sleepCycles, stageRecords, []),
    latestHeartDate: latestHeartTime ? parseSqliteDateTime(latestHeartTime) : null,
    latestStress,
    observedPeakBpm: global?.observed_peak_bpm ?? null,
    recentActivities: data.activities.map(toActivityRecord),
  };
}

function buildMetricVariables(context: WellnessBaselineContext, range: HistoryRange): WellnessMetricVariables | null {
  const latestHeartDate = context.latestHeartDate;
  if (!latestHeartDate) {
    return null;
  }

  const completeSleeps = context.enrichedSleep.completeSleeps;
  const recentActivities = context.recentActivities;
  const earliestRelevantTimestamp = Math.min(
    latestHeartDate.getTime() - rangeDays(range) * 24 * 3_600_000,
    completeSleeps[0]?.start.getTime() ?? latestHeartDate.getTime(),
    recentActivities.at(-1)?.start.getTime() ?? latestHeartDate.getTime(),
  );
  const earliestRelevantDate = new Date(earliestRelevantTimestamp);
  const activityBucketStart = recentActivities.length > 0
    ? bucketStartForDate(new Date(Math.min(...recentActivities.map((activity) => activity.start.getTime()))))
    : bucketStartForDate(earliestRelevantDate);
  const activityBucketEnd = recentActivities.length > 0
    ? bucketStartForDate(new Date(Math.max(...recentActivities.map((activity) => activity.end.getTime()))))
    : bucketStartForDate(earliestRelevantDate);

  return {
    activityBucketEnd,
    activityBucketStart,
    bucketSeconds: HEART_INTRADAY_BUCKET_SECONDS,
    maxRespiratoryRateRaw: MAX_PLAUSIBLE_RESPIRATORY_RATE_RAW,
    metricKey: HEART_INTRADAY_METRIC_KEY,
    minRespiratoryRateRaw: MIN_PLAUSIBLE_RESPIRATORY_RATE_RAW,
    startDay: dateKey(earliestRelevantDate),
    startSql: formatSqliteDateTime(earliestRelevantDate),
  };
}

function buildBucketRows(rows: WellnessMetricsData['intraday_metric_buckets']): HeartIntradayBucketRow[] {
  return rows.flatMap((bucket) => {
    if (
      bucket.sample_count <= 0 ||
      bucket.avg_value === null ||
      bucket.first_value === null ||
      bucket.last_value === null
    ) {
      return [];
    }

    return [{
      bucket_start: bucket.bucket_start,
      sample_count: bucket.sample_count,
      avg_bpm: bucket.avg_value,
      first_bpm: bucket.first_value,
      second_bpm: null,
      penultimate_bpm: null,
      last_bpm: bucket.last_value,
      max_triplet_avg: null,
    }];
  });
}

function rowsForActivity(rows: HeartIntradayBucketRow[], activity: ActivityRecord) {
  const startBucket = bucketStartForDate(activity.start);
  const endBucket = bucketStartForDate(activity.end);

  return rows.filter((row) => row.bucket_start >= startBucket && row.bucket_start <= endBucket);
}

function buildWellnessData(
  context: WellnessBaselineContext,
  metrics: WellnessMetricsData,
  range: HistoryRange,
): WellnessData {
  const latestHeartDate = context.latestHeartDate;
  if (!latestHeartDate || context.dailyMinima.length === 0) {
    return emptyWellnessData();
  }

  const completeRecentSleepCycles = context.enrichedSleep.completeSleeps;
  const latestSleep = completeRecentSleepCycles.at(-1) ?? null;
  const restingHr = personalizeRestingHr(completeRecentSleepCycles, context.dailyMinima);
  const maxHr = personalizeMaxHrFromObservedPeak(context.observedPeakBpm, restingHr);
  const recoveryByDay = new Map(
    completeRecentSleepCycles.map((sleep, index, sleeps) => [
      dateKey(sleep.end),
      estimateRecoveryScoreFromSleeps(sleep, sleeps.slice(0, index + 1), context.latestStress).score,
    ]),
  );
  const recoveryTrend =
    latestSleep === null
      ? []
      : buildFilledDailySeries(range, latestSleep.end, (day) => recoveryByDay.get(day) ?? null);
  const stressByDay = new Map(metrics.wellness_day_stats.map((row) => [row.day, row.avg_stress]));
  const spo2ByDay = new Map(metrics.wellness_day_stats.map((row) => [row.day, row.avg_spo2]));
  const respiratoryRateByDay = new Map(metrics.wellness_day_stats.map((row) => [row.day, row.avg_respiratory_rate]));
  const skinTempByDay = new Map(metrics.wellness_day_stats.map((row) => [row.day, row.avg_skin_temp]));
  const recentStressValues = numericValues(metrics.recent_stress_values.map((row) => row.stress));
  const recentSpo2Values = numericValues(metrics.recent_spo2_values.map((row) => row.spo2));
  const recentRespiratoryRateValues = numericValues(
    metrics.recent_respiratory_rate_values.map((row) => normalizeRespiratoryRateRaw(row.resp_rate_raw)),
  );
  const recentSkinTempValues = numericValues(metrics.recent_skin_temp_values.map((row) => row.skin_temp));
  const activityBucketRows = buildBucketRows(metrics.intraday_metric_buckets);
  const activities = context.recentActivities.map((activity): ActivitySummary => {
    const rows = rowsForActivity(activityBucketRows, activity);
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
  const recovery = estimateRecoveryScoreFromSleeps(latestSleep, completeRecentSleepCycles, context.latestStress);
  const recoveryValues = trendValues(recoveryTrend);

  return {
    stress: buildWellnessMetricSeries({
      title: 'Stress',
      unit: '',
      accent: 'alert',
      detail: 'Lower recent variability points to calmer load.',
      endDate: latestHeartDate,
      range,
      latest: recentStressValues[0] ?? null,
      average: weightedAverage(metrics.wellness_day_stats, 'stress_count', 'avg_stress'),
      count: sumCounts(metrics.wellness_day_stats, 'stress_count'),
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
      latest: recentSpo2Values[0] ?? null,
      average: weightedAverage(metrics.wellness_day_stats, 'spo2_count', 'avg_spo2'),
      count: sumCounts(metrics.wellness_day_stats, 'spo2_count'),
      recentValues: recentSpo2Values,
      valuesByDay: spo2ByDay,
    }),
    respiratoryRate: buildWellnessMetricSeries({
      title: 'Respiratory Rate',
      unit: 'br/min',
      accent: 'violet',
      detail: 'Breathing rate stayed inside your recent resting range.',
      digits: 1,
      endDate: latestHeartDate,
      range,
      latest: recentRespiratoryRateValues[0] ?? null,
      average: weightedAverage(metrics.wellness_day_stats, 'respiratory_rate_count', 'avg_respiratory_rate'),
      count: sumCounts(metrics.wellness_day_stats, 'respiratory_rate_count'),
      recentValues: recentRespiratoryRateValues,
      valuesByDay: respiratoryRateByDay,
    }),
    skinTemperature: buildWellnessMetricSeries({
      title: 'Skin Temperature',
      unit: '°C',
      accent: 'heart',
      detail: 'Night temperature stayed within baseline range.',
      digits: 1,
      endDate: latestHeartDate,
      range,
      latest: recentSkinTempValues[0] ?? null,
      average: weightedAverage(metrics.wellness_day_stats, 'skin_temp_count', 'avg_skin_temp'),
      count: sumCounts(metrics.wellness_day_stats, 'skin_temp_count'),
      recentValues: recentSkinTempValues,
      valuesByDay: skinTempByDay,
    }),
    recoveryIndex: {
      title: 'Recovery Index',
      latest: recovery.score,
      average: recoveryValues.length === 0 ? null : mean(recoveryValues),
      delta: recoveryValues.length < 2 ? null : recoveryValues.at(-1)! - recoveryValues.at(-2)!,
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
}

export async function fetchGraphQLWellnessData(
  db: SQLiteDatabase,
  range: HistoryRange,
): Promise<WellnessData> {
  const client = await getSQLiteApolloClient(db);
  const baselineResult = await client.query<WellnessBaselineData>({
    fetchPolicy: 'network-only',
    query: WELLNESS_BASELINE_QUERY,
    variables: { sleepLimit: rangeDays(range) },
  });
  const baselineContext = baselineResult.data ? buildBaselineContext(baselineResult.data) : null;
  const variables = baselineContext ? buildMetricVariables(baselineContext, range) : null;

  if (!baselineContext || !variables) {
    return emptyWellnessData();
  }

  const metricsResult = await client.query<WellnessMetricsData, WellnessMetricVariables>({
    fetchPolicy: 'network-only',
    query: WELLNESS_METRICS_QUERY,
    variables,
  });

  return metricsResult.data ? buildWellnessData(baselineContext, metricsResult.data, range) : emptyWellnessData();
}

export function useGraphQLWellnessData(range: HistoryRange, version: number): AsyncState<WellnessData> {
  const [retainedData, setRetainedData] = useState<WellnessData | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState(() => Date.now());
  const baselineQuery = useQuery<WellnessBaselineData>(WELLNESS_BASELINE_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    variables: { sleepLimit: rangeDays(range) },
  });
  const baselineContext = useMemo(
    () => (baselineQuery.data ? buildBaselineContext(baselineQuery.data) : null),
    [baselineQuery.data],
  );
  const metricVariables = useMemo(
    () => (baselineContext ? buildMetricVariables(baselineContext, range) : null),
    [baselineContext, range],
  );
  const metricsQuery = useQuery<WellnessMetricsData, WellnessMetricVariables>(
    WELLNESS_METRICS_QUERY,
    metricVariables
      ? {
          fetchPolicy: 'cache-and-network',
          notifyOnNetworkStatusChange: true,
          variables: metricVariables,
        }
      : skipToken,
  );

  useEffect(() => {
    setLoadStartedAt(Date.now());
    void baselineQuery.refetch({ sleepLimit: rangeDays(range) });
    if (metricVariables) {
      void metricsQuery.refetch(metricVariables);
    }
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, version]);

  useEffect(() => {
    if (!baselineContext) {
      return;
    }

    if (!baselineContext.latestHeartDate || baselineContext.dailyMinima.length === 0) {
      setRetainedData(emptyWellnessData());
    }
  }, [baselineContext]);

  useEffect(() => {
    const metrics = metricsQuery.data as WellnessMetricsData | undefined;
    if (!baselineContext || !metrics) {
      return;
    }

    try {
      const nextData = buildWellnessData(baselineContext, metrics, range);
      logMobilePerf('screen.wellness.graphql.load', loadStartedAt, {
        activities: nextData.activities.length,
        range,
      });
      setRetainedData(nextData);
    } catch (error) {
      logMobilePerfError('screen.wellness.graphql.load', error, { range });
    }
  }, [baselineContext, loadStartedAt, metricsQuery.data, range]);

  const error = baselineQuery.error ?? metricsQuery.error ?? null;

  if (error) {
    return { status: 'error', data: retainedData, error };
  }

  if (!retainedData) {
    return { status: 'loading', data: null, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}
