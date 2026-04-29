import type { HeartCardData, HeartTimelineSample, HeartTimelineWindow, TrendPoint } from '@/types/health';
import { formatAxisTime, timeOfDayMinuteOffset } from '@/utils/dateTime';
import { filterPlausibleRecordedBpms, sustainedPeakBpm } from '@/utils/heartRate';
import { mean } from '@/utils/math';

const HEART_GRAPH_POINT_INTERVAL_MINUTES = 5;

function summarizeHeartSampleValues(samples: readonly HeartTimelineSample[]) {
  const validBpms = filterPlausibleRecordedBpms(samples.map((sample) => sample.bpm));

  if (validBpms.length === 0) {
    return {
      averageHr: null,
      maxHr: null,
    };
  }

  return {
    averageHr: Math.round(mean(validBpms)),
    maxHr: sustainedPeakBpm(validBpms),
  };
}

function bucketHeartTimelineSamples(
  samples: readonly HeartTimelineSample[],
  startDate?: Date,
  endDate?: Date,
): TrendPoint[] {
  if (samples.length === 0) {
    return [];
  }

  const bucketMinutes = HEART_GRAPH_POINT_INTERVAL_MINUTES;
  const bucketMs = bucketMinutes * 60000;
  const buckets = new Map<number, HeartTimelineSample[]>();

  for (const sample of samples) {
    const bucketStart = Math.floor(sample.date.getTime() / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart);

    if (bucket) {
      bucket.push(sample);
      continue;
    }

    buckets.set(bucketStart, [sample]);
  }

  const firstBucket = Math.floor((startDate?.getTime() ?? samples[0]!.date.getTime()) / bucketMs) * bucketMs;
  const lastBucket = Math.floor((endDate?.getTime() ?? samples.at(-1)!.date.getTime()) / bucketMs) * bucketMs;
  const series: TrendPoint[] = [];

  for (let bucketStart = firstBucket; bucketStart <= lastBucket; bucketStart += bucketMs) {
    const bucket = buckets.get(bucketStart);
    const bucketSummary = bucket ? summarizeHeartSampleValues(bucket) : null;

    series.push({
      label: formatAxisTime(new Date(bucketStart)),
      minuteOffset: timeOfDayMinuteOffset(new Date(bucketStart)),
      value: bucketSummary?.averageHr ?? null,
    });
  }

  return series;
}

export function buildHeartCardDataFromWindow(
  window: HeartTimelineWindow,
): HeartCardData {
  const series = bucketHeartTimelineSamples(
    window.samples,
    window.intradayStart ?? undefined,
    window.latestHeartDate ?? undefined,
  );

  return {
    restingHr: window.restingHr,
    averageHr: window.averageHr,
    maxHr: window.maxHr,
    pointIntervalMinutes: HEART_GRAPH_POINT_INTERVAL_MINUTES,
    series,
    markers: window.markers,
    missingReason: window.missingReason ?? null,
  };
}