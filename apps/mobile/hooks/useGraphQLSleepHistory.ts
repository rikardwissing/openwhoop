import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';

import {
  buildEnrichedSleepCycleBundle,
  buildFilledDailySeries,
  buildSleepPlan,
  inferTargetWakeMinutes,
  normalizeSleepPreferences,
  rangeDays,
  toActivityRecord,
  toSleepCycleRecord,
  toSleepStageRecord,
  type ActivityRow,
  type SleepCycleRow,
  type SleepPreferenceRow,
  type SleepStageRow,
} from '@/data/sqlite/SQLiteHealthRepository';
import { getSQLiteApolloClient } from '@/modules/local-sqlite-apollo/src';
import type { HistoryRange, SleepHistoryData, SleepSession } from '@/types/health';
import {
  dateKey,
  formatClock,
  formatShortDate,
  formatSqliteDateTime,
  minutesBetween,
  parseSqliteDateTime,
} from '@/utils/dateTime';
import { describeSleepScore } from '@/utils/formatters';
import { clamp, mean, stdDev } from '@/utils/math';

const NO_SLEEP_REASON = 'No overnight sleep has been detected yet. Leave the wearable on long enough for a full sleep window.';
const LIMITED_SENSOR_REASON = 'The wearable has not collected enough samples for this signal yet.';
const MIN_SLEEP_CONSISTENCY_NIGHTS = 3;

