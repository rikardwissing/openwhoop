import { gql } from '@apollo/client';
import { skipToken, useQuery } from '@apollo/client/react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';

import {
  buildEnrichedSleepCycleBundle,
  buildFilledDailySeries,
  buildHeartIntradayMarkers,
  buildHeartMarkerSleepDetailsFromEnriched,
  createTimeBuckets,
  personalizeRestingHr,
  rangeDays,
  summarizeBucketWindow,
  toActivityRecord,
  toSleepCycleRecord,
  toSleepStageRecord,
  type ActivityRow,
  type HeartIntradayBucketRow,
  type SleepCycleRow,
  type SleepStageRow,
} from '@/data/sqlite/SQLiteHealthRepository';
import { getSQLiteApolloClient } from '@/services/graphql/sqliteApolloClient';
import type { HeartHistoryData, HistoryRange, TrendPoint } from '@/types/health';
import { formatSqliteDateTime, parseSqliteDateTime } from '@/utils/dateTime';
import { sanitizeRecordedBpm } from '@/utils/heartRate';
import { median } from '@/utils/math';
import { logMobilePerf, logMobilePerfError } from '@/utils/mobilePerf';

const HEART_INTRADAY_METRIC_KEY = 'heart_bpm';
const HEART_INTRADAY_BUCKET_MINUTES = 5;
const HEART_INTRADAY_BUCKET_SECONDS = HEART_INTRADAY_BUCKET_MINUTES * 60;
const HEART_HISTORY_SLEEP_LOOKBACK_DAYS = 14;
const NO_HISTORY_REASON = 'No local history yet. Sync the wearable from Settings to unlock this view.';

const HEART_HISTORY_METADATA_QUERY = gql`
  query HeartHistoryMetadata($dailyLimit: Int!) {
    heart_global_stats(limit: 1) {
      id
      latest_heart_time
    }
    heart_day_stats(order_by: [{ day: asc }], limit: $dailyLimit) {
      day
      min_bpm
    }
  }
`;

const HEART_HISTORY_WINDOW_QUERY = gql`
  query HeartHistoryWindow(
    $activitiesEnd: String!
    $activitiesStart: String!
    $bucketSeconds: Int!
    $endBucket: String!
    $historyStart: String!
    $metricKey: String!
    $startBucket: String!
  ) {
    intraday_metric_buckets(
      where: {
        metric_key: { _eq: $metricKey }
        bucket_seconds: { _eq: $bucketSeconds }
        bucket_start: { _gte: $startBucket, _lte: $endBucket }
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
        bucket_start: { _gte: $startBucket, _lte: $endBucket }
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
    sleep_cycles(
      order_by: [{ start: desc }]
      limit: 14
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
        start: { _lte: $activitiesEnd }
        end: { _gte: $historyStart }
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
    activities(
      where: {
        start: { _lte: $activitiesEnd }
        end: { _gte: $activitiesStart }
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
  }
`;

interface HeartHistoryMetadataData {
  heart_day_stats: Array<{
    day: string;
    min_bpm: number;
  }>;
  heart_global_stats: Array<{
    id: number;
    latest_heart_time: string | null;
  }>;
}

interface HeartHistoryWindowData {
  activities: ActivityRow[];
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
  sleep_cycles: SleepCycleRow[];
  sleep_stage_segments: SleepStageRow[];
}

interface HeartHistoryWindowVariables {
  activitiesEnd: string;
  activitiesStart: string;
  bucketSeconds: number;
  endBucket: string;
  historyStart: string;
  metricKey: string;
  startBucket: string;
}

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function bucketStartForDate(date: Date, bucketSeconds = HEART_INTRADAY_BUCKET_SECONDS) {
  const bucketMs = bucketSeconds * 1000;
  return formatSqliteDateTime(new Date(Math.floor(date.getTime() / bucketMs) * bucketMs));
}

function trendValues(points: TrendPoint[]): number[] {
  return points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
}

