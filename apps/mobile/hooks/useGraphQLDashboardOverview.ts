import { gql } from '@apollo/client';
import { skipToken, useQuery } from '@apollo/client/react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';

import type { ActiveActivity, ManualActivityKind } from '@/data/HealthRepository';
import {
  activeActivityToRecord,
  buildDashboardDayState,
  buildDashboardInsights,
  buildDashboardSleepCardFromEnriched,
  buildEmptyHistoryOverview,
  buildEmptyTodayOverview,
  buildEnrichedSleepCycleBundle,
  buildHeartIntradayMarkers,
  buildSleepPlan,
  calculateStrainFromBucketRows,
  createTimeBuckets,
  dateFromDayKey,
  endOfDashboardDayWindow,
  estimateCaloriesFromBucketRows,
  estimateRecoveryScoreFromSleeps,
  fallbackEnrichedSleepCycle,
  inferTargetWakeMinutes,
  nextDayFromDayKey,
  normalizeSleepPreferences,
  personalizeMaxHrFromObservedPeak,
  personalizeRestingHr,
  startOfDayFromDayKey,
  summarizeBucketWindow,
  toActivityRecord,
  toHeartDayStatRecord,
  toSleepCycleRecord,
  toSleepStageRecord,
  type ActivityRecord,
  type ActivityRow,
  type HeartDayStatRecord,
  type HeartDayStatRow,
  type HeartIntradayBucketRow,
  type SleepCycleRecord,
  type SleepCycleRow,
  type SleepPreferenceRow,
  type SleepStageRow,
} from '@/data/sqlite/SQLiteHealthRepository';
import type {
  ActivitySummary,
  HistoryOverview,
  MetricSeries,
  StrainCardData,
  TodayOverview,
  TrendPoint,
} from '@/types/health';
import { getSQLiteApolloClient } from '@/services/graphql/sqliteApolloClient';
import {
  dateKey,
  formatAxisTime,
  formatClock,
  formatLongDate,
  formatSqliteDateTime,
  minutesBetween,
  parseSqliteDateTime,
  timeOfDayMinuteOffset,
} from '@/utils/dateTime';
import { describeRecovery } from '@/utils/formatters';
import { sanitizeRecordedBpm } from '@/utils/heartRate';
import { logMobilePerf, logMobilePerfError } from '@/utils/mobilePerf';

const HEART_INTRADAY_METRIC_KEY = 'heart_bpm';
const HEART_INTRADAY_BUCKET_MINUTES = 5;
const HEART_INTRADAY_BUCKET_SECONDS = HEART_INTRADAY_BUCKET_MINUTES * 60;
const DASHBOARD_LOOKBACK_DAYS = 45;
const NO_HISTORY_REASON = 'No local history yet. Sync the wearable from Settings to unlock this view.';
const LIMITED_LOAD_REASON = 'More heart data is needed before daily load can be estimated.';

const DASHBOARD_METADATA_QUERY = gql`
  query DashboardOverviewMetadata {
    heart_global_stats(limit: 1) {
      id
      observed_peak_bpm
      latest_heart_time
      latest_stress
    }
    latest_heart_rate: heart_rate(order_by: [{ time: desc }], limit: 1) {
      id
      time
      stress
    }
    heart_day_stats(order_by: [{ day: desc }], limit: 30) {
      day
      min_bpm
      avg_bpm
      max_bpm
      strain_score
    }
  }
`;