const SLEEP_HISTORY_QUERY = gql`
  query SleepHistory($activityStart: String!, $sleepLimit: Int!) {
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
    activities(
      where: {
        activity: { _eq: "Nap" }
        start: { _gte: $activityStart }
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

interface SleepHistoryGraphQLData {
  activities: ActivityRow[];
  sleep_cycles: SleepCycleRow[];
  sleep_preferences: SleepPreferenceRow[];
  sleep_stage_segments: SleepStageRow[];
}

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function buildEmptySleepHistory(
  range: HistoryRange,
  data: SleepHistoryGraphQLData,
): SleepHistoryData {
  const preferences = normalizeSleepPreferences(data.sleep_preferences[0] ?? null, inferTargetWakeMinutes([]));

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
    sleepPlan: buildSleepPlan(preferences, [], []),
    isEstimated: true,
    missingReason: NO_SLEEP_REASON,
  };
}

function buildSleepHistory(range: HistoryRange, data: SleepHistoryGraphQLData): SleepHistoryData {
  const sleepCycles = data.sleep_cycles.map(toSleepCycleRecord).reverse();
  const stageRecords = data.sleep_stage_segments.map(toSleepStageRecord);
  const napActivities = data.activities.map(toActivityRecord);
  const enrichedSleep = buildEnrichedSleepCycleBundle(sleepCycles, stageRecords, napActivities);
  const rescoredSleepCycles = enrichedSleep.sleeps;
  const completeRescoredSleepCycles = enrichedSleep.completeSleeps;
  const preferences = normalizeSleepPreferences(
    data.sleep_preferences[0] ?? null,
    inferTargetWakeMinutes(completeRescoredSleepCycles),
  );
  const latestSleepForPlan = completeRescoredSleepCycles.at(-1) ?? null;
  const planNapActivities = latestSleepForPlan
    ? napActivities.filter((activity) => activity.activity === 'Nap' && activity.start >= latestSleepForPlan.end)
    : [];
  const sleepPlan = buildSleepPlan(preferences, rescoredSleepCycles, planNapActivities);
  const sessions = enrichedSleep.cycles.slice(-rangeDays(range)).reverse();
  const completeSessionsForStats = completeRescoredSleepCycles.slice(-rangeDays(range));
  const latestSleepEntry = sessions[0] ?? null;
  const latestSleep = latestSleepEntry?.sleep ?? null;

  if (!latestSleep) {
    return {
      ...buildEmptySleepHistory(range, data),
      sleepPlan,
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
  const mappedSessions: SleepSession[] = sessions.map((cycle) => {
    const session = cycle.sleep;
    const summary = cycle.summary;

    return {
      id: session.id,
      startAt: formatSqliteDateTime(session.start),
      endAt: formatSqliteDateTime(session.end),
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
      missingReason: cycle.stageRecords.length === 0 ? LIMITED_SENSOR_REASON : null,
      minBpm: session.minBpm,
      maxBpm: session.maxBpm,
      avgHrv: session.avgHrv,
    };
  });
  const trendSleepCycles = completeRescoredSleepCycles.slice(-rangeDays(range));
  const sleepScoreByDay = new Map(trendSleepCycles.map((session) => [dateKey(session.end), session.score]));
  const sleepDurationByDay = new Map(
    trendSleepCycles.map((session) => {
      const summary = enrichedSleep.bySleepId.get(session.sleepId)?.summary;
      return [dateKey(session.end), summary?.timeAsleepMinutes ?? session.asleepMinutes ?? minutesBetween(session.start, session.end)] as const;
    }),
  );
  const inProgressSession = mappedSessions.find((session) => session.isInProgress) ?? null;
  const latestSession = mappedSessions.reduce<SleepSession | null>((latest, session) => {
    if (!latest) {
      return session;
    }

    return parseSqliteDateTime(session.startAt).getTime() > parseSqliteDateTime(latest.startAt).getTime()
      ? session
      : latest;
  }, null);
  const surfaceSession = inProgressSession ?? latestSession;
  const trendEndDate = latestSleepForPlan?.end ?? latestSleep.end;

  return {
    headlineScore: surfaceSession?.score ?? latestSleep.score,
    headlineLabel: surfaceSession?.isInProgress ? 'In progress' : describeSleepScore(surfaceSession?.score ?? latestSleep.score),
    bedtime: surfaceSession?.bedtime ?? formatClock(latestSleep.start),
    wakeTime: surfaceSession?.wakeTime ?? formatClock(latestSleep.end),
    completionStatus: surfaceSession?.completionStatus ?? latestSleep.completionStatus,
    isInProgress: surfaceSession?.isInProgress ?? latestSleep.isInProgress,
    durationMinutes: surfaceSession?.durationMinutes ?? minutesBetween(latestSleep.start, latestSleep.end),
    timeInBedMinutes: surfaceSession?.timeInBedMinutes ?? minutesBetween(latestSleep.start, latestSleep.end),
    bedtimeConsistency: bedtimeConsistency === null ? null : Math.round(bedtimeConsistency),
    wakeConsistency: wakeConsistency === null ? null : Math.round(wakeConsistency),
    scoreTrend: buildFilledDailySeries(range, trendEndDate, (day) => sleepScoreByDay.get(day) ?? null),
    durationTrend: buildFilledDailySeries(range, trendEndDate, (day) => sleepDurationByDay.get(day) ?? null),
    sessions: mappedSessions,
    sleepPlan,
    isEstimated: true,
  };
}

function sleepHistoryVariables(range: HistoryRange) {
  const activityStart = formatSqliteDateTime(new Date(Date.now() - Math.max(rangeDays(range), 30) * 24 * 3_600_000));

  return {
    activityStart,
    sleepLimit: Math.max(rangeDays(range), 15),
  };
}

export async function fetchGraphQLSleepHistory(
  db: SQLiteDatabase,
  range: HistoryRange,
): Promise<SleepHistoryData> {
  const client = await getSQLiteApolloClient(db);
  const result = await client.query<SleepHistoryGraphQLData>({
    fetchPolicy: 'network-only',
    query: SLEEP_HISTORY_QUERY,
    variables: sleepHistoryVariables(range),
  });

  if (!result.data) {
    throw new Error('Unable to load sleep history from local GraphQL.');
  }

  return buildSleepHistory(range, result.data);
}

export function useGraphQLSleepHistory(range: HistoryRange, version: number): AsyncState<SleepHistoryData> {
  const [retainedData, setRetainedData] = useState<SleepHistoryData | null>(null);
  const variables = useMemo(() => sleepHistoryVariables(range), [range]);
  const query = useQuery<SleepHistoryGraphQLData>(SLEEP_HISTORY_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    variables,
  });

  useEffect(() => {
    void query.refetch(variables);
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, variables, version]);

  useEffect(() => {
    if (query.data) {
      setRetainedData(buildSleepHistory(range, query.data));
    }
  }, [query.data, range]);

  if (query.error) {
    return { status: 'error', data: retainedData, error: query.error };
  }

  if (!retainedData) {
    return { status: 'loading', data: null, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}