function emptyHeartHistory(): HeartHistoryData {
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

function buildBucketRows(data: HeartHistoryWindowData): HeartIntradayBucketRow[] {
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

function buildHeartHistory(
  metadata: HeartHistoryMetadataData,
  data: HeartHistoryWindowData,
  latestHeartTime: string,
  range: HistoryRange,
): HeartHistoryData {
  const latestHeartDate = parseSqliteDateTime(latestHeartTime);
  const intradayStart = new Date(latestHeartDate.getTime() - 24 * 3_600_000);
  const bucketWindow = summarizeBucketWindow(buildBucketRows(data));
  const sleepCycles = data.sleep_cycles.map(toSleepCycleRecord).reverse();
  const stageRecords = data.sleep_stage_segments.map(toSleepStageRecord);
  const enrichedSleep = buildEnrichedSleepCycleBundle(sleepCycles, stageRecords, []);
  const sleepDetails = buildHeartMarkerSleepDetailsFromEnriched(enrichedSleep.cycles);
  const activities = data.activities.map(toActivityRecord);
  const sanitizedDailyMinimaRows = metadata.heart_day_stats.map((row) => ({
    day: row.day,
    min_bpm: sanitizeRecordedBpm(row.min_bpm),
  }));
  const dailyMinima = sanitizedDailyMinimaRows
    .map((row) => row.min_bpm)
    .filter((value): value is number => value !== null);

  if (dailyMinima.length === 0) {
    return emptyHeartHistory();
  }

  const restingHr = personalizeRestingHr(enrichedSleep.completeSleeps, dailyMinima);
  const dailyMinimaByDay = new Map(sanitizedDailyMinimaRows.map((row) => [row.day, row.min_bpm]));
  const weeklyResting = buildFilledDailySeries(range, latestHeartDate, (day) => dailyMinimaByDay.get(day) ?? null);
  const previousMedian = median(trendValues(weeklyResting.slice(0, -1)));
  const intraday = createTimeBuckets(
    bucketWindow.bucketSamples,
    HEART_INTRADAY_BUCKET_MINUTES,
    intradayStart,
    latestHeartDate,
  );

  return {
    restingHr,
    averageHr: bucketWindow.averageBpm,
    maxHr: bucketWindow.sustainedPeakBpm,
    intraday,
    intradayMarkers: buildHeartIntradayMarkers(
      intradayStart,
      latestHeartDate,
      enrichedSleep.sleeps,
      activities,
      sleepDetails,
      enrichedSleep.summariesBySleepId,
    ),
    weeklyResting,
    recoveryShift: previousMedian === null ? null : restingHr - previousMedian,
    missingReason: intraday.length === 0 ? NO_HISTORY_REASON : null,
  };
}

function buildWindowVariables(latestHeartTime: string | null | undefined): HeartHistoryWindowVariables | null {
  if (!latestHeartTime) {
    return null;
  }

  const latestHeartDate = parseSqliteDateTime(latestHeartTime);
  const intradayStart = new Date(latestHeartDate.getTime() - 24 * 3_600_000);
  const historyStart = new Date(latestHeartDate.getTime() - HEART_HISTORY_SLEEP_LOOKBACK_DAYS * 24 * 3_600_000);

  return {
    activitiesEnd: latestHeartTime,
    activitiesStart: formatSqliteDateTime(intradayStart),
    bucketSeconds: HEART_INTRADAY_BUCKET_SECONDS,
    endBucket: bucketStartForDate(latestHeartDate),
    historyStart: formatSqliteDateTime(historyStart),
    metricKey: HEART_INTRADAY_METRIC_KEY,
    startBucket: bucketStartForDate(intradayStart),
  };
}

export async function fetchGraphQLHeartHistory(
  db: SQLiteDatabase,
  range: HistoryRange,
): Promise<HeartHistoryData> {
  const client = await getSQLiteApolloClient(db);
  const metadataResult = await client.query<HeartHistoryMetadataData>({
    fetchPolicy: 'network-only',
    query: HEART_HISTORY_METADATA_QUERY,
    variables: { dailyLimit: 10_000 },
  });
  const metadata = metadataResult.data;
  const latestHeartTime = metadata?.heart_global_stats[0]?.latest_heart_time ?? null;
  const variables = buildWindowVariables(latestHeartTime);

  if (!metadata || !latestHeartTime || !variables) {
    return emptyHeartHistory();
  }

  const windowResult = await client.query<HeartHistoryWindowData, HeartHistoryWindowVariables>({
    fetchPolicy: 'network-only',
    query: HEART_HISTORY_WINDOW_QUERY,
    variables,
  });

  return windowResult.data ? buildHeartHistory(metadata, windowResult.data, latestHeartTime, range) : emptyHeartHistory();
}

export function useGraphQLHeartHistory(range: HistoryRange, version: number): AsyncState<HeartHistoryData> {
  const [retainedData, setRetainedData] = useState<HeartHistoryData | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState(() => Date.now());
  const metadataQuery = useQuery<HeartHistoryMetadataData>(HEART_HISTORY_METADATA_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    variables: { dailyLimit: 10_000 },
  });
  const latestHeartTime = metadataQuery.data?.heart_global_stats[0]?.latest_heart_time ?? null;
  const windowVariables = useMemo(
    () => buildWindowVariables(latestHeartTime),
    [latestHeartTime],
  );
  const windowQuery = useQuery<HeartHistoryWindowData, HeartHistoryWindowVariables>(
    HEART_HISTORY_WINDOW_QUERY,
    windowVariables
      ? {
          fetchPolicy: 'cache-and-network',
          notifyOnNetworkStatusChange: true,
          variables: windowVariables,
        }
      : skipToken,
  );

  useEffect(() => {
    setLoadStartedAt(Date.now());
    void metadataQuery.refetch();
    if (windowVariables) {
      void windowQuery.refetch(windowVariables);
    }
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, version]);

  useEffect(() => {
    if (metadataQuery.data && !latestHeartTime) {
      setRetainedData(emptyHeartHistory());
    }
  }, [latestHeartTime, metadataQuery.data]);

  useEffect(() => {
    const metadata = metadataQuery.data as HeartHistoryMetadataData | undefined;
    const window = windowQuery.data as HeartHistoryWindowData | undefined;

    if (!metadata || !window || !latestHeartTime) {
      return;
    }

    try {
      const nextData = buildHeartHistory(metadata, window, latestHeartTime, range);
      logMobilePerf('screen.heart.graphql.load', loadStartedAt, {
        intradayPoints: nextData.intraday.length,
        markers: nextData.intradayMarkers.length,
        range,
      });
      setRetainedData(nextData);
    } catch (error) {
      logMobilePerfError('screen.heart.graphql.load', error, { range });
    }
  }, [latestHeartTime, loadStartedAt, metadataQuery.data, range, windowQuery.data]);

  const error = metadataQuery.error ?? windowQuery.error ?? null;

  if (error) {
    return { status: 'error', data: retainedData, error };
  }

  if (!retainedData) {
    return { status: 'loading', data: null, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}