const DASHBOARD_DETAILS_QUERY = gql`
  query DashboardOverviewDetails(
    $bucketEnd: String!
    $bucketSeconds: Int!
    $bucketStart: String!
    $dayStart: String!
    $metricKey: String!
    $nextDay: String!
    $selectedDay: String!
    $stageStart: String!
  ) {
    heart_day_stats(
      where: { day: { _lte: $selectedDay } }
      order_by: [{ day: desc }]
      limit: 30
    ) {
      day
      min_bpm
      avg_bpm
      max_bpm
      strain_score
    }
    latest_before_day_end: heart_rate(
      where: { time: { _lt: $nextDay } }
      order_by: [{ time: desc }]
      limit: 1
    ) {
      id
      time
      stress
    }
    latest_in_day: heart_rate(
      where: { time: { _gte: $dayStart, _lt: $nextDay } }
      order_by: [{ time: desc }]
      limit: 1
    ) {
      id
      time
      stress
    }
    sleep_cycles(
      where: { end: { _lt: $nextDay } }
      order_by: [{ end: desc }]
      limit: 15
    ) {
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
    sleep_stage_segments(
      where: {
        start: { _gte: $stageStart }
        end: { _lt: $nextDay }
      }
      order_by: [{ start: asc }]
      limit: 10000
    ) {
      id
      sleep_id
      start
      end
      stage
      is_estimated
    }
    sleep_preferences(limit: 1) {
      id
      target_wake_minutes
      alarm_enabled
      alarm_minutes
      alarm_schedule_kind
      alarm_weekday_mask
      alarm_wake_mode
      alarm_one_off_at
    }
    nap_activities: activities(
      where: {
        activity: { _eq: "Nap" }
        start: { _gte: $stageStart }
        review_state: { _neq: "dismissed" }
      }
      order_by: [{ start: asc }]
      limit: 1000
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
    day_activities: activities(
      where: {
        start: { _gte: $dayStart, _lt: $nextDay }
        activity: { _neq: "Nap" }
        review_state: { _neq: "dismissed" }
      }
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
    marker_activities: activities(
      where: {
        start: { _lte: $nextDay }
        end: { _gte: $dayStart }
        review_state: { _neq: "dismissed" }
      }
      order_by: [{ start: asc }]
      limit: 1000
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
    active_activities(limit: 1) {
      id
      activity
      start
      created_at
      updated_at
    }
    intraday_metric_buckets(
      where: {
        metric_key: { _eq: $metricKey }
        bucket_seconds: { _eq: $bucketSeconds }
        bucket_start: { _gte: $bucketStart, _lte: $bucketEnd }
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
    heart_intraday_bucket_details(
      where: {
        bucket_seconds: { _eq: $bucketSeconds }
        bucket_start: { _gte: $bucketStart, _lte: $bucketEnd }
      }
      order_by: [{ bucket_start: asc }]
      limit: 10000
    ) {
      bucket_seconds
      bucket_start
      second_bpm
      penultimate_bpm
      max_triplet_avg
    }
  }
`;

interface DashboardMetadataData {
  heart_day_stats: HeartDayStatRow[];
  heart_global_stats: Array<{
    id: number;
    latest_heart_time: string | null;
    latest_stress: number | null;
    observed_peak_bpm: number | null;
  }>;
  latest_heart_rate: Array<{
    id: number;
    stress: number | null;
    time: string;
  }>;
}

interface DashboardDetailsData {
  active_activities: Array<{
    activity: string;
    created_at: string;
    id: number;
    start: string;
    updated_at: string;
  }>;
  day_activities: ActivityRow[];
  heart_day_stats: HeartDayStatRow[];
  heart_intraday_bucket_details: Array<{
    bucket_seconds: number;
    bucket_start: string;
    max_triplet_avg: number | null;
    penultimate_bpm: number | null;
    second_bpm: number | null;
  }>;
  intraday_metric_buckets: Array<{
    avg_value: number | null;
    bucket_seconds: number;
    bucket_start: string;
    first_value: number | null;
    last_value: number | null;
    metric_key: string;
    sample_count: number;
  }>;
  latest_before_day_end: Array<{
    id: number;
    stress: number | null;
    time: string;
  }>;
  latest_in_day: Array<{
    id: number;
    stress: number | null;
    time: string;
  }>;
  marker_activities: ActivityRow[];
  nap_activities: ActivityRow[];
  sleep_cycles: SleepCycleRow[];
  sleep_preferences: SleepPreferenceRow[];
  sleep_stage_segments: SleepStageRow[];
}

