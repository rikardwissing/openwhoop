import { gql } from '@apollo/client';
import { skipToken, useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';

import {
  activeActivityToRecord,
  buildEnrichedSleepCycleBundle,
  buildHeartIntradayMarkers,
  buildHeartMarkerSleepDetailsFromEnriched,
  personalizeRestingHr,
  summarizeBucketWindow,
  toActivityRecord,
  toSleepCycleRecord,
  toSleepStageRecord,
  type ActivityRow,
  type HeartIntradayBucketRow,
  type SleepCycleRow,
  type SleepStageRow,
} from '@/data/sqlite/SQLiteHealthRepository';
import type { ActiveActivity, ManualActivityKind } from '@/data/HealthRepository';
import type { HeartTimelineWindow, HistoryRange } from '@/types/health';
import { formatSqliteDateTime, parseSqliteDateTime } from '@/utils/dateTime';
import { sanitizeRecordedBpm } from '@/utils/heartRate';
import { logMobilePerf, logMobilePerfError } from '@/utils/mobilePerf';

const HEART_INTRADAY_METRIC_KEY = 'heart_bpm';
const HEART_INTRADAY_BUCKET_SECONDS = 5 * 60;
const HEART_HISTORY_LOOKBACK_DAYS = 14;
const NO_HISTORY_REASON = 'No local history yet. Sync the wearable from Settings to unlock this view.';

const HEART_GRAPH_METADATA_QUERY = gql`
  query HeartGraphMetadata($dailyLimit: Int!) {
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

const HEART_GRAPH_WINDOW_QUERY = gql`
  query HeartGraphWindow(
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
      where: {
        start: { _lte: $activitiesEnd }
        end: { _gte: $historyStart }
      }
      order_by: [{ start: asc }]
      limit: 1000
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
    active_activities(limit: 1) {
      id
      activity
      start
      created_at
      updated_at
    }
  }
`;

interface HeartGraphMetadataData {
  heart_day_stats: Array<{
    day: string;
    min_bpm: number;
  }>;
  heart_global_stats: Array<{
    id: number;
    latest_heart_time: string | null;
  }>;
}

interface HeartGraphWindowData {
  active_activities: Array<{
    activity: string;
    created_at: string;
    id: number;
    start: string;
    updated_at: string;
  }>;
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

interface HeartGraphWindowVariables {
  activitiesEnd: string;
  activitiesStart: string;
  bucketSeconds: number;
  endBucket: string;
  historyStart: string;
  metricKey: string;
  startBucket: string;
}

interface HeartTimelineState {
  error: Error | null;
  isRefreshing: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  window: HeartTimelineWindow | null;
}

function rangeDays(range: HistoryRange) {
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

function bucketStartForDate(date: Date, bucketSeconds = HEART_INTRADAY_BUCKET_SECONDS) {
  const bucketMs = bucketSeconds * 1000;
  return formatSqliteDateTime(new Date(Math.floor(date.getTime() / bucketMs) * bucketMs));
}

function normalizeActivityKind(value: string): ManualActivityKind {
  if (value === 'Nap' || value === 'Walk' || value === 'Workout' || value === 'Running') {
    return value;
  }

  return 'Activity';
}

function emptyHeartTimelineWindow(): HeartTimelineWindow {
  return {
    restingHr: null,
    averageHr: null,
    maxHr: null,
    latestHeartDate: null,
    intradayStart: null,
    samples: [],
    markers: [],
    missingReason: NO_HISTORY_REASON,
  };
}

function buildActiveActivityRecord(
  rows: HeartGraphWindowData['active_activities'],
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

function buildBucketRows(data: HeartGraphWindowData): HeartIntradayBucketRow[] {
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

function buildHeartTimelineWindow(
  metadata: HeartGraphMetadataData,
  data: HeartGraphWindowData,
  latestHeartTime: string,
  range: HistoryRange,
): HeartTimelineWindow {
  const latestHeartDate = parseSqliteDateTime(latestHeartTime);
  const windowHours = rangeDays(range) * 24;
  const intradayStart = new Date(latestHeartDate.getTime() - windowHours * 3_600_000);
  const bucketWindow = summarizeBucketWindow(buildBucketRows(data));
  const sleepCycles = data.sleep_cycles.map(toSleepCycleRecord);
  const stageRecords = data.sleep_stage_segments.map(toSleepStageRecord);
  const enrichedSleep = buildEnrichedSleepCycleBundle(sleepCycles, stageRecords, []);
  const sleepDetails = buildHeartMarkerSleepDetailsFromEnriched(enrichedSleep.cycles);
  const activities = data.activities.map(toActivityRecord);
  const activeActivity = buildActiveActivityRecord(data.active_activities, intradayStart, latestHeartDate);
  const markerActivities = activeActivity
    ? [...activities, activeActivity].sort((left, right) => left.start.getTime() - right.start.getTime())
    : activities;
  const dailyMinima = metadata.heart_day_stats
    .map((row) => sanitizeRecordedBpm(row.min_bpm))
    .filter((value): value is number => value !== null);

  return {
    restingHr: dailyMinima.length > 0 ? personalizeRestingHr(enrichedSleep.completeSleeps, dailyMinima) : null,
    averageHr: bucketWindow.averageBpm,
    maxHr: bucketWindow.sustainedPeakBpm,
    latestHeartDate,
    intradayStart,
    samples: bucketWindow.bucketSamples,
    markers: buildHeartIntradayMarkers(
      intradayStart,
      latestHeartDate,
      enrichedSleep.sleeps,
      markerActivities,
      sleepDetails,
      enrichedSleep.summariesBySleepId,
    ),
    missingReason: bucketWindow.bucketSamples.length === 0 ? NO_HISTORY_REASON : null,
  };
}

function buildWindowVariables(latestHeartTime: string | null | undefined, range: HistoryRange): HeartGraphWindowVariables | null {
  if (!latestHeartTime) {
    return null;
  }

  const latestHeartDate = parseSqliteDateTime(latestHeartTime);
  const windowHours = rangeDays(range) * 24;
  const intradayStart = new Date(latestHeartDate.getTime() - windowHours * 3_600_000);
  const historyStart = new Date(latestHeartDate.getTime() - HEART_HISTORY_LOOKBACK_DAYS * 24 * 3_600_000);

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

export function useGraphQLHeartTimelineWindow(range: HistoryRange, version: number): HeartTimelineState {
  const [retainedWindow, setRetainedWindow] = useState<HeartTimelineWindow | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState(() => Date.now());
  const metadataQuery = useQuery<HeartGraphMetadataData>(HEART_GRAPH_METADATA_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    variables: { dailyLimit: 10_000 },
  });
  const latestHeartTime = metadataQuery.data?.heart_global_stats[0]?.latest_heart_time ?? null;
  const windowVariables = useMemo(
    () => buildWindowVariables(latestHeartTime, range),
    [latestHeartTime, range],
  );
  const windowQuery = useQuery<HeartGraphWindowData, HeartGraphWindowVariables>(
    HEART_GRAPH_WINDOW_QUERY,
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
  // Apollo refetch functions are stable enough for this explicit version bridge.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, range]);

  useEffect(() => {
    if (metadataQuery.data && !latestHeartTime) {
      setRetainedWindow(emptyHeartTimelineWindow());
    }
  }, [latestHeartTime, metadataQuery.data]);

  useEffect(() => {
    const metadata = metadataQuery.data as HeartGraphMetadataData | undefined;
    const window = windowQuery.data as HeartGraphWindowData | undefined;

    if (!metadata || !window || !latestHeartTime) {
      return;
    }

    try {
      const nextWindow = buildHeartTimelineWindow(metadata, window, latestHeartTime, range);
      logMobilePerf('screen.today.heartGraph.graphql.load', loadStartedAt, {
        markers: nextWindow.markers.length,
        points: nextWindow.samples.length,
        range,
      });
      setRetainedWindow(nextWindow);
    } catch (error) {
      logMobilePerfError('screen.today.heartGraph.graphql.load', error, { range });
    }
  }, [latestHeartTime, loadStartedAt, metadataQuery.data, range, windowQuery.data]);

  const error = metadataQuery.error ?? windowQuery.error ?? null;

  if (error && !retainedWindow) {
    return {
      error,
      isRefreshing: false,
      status: 'error',
      window: null,
    };
  }

  if (!retainedWindow) {
    return {
      error: null,
      isRefreshing: false,
      status: 'loading',
      window: null,
    };
  }

  return {
    error,
    isRefreshing: metadataQuery.loading || windowQuery.loading,
    status: 'ready',
    window: retainedWindow,
  };
}
