import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';

import {
  buildSleepCycleTrendSeries,
  buildTrendMetric,
  buildTrendMetricSeries,
  calculateSleepConsistencyScore,
  completeSleepCycles,
  describeSkinTemperatureDeviation,
  rangeDays,
  toSleepCycleRecord,
  type SleepCycleRow,
} from '@/data/sqlite/SQLiteHealthRepository';
import { useGraphQLHeartHistory } from '@/hooks/useGraphQLHeartHistory';
import { useGraphQLSleepHistory } from '@/hooks/useGraphQLSleepHistory';
import { useGraphQLWellnessData } from '@/hooks/useGraphQLWellnessData';
import type { HistoryRange, MetricSeries, TrendData, TrendMetric, TrendPoint } from '@/types/health';
import { formatLongDate, parseSqliteDateTime } from '@/utils/dateTime';
import { mean, median } from '@/utils/math';
import { logMobilePerf, logMobilePerfError } from '@/utils/mobilePerf';

const TEMPERATURE_BASELINE_WINDOW_NIGHTS = 14;
const MIN_TEMPERATURE_BASELINE_NIGHTS = 3;
const NO_HISTORY_REASON = 'No local history yet. Sync the wearable from Settings to unlock this view.';
const NO_SLEEP_REASON = 'No overnight sleep has been detected yet. Leave the wearable on long enough for a full sleep window.';
const LIMITED_SENSOR_REASON = 'The wearable has not collected enough samples for this signal yet.';
const BUILDING_SLEEP_CONSISTENCY_REASON = 'More nights are needed before sleep consistency can be scored.';
const BUILDING_TEMPERATURE_BASELINE_REASON = 'A few nights of temperature data are needed before baseline shifts can be tracked.';

const TREND_BASELINE_QUERY = gql`
  query TrendBaseline($sleepLimit: Int!) {
    heart_global_stats(limit: 1) {
      id
      latest_heart_time
    }
    heart_rate(order_by: [{ time: desc }], limit: 1) {
      id
      time
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
  }
`;

interface TrendBaselineData {
  heart_global_stats: Array<{
    id: number;
    latest_heart_time: string | null;
  }>;
  heart_rate: Array<{
    id: number;
    time: string;
  }>;
  sleep_cycles: SleepCycleRow[];
}

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function trendValues(points: TrendPoint[]): number[] {
  return points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
}

function latestSeriesValue(series: readonly TrendPoint[]) {
  return series.at(-1)?.value ?? null;
}

function emptyMetric(
  id: TrendMetric['id'],
  title: string,
  accent: MetricSeries['accent'],
  unit: string,
  missingReason: string,
): TrendMetric {
  return buildTrendMetric(
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
}

function latestHeartDateFromBaseline(data: TrendBaselineData) {
  const globalTime = data.heart_global_stats[0]?.latest_heart_time ?? null;
  const latestRawTime = data.heart_rate[0]?.time ?? null;
  const latestHeartTime =
    globalTime && latestRawTime
      ? globalTime > latestRawTime
        ? globalTime
        : latestRawTime
      : globalTime ?? latestRawTime;

  return latestHeartTime ? parseSqliteDateTime(latestHeartTime) : null;
}

function emptyTrendData(range: HistoryRange): TrendData {
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
  };
}

function buildTrendData(
  range: HistoryRange,
  baseline: TrendBaselineData,
  sleep: NonNullable<ReturnType<typeof useGraphQLSleepHistory>['data']>,
  heart: NonNullable<ReturnType<typeof useGraphQLHeartHistory>['data']>,
  wellness: NonNullable<ReturnType<typeof useGraphQLWellnessData>['data']>,
): TrendData {
  const latestHeartDate = latestHeartDateFromBaseline(baseline);
  const trendSleepCycles = completeSleepCycles(baseline.sleep_cycles.map(toSleepCycleRecord).reverse());
  const selectedSleepCycles = trendSleepCycles.slice(-rangeDays(range));
  const latestTrendSleep = selectedSleepCycles.at(-1) ?? null;

  if (!latestHeartDate) {
    return emptyTrendData(range);
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
          const windowStart = Math.max(0, globalIndex - 6);
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

  return {
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
  };
}

export function useGraphQLTrendData(range: HistoryRange, version: number): AsyncState<TrendData> {
  const [retainedData, setRetainedData] = useState<TrendData | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState(() => Date.now());
  const sleep = useGraphQLSleepHistory(range, version);
  const heart = useGraphQLHeartHistory(range, version);
  const wellness = useGraphQLWellnessData(range, version);
  const sleepLimit = useMemo(
    () => rangeDays(range) + TEMPERATURE_BASELINE_WINDOW_NIGHTS,
    [range],
  );
  const baselineQuery = useQuery<TrendBaselineData>(TREND_BASELINE_QUERY, {
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
    variables: { sleepLimit },
  });

  useEffect(() => {
    setLoadStartedAt(Date.now());
    void baselineQuery.refetch({ sleepLimit });
  // Apollo refetch is used as the bridge from the existing health version signal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, sleepLimit, version]);

  useEffect(() => {
    if (!baselineQuery.data || !sleep.data || !heart.data || !wellness.data) {
      return;
    }

    try {
      const nextData = buildTrendData(range, baselineQuery.data, sleep.data, heart.data, wellness.data);
      logMobilePerf('screen.trends.graphql.load', loadStartedAt, {
        range,
        primaryMetrics: nextData.primaryMetrics.length,
        secondaryMetrics: nextData.secondaryMetrics.length,
      });
      setRetainedData(nextData);
    } catch (error) {
      logMobilePerfError('screen.trends.graphql.load', error, { range });
    }
  }, [baselineQuery.data, heart.data, loadStartedAt, range, sleep.data, wellness.data]);

  const error = baselineQuery.error ?? sleep.error ?? heart.error ?? wellness.error ?? null;

  if (error) {
    return { status: 'error', data: retainedData, error };
  }

  if (!retainedData) {
    return { status: 'loading', data: null, error: null };
  }

  return { status: 'ready', data: retainedData, error: null };
}