interface DashboardDetailsVariables {
  bucketEnd: string;
  bucketSeconds: number;
  bucketStart: string;
  dayStart: string;
  metricKey: string;
  nextDay: string;
  selectedDay: string;
  stageStart: string;
}

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function bucketStartForDate(date: Date, bucketSeconds = HEART_INTRADAY_BUCKET_SECONDS) {
  const bucketMs = bucketSeconds * 1000;
  return formatSqliteDateTime(new Date(Math.floor(date.getTime() / bucketMs) * bucketMs));
}

function latestHeartTime(metadata: DashboardMetadataData) {
  const globalTime = metadata.heart_global_stats[0]?.latest_heart_time ?? null;
  const latestRawTime = metadata.latest_heart_rate[0]?.time ?? null;

  return globalTime && latestRawTime
    ? globalTime > latestRawTime
      ? globalTime
      : latestRawTime
    : globalTime ?? latestRawTime;
}

function availableDayKeys(metadata: DashboardMetadataData) {
  return metadata.heart_day_stats.map((row) => row.day).reverse();
}

function resolveSelectedDay(metadata: DashboardMetadataData, requestedDayKey: string | null) {
  const available = availableDayKeys(metadata);
  if (requestedDayKey) {
    return available.includes(requestedDayKey) ? requestedDayKey : available.at(-1) ?? requestedDayKey;
  }

  const latestTime = latestHeartTime(metadata);
  return latestTime ? dateKey(parseSqliteDateTime(latestTime)) : dateKey(new Date());
}

function buildDetailsVariables(metadata: DashboardMetadataData, selectedDayKey: string): DashboardDetailsVariables | null {
  if (!latestHeartTime(metadata) && metadata.heart_day_stats.length === 0) {
    return null;
  }

  const dayStart = startOfDayFromDayKey(selectedDayKey);
  const nextDay = nextDayFromDayKey(selectedDayKey);
  const stageStart = new Date(dayStart.getTime() - DASHBOARD_LOOKBACK_DAYS * 24 * 3_600_000);

  return {
    bucketEnd: bucketStartForDate(nextDay),
    bucketSeconds: HEART_INTRADAY_BUCKET_SECONDS,
    bucketStart: bucketStartForDate(dayStart),
    dayStart: formatSqliteDateTime(dayStart),
    metricKey: HEART_INTRADAY_METRIC_KEY,
    nextDay: formatSqliteDateTime(nextDay),
    selectedDay: selectedDayKey,
    stageStart: formatSqliteDateTime(stageStart),
  };
}

function normalizeActivityKind(value: string): ManualActivityKind {
  if (value === 'Nap' || value === 'Walk' || value === 'Workout' || value === 'Running') {
    return value;
  }

  return 'Activity';
}

function buildActiveActivityRecord(
  rows: DashboardDetailsData['active_activities'],
  windowStart: Date,
  windowEnd: Date,
) {
  const row = rows[0];
  if (!row) {
    return null;
  }

  const start = parseSqliteDateTime(row.start);
  const end = new Date(Math.max(windowEnd.getTime(), Date.now()));
  if (start.getTime() > windowEnd.getTime() || end.getTime() < windowStart.getTime()) {
    return null;
  }

  const activity: ActiveActivity = {
    id: `active-${row.id}`,
    activity: normalizeActivityKind(row.activity),
    start,
    elapsedMinutes: Math.max(0, Math.round((Date.now() - start.getTime()) / 60_000)),
  };

  return activeActivityToRecord(activity, end);
}

function buildBucketRows(data: DashboardDetailsData): HeartIntradayBucketRow[] {
  const detailsByBucket = new Map(
    data.heart_intraday_bucket_details.map((row) => [row.bucket_start, row]),
  );

  return data.intraday_metric_buckets.flatMap((bucket) => {
    if (
      bucket.sample_count <= 0 ||
      bucket.avg_value === null ||
      bucket.first_value === null ||
      bucket.last_value === null
    ) {
      return [];
    }

    const details = detailsByBucket.get(bucket.bucket_start);

    return [{
      bucket_start: bucket.bucket_start,
      sample_count: bucket.sample_count,
      avg_bpm: bucket.avg_value,
      first_bpm: bucket.first_value,
      second_bpm: details?.second_bpm ?? null,
      penultimate_bpm: details?.penultimate_bpm ?? null,
      last_bpm: bucket.last_value,
      max_triplet_avg: details?.max_triplet_avg ?? null,
    }];
  });
}

