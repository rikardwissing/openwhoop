import { mean } from '@/utils/math';

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
