import { mean } from '@/utils/math';

export const MIN_PLAUSIBLE_RECORDED_BPM = 25;
export const MAX_PLAUSIBLE_RECORDED_BPM = 230;

export function isPlausibleRecordedBpm(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PLAUSIBLE_RECORDED_BPM && value <= MAX_PLAUSIBLE_RECORDED_BPM;
}

export function sanitizeRecordedBpm(value: number | null | undefined): number | null {
  return isPlausibleRecordedBpm(value) ? value : null;
}

export function filterPlausibleRecordedBpms(values: readonly number[]): number[] {
  return values.filter((value): value is number => isPlausibleRecordedBpm(value));
}

export function sustainedPeakBpm(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  if (values.length === 1) {
    return Math.round(values[0]);
  }

  const windowSize = values.length >= 3 ? 3 : 2;
  let peak = Number.NEGATIVE_INFINITY;

  for (let index = 0; index <= values.length - windowSize; index += 1) {
    peak = Math.max(peak, mean(values.slice(index, index + windowSize)));
  }

  return Math.round(peak);
}