function trendValues(points: TrendPoint[]): number[] {
  return points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
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

function buildCumulativeBucketStrainSeries(
  rows: readonly HeartIntradayBucketRow[],
  startDate: Date,
  endDate: Date,
  maxHr: number,
  restingHr: number,
): TrendPoint[] {
  if (endDate.getTime() < startDate.getTime()) {
    return [];
  }

  const bucketMs = HEART_INTRADAY_BUCKET_MINUTES * 60_000;
  const firstBucket = Math.floor(startDate.getTime() / bucketMs) * bucketMs;
  const lastBucket = Math.floor(endDate.getTime() / bucketMs) * bucketMs;
  const rowsByBucket = new Map(rows.map((row) => [row.bucket_start, row]));
  let cumulativeTrimp = 0;
  let cumulativeSamples = 0;
  const reserve = maxHr - restingHr;

  return Array.from(
    { length: Math.max(0, Math.floor((lastBucket - firstBucket) / bucketMs) + 1) },
    (_, index) => {
      const bucketDate = new Date(firstBucket + index * bucketMs);
      const row = rowsByBucket.get(formatSqliteDateTime(bucketDate));

      if (row && reserve > 0) {
        const bpm = sanitizeRecordedBpm(Math.round(row.avg_bpm));
        if (bpm !== null) {
          cumulativeTrimp += row.sample_count * (1 / 60) * zoneWeight(bpm, restingHr, reserve);
          cumulativeSamples += row.sample_count;
        }
      }

      return {
        label: formatAxisTime(bucketDate),
        minuteOffset: timeOfDayMinuteOffset(bucketDate),
        value: cumulativeSamples < 600 || reserve <= 0 ? null : strainScoreFromTrimp(cumulativeTrimp),
      };
    },
  );
}

function rowsForActivity(rows: readonly HeartIntradayBucketRow[], activity: ActivityRecord) {
  const startBucket = bucketStartForDate(activity.start);
  const endBucket = bucketStartForDate(activity.end);

  return rows.filter((row) => row.bucket_start >= startBucket && row.bucket_start <= endBucket);
}

function buildActivitySummary(
  activities: readonly ActivityRecord[],
  bucketRows: readonly HeartIntradayBucketRow[],
  maxHr: number,
  restingHr: number,
): ActivitySummary[] {
  return [...activities]
    .sort((left, right) => right.start.getTime() - left.start.getTime())
    .slice(0, 5)
    .map((activity): ActivitySummary => {
      const rows = rowsForActivity(bucketRows, activity);
      const durationMinutes = minutesBetween(activity.start, activity.end);

      return {
        id: activity.id,
        title: activity.activity,
        timeLabel: activity.isInProgress ? `${formatClock(activity.start)} - now` : formatClock(activity.start),
        durationMinutes,
        strain: calculateStrainFromBucketRows(rows, maxHr, restingHr, durationMinutes),
        calories: estimateCaloriesFromBucketRows(rows, maxHr, restingHr, durationMinutes),
        isEstimated: true,
        isInProgress: activity.isInProgress,
        confidence: activity.confidence,
        source: activity.source,
        reviewState: activity.reviewState,
        strainLabel: activity.isInProgress ? 'Live strain estimate' : 'Estimated strain',
        caloriesLabel: activity.isInProgress ? 'Live calories estimate' : 'Estimated calories',
      };
    });
}

function stressMetric(latestStress: number | null): MetricSeries {
  return {
    title: 'Stress',
    latest: latestStress,
    average: latestStress,
    delta: null,
    unit: '',
    detail: latestStress === null ? NO_HISTORY_REASON : 'Stress drift across the selected day.',
    accent: 'alert',
    series: [],
    missingReason: latestStress === null ? NO_HISTORY_REASON : null,
  };
}

function selectedSleepForDay(sleeps: readonly SleepCycleRecord[], selectedDayKey: string) {
  const dayStart = startOfDayFromDayKey(selectedDayKey);
  const nextDay = nextDayFromDayKey(selectedDayKey);

  return [...sleeps]
    .reverse()
    .find((sleep) => sleep.end >= dayStart && sleep.end < nextDay) ?? null;
}

function buildOverviewBase(
  metadata: DashboardMetadataData,
  details: DashboardDetailsData,
  selectedDayKey: string,
) {
  const now = new Date();
  const selectedDate = dateFromDayKey(selectedDayKey);
  const selectedDayStart = startOfDayFromDayKey(selectedDayKey);
  const selectedDayLatestHeartDate = details.latest_in_day[0]?.time
    ? parseSqliteDateTime(details.latest_in_day[0].time)
    : null;
  const availableDays = availableDayKeys(metadata);
  const day = buildDashboardDayState(
    selectedDayKey,
    availableDays.includes(selectedDayKey) ? availableDays : [...availableDays, selectedDayKey],
  );
  const selectedDayEnd = endOfDashboardDayWindow(selectedDayKey, day.isToday, selectedDayLatestHeartDate);
  const sleepCycles = details.sleep_cycles.map(toSleepCycleRecord).reverse();
  const stageRecords = details.sleep_stage_segments.map(toSleepStageRecord);
  const napActivities = details.nap_activities.map(toActivityRecord);
  const enrichedSleep = buildEnrichedSleepCycleBundle(sleepCycles, stageRecords, napActivities);
  const completeSleeps = enrichedSleep.completeSleeps;
  const rawSelectedSleep = selectedSleepForDay(sleepCycles, selectedDayKey);
  const selectedSleepEntry = rawSelectedSleep
    ? enrichedSleep.bySleepId.get(rawSelectedSleep.sleepId) ?? fallbackEnrichedSleepCycle(rawSelectedSleep)
    : null;
  const selectedSleep = selectedSleepEntry?.sleep ?? null;
  const selectedCompleteSleep =
    selectedSleep && selectedSleep.completionStatus === 'complete'
      ? selectedSleep
      : completeSleeps.at(-1) ?? null;
  const heartDayStats = details.heart_day_stats.map(toHeartDayStatRecord).reverse();
  const dailyMinima = heartDayStats.map((stat) => stat.minBpm);
  const restingHr = personalizeRestingHr(completeSleeps, dailyMinima);
  const maxHr = personalizeMaxHrFromObservedPeak(metadata.heart_global_stats[0]?.observed_peak_bpm ?? null, restingHr);
  const bucketRows = buildBucketRows(details);
  const bucketWindow = summarizeBucketWindow(bucketRows);
  const markerActivities = details.marker_activities.map(toActivityRecord);
  const activeActivity = buildActiveActivityRecord(details.active_activities, selectedDayStart, selectedDayEnd);
  const dayActivities = details.day_activities.map(toActivityRecord);
  const summaryActivities = activeActivity
    ? [activeActivity, ...dayActivities].sort((left, right) => right.start.getTime() - left.start.getTime())
    : dayActivities;
  const activitySummary = buildActivitySummary(summaryActivities, bucketRows, maxHr, restingHr);
  const dayStatsByDay = new Map<string, HeartDayStatRecord>(heartDayStats.map((stat) => [stat.day, stat]));
  const selectedStrain = dayStatsByDay.get(selectedDayKey)?.strainScore ?? null;
  const strainSeries = buildCumulativeBucketStrainSeries(bucketRows, selectedDayStart, selectedDayEnd, maxHr, restingHr);
  const strainValues = trendValues(strainSeries);
  const resolvedStrain = strainValues.at(-1) ?? selectedStrain;
  const strainMissingReason =
    strainValues.length === 0
      ? bucketRows.length > 0
        ? LIMITED_LOAD_REASON
        : NO_HISTORY_REASON
      : null;
  const strainCard: StrainCardData = {
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
  };
  const latestStress = details.latest_before_day_end[0]?.stress ?? metadata.heart_global_stats[0]?.latest_stress ?? null;
  const recovery = estimateRecoveryScoreFromSleeps(selectedCompleteSleep, completeSleeps, latestStress);
  const sleepCard = buildDashboardSleepCardFromEnriched(selectedSleepEntry);
  const stressCard = stressMetric(latestStress);

  return {
    activitySummary,
    bucketRows,
    bucketWindow,
    completeSleeps,
    day,
    enrichedSleep,
    heartDayStats,
    latestStress,
    markerActivities,
    maxHr,
    now,
    recovery,
    restingHr,
    selectedCompleteSleep,
    selectedDate,
    selectedDayEnd,
    selectedDayStart,
    selectedSleep,
    selectedSleepEntry,
    sleepCard,
    strainCard,
    stressCard,
  };
}

function buildHistoryOverview(
  metadata: DashboardMetadataData,
  details: DashboardDetailsData,
  selectedDayKey: string,
): HistoryOverview {
  const base = buildOverviewBase(metadata, details, selectedDayKey);
  const heartCardSeries = base.bucketWindow.bucketSamples.length > 0
    ? createTimeBuckets(
        base.bucketWindow.bucketSamples,
        HEART_INTRADAY_BUCKET_MINUTES,
        base.selectedDayStart,
        base.selectedDayEnd,
      )
    : [];
  const heartCardMarkers = buildHeartIntradayMarkers(
    base.selectedDayStart,
    base.selectedDayEnd,
    base.selectedSleep ? [base.selectedSleep] : [],
    base.markerActivities,
    base.selectedSleep
      ? new Map([
          [
            base.selectedSleep.sleepId,
            base.selectedSleepEntry
              ? {
                  durationMinutes: base.selectedSleepEntry.summary.timeInBedMinutes,
                  completionStatus: base.selectedSleep.completionStatus,
                  isInProgress: base.selectedSleep.isInProgress,
                  score: base.selectedSleep.score,
                  asleepMinutes: base.selectedSleepEntry.summary.timeAsleepMinutes,
                  timeInBedMinutes: base.selectedSleepEntry.summary.timeInBedMinutes,
                  remMinutes: base.selectedSleepEntry.summary.remMinutes,
                  deepMinutes: base.selectedSleepEntry.summary.deepMinutes,
                  stages: base.selectedSleepEntry.summary.stages,
                }
              : { durationMinutes: minutesBetween(base.selectedSleep.start, base.selectedSleep.end) },
          ],
        ])
      : undefined,
    base.selectedSleepEntry
      ? new Map([[base.selectedSleepEntry.sleep.sleepId, base.selectedSleepEntry.summary]])
      : undefined,
  );

  return {
    dateLabel: formatLongDate(base.selectedDate),
    day: base.day,
    recovery: {
      score: base.recovery.score,
      label: describeRecovery(base.recovery.score),
      caption: 'Recovery',
      isEstimated: true,
      missingReason: base.recovery.missingReason,
      breakdown: base.recovery.breakdown,
    },
    heartCard: {
      restingHr: base.restingHr,
      averageHr: base.bucketWindow.averageBpm,
      maxHr: base.bucketWindow.sustainedPeakBpm,
      pointIntervalMinutes: HEART_INTRADAY_BUCKET_MINUTES,
      series: heartCardSeries,
      markers: heartCardMarkers,
      missingReason: heartCardSeries.length === 0 ? NO_HISTORY_REASON : null,
    },
    sleepCard: base.sleepCard,
    strainCard: base.strainCard,
    activitySummary: base.activitySummary,
    insights: buildDashboardInsights({
      recoveryScore: base.recovery.score,
      sleepCard: base.sleepCard,
      selectedStrain: base.strainCard.score,
      stressCard: base.stressCard,
      activities: base.activitySummary,
    }),
  };
}

function buildTodayOverview(
  metadata: DashboardMetadataData,
  details: DashboardDetailsData,
  selectedDayKey: string,
): TodayOverview {
  const base = buildOverviewBase(metadata, details, selectedDayKey);
  const latestSleepEntry = base.enrichedSleep.cycles.at(-1) ?? null;
  const latestCompleteSleep = base.completeSleeps.at(-1) ?? null;
  const preferences = normalizeSleepPreferences(
    details.sleep_preferences[0] ?? null,
    inferTargetWakeMinutes(base.completeSleeps),
  );
  const planNapActivities = latestCompleteSleep
    ? details.nap_activities.map(toActivityRecord).filter((activity) => activity.start >= latestCompleteSleep.end)
    : [];

  return {
    greeting: base.day.isToday ? (base.now.getHours() < 12 ? 'Good morning' : base.now.getHours() < 18 ? 'Good afternoon' : 'Good evening') : 'Overview',
    dateLabel: formatLongDate(parseSqliteDateTime(latestHeartTime(metadata) ?? formatSqliteDateTime(base.now))),
    day: base.day,
    recovery: {
      score: base.recovery.score,
      label: describeRecovery(base.recovery.score),
      caption: 'Recovery',
      isEstimated: true,
      missingReason: base.recovery.missingReason,
      breakdown: base.recovery.breakdown,
    },
    tonightPlan: buildSleepPlan(preferences, base.enrichedSleep.sleeps, planNapActivities),
    sleepCard: buildDashboardSleepCardFromEnriched(latestSleepEntry),
    strainCard: base.strainCard,
    activitySummary: base.activitySummary,
    insights: buildDashboardInsights({
      recoveryScore: base.recovery.score,
      sleepCard: buildDashboardSleepCardFromEnriched(latestSleepEntry),
      selectedStrain: base.strainCard.score,
      stressCard: base.stressCard,
      activities: base.activitySummary,
    }),
  };
}

function useDashboardOverviewDetails(selectedDayKey: string | null, metadata: DashboardMetadataData | undefined) {
  const variables = useMemo(
    () => (metadata && selectedDayKey ? buildDetailsVariables(metadata, selectedDayKey) : null),
    [metadata, selectedDayKey],
  );

  const query = useQuery<DashboardDetailsData, DashboardDetailsVariables>(
    DASHBOARD_DETAILS_QUERY,
    variables
      ? {
          fetchPolicy: 'cache-and-network',
          notifyOnNetworkStatusChange: true,
          variables,
        }
      : skipToken,
  );

  return { query, variables };
}

async function fetchDashboardDetails(
  db: SQLiteDatabase,
  requestedDayKey: string | null,
) {
  const client = await getSQLiteApolloClient(db);
  const metadataResult = await client.query<DashboardMetadataData>({
    fetchPolicy: 'network-only',
    query: DASHBOARD_METADATA_QUERY,
  });
  const metadata = metadataResult.data;

  if (!metadata || !latestHeartTime(metadata)) {
    return null;
  }

  const selectedDayKey = resolveSelectedDay(metadata, requestedDayKey);
  const variables = buildDetailsVariables(metadata, selectedDayKey);
  if (!variables) {
    return null;
  }

  const detailsResult = await client.query<DashboardDetailsData, DashboardDetailsVariables>({
    fetchPolicy: 'network-only',
    query: DASHBOARD_DETAILS_QUERY,
    variables,
  });

  return detailsResult.data ? { details: detailsResult.data, metadata, selectedDayKey } : null;
}

export async function fetchGraphQLTodayOverview(db: SQLiteDatabase): Promise<TodayOverview> {
  const result = await fetchDashboardDetails(db, null);
  return result
    ? buildTodayOverview(result.metadata, result.details, result.selectedDayKey)
    : buildEmptyTodayOverview(new Date(), null);
}

export async function fetchGraphQLHistoryOverview(
  db: SQLiteDatabase,
  dayKey: string,
): Promise<HistoryOverview> {
  const result = await fetchDashboardDetails(db, dayKey);
  return result
    ? buildHistoryOverview(result.metadata, result.details, result.selectedDayKey)
    : buildEmptyHistoryOverview(new Date());
}

export function useGraphQLTodayOverview(version: number): AsyncState<TodayOverview> {
  const [retainedData, setRetainedData] = useState<TodayOverview | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState(() => Date.now());
  const metadataQuery = useQuery<DashboardMetadataData>(DASHBOARD_METADATA_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });
  const selectedDayKey = useMemo(
    () => (metadataQuery.data ? resolveSelectedDay(metadataQuery.data, null) : null),
    [metadataQuery.data],
  );
  const { query: detailsQuery, variables } = useDashboardOverviewDetails(selectedDayKey, metadataQuery.data);

  useEffect(() => {
    setLoadStartedAt(Date.now());
    void metadataQuery.refetch();
    if (variables) {
      void detailsQuery.refetch(variables);
    }
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    if (metadataQuery.data && !latestHeartTime(metadataQuery.data)) {
      setRetainedData(buildEmptyTodayOverview(new Date(), null));
    }
  }, [metadataQuery.data]);

  useEffect(() => {
    if (!metadataQuery.data || !detailsQuery.data || !selectedDayKey) {
      return;
    }

    try {
      const overview = buildTodayOverview(metadataQuery.data, detailsQuery.data, selectedDayKey);
      logMobilePerf('screen.today.overview.graphql.load', loadStartedAt, {
        activities: overview.activitySummary.length,
        day: overview.day.dayKey,
        insights: overview.insights.length,
      });
      setRetainedData(overview);
    } catch (error) {
      logMobilePerfError('screen.today.overview.graphql.load', error);
    }
  }, [detailsQuery.data, loadStartedAt, metadataQuery.data, selectedDayKey]);

  const error = metadataQuery.error ?? detailsQuery.error ?? null;
  if (error) {
    return { status: 'error', data: retainedData, error };
  }

  if (!retainedData) {
    return { status: 'loading', data: null, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}

export function useGraphQLHistoryOverview(dayKey: string, version: number): AsyncState<HistoryOverview> {
  const [retainedData, setRetainedData] = useState<HistoryOverview | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState(() => Date.now());
  const metadataQuery = useQuery<DashboardMetadataData>(DASHBOARD_METADATA_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });
  const selectedDayKey = useMemo(
    () => (metadataQuery.data ? resolveSelectedDay(metadataQuery.data, dayKey) : null),
    [dayKey, metadataQuery.data],
  );
  const { query: detailsQuery, variables } = useDashboardOverviewDetails(selectedDayKey, metadataQuery.data);

  useEffect(() => {
    setLoadStartedAt(Date.now());
    void metadataQuery.refetch();
    if (variables) {
      void detailsQuery.refetch(variables);
    }
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey, version]);

  useEffect(() => {
    if (metadataQuery.data && !latestHeartTime(metadataQuery.data)) {
      setRetainedData(buildEmptyHistoryOverview(new Date()));
    }
  }, [metadataQuery.data]);

  useEffect(() => {
    if (!metadataQuery.data || !detailsQuery.data || !selectedDayKey) {
      return;
    }

    try {
      const overview = buildHistoryOverview(metadataQuery.data, detailsQuery.data, selectedDayKey);
      logMobilePerf('screen.history.overview.graphql.load', loadStartedAt, {
        day: overview.day.dayKey,
        markers: overview.heartCard.markers.length,
        points: overview.heartCard.series.length,
      });
      setRetainedData(overview);
    } catch (error) {
      logMobilePerfError('screen.history.overview.graphql.load', error, { dayKey });
    }
  }, [dayKey, detailsQuery.data, loadStartedAt, metadataQuery.data, selectedDayKey]);

  const error = metadataQuery.error ?? detailsQuery.error ?? null;
  if (error) {
    return { status: 'error', data: retainedData, error };
  }

  if (!retainedData) {
    return { status: 'loading', data: null, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}
