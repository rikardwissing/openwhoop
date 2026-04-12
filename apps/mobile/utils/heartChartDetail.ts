const FIFTEEN_SECONDS_MINUTES = 0.25;
const THIRTY_SECONDS_MINUTES = 0.5;
const ONE_MINUTE = 1;
const TWO_MINUTES = 2;
const FIVE_MINUTES = 5;

export function selectFocusedHeartBucketMinutes(
  durationMinutes: number,
  medianRawSampleGapSeconds: number | null,
) {
  const safeDurationMinutes = Math.max(durationMinutes, 0);

  if (safeDurationMinutes <= 12) {
    return medianRawSampleGapSeconds !== null && medianRawSampleGapSeconds <= 10
      ? FIFTEEN_SECONDS_MINUTES
      : THIRTY_SECONDS_MINUTES;
  }

  if (safeDurationMinutes <= 30) {
    return THIRTY_SECONDS_MINUTES;
  }

  if (safeDurationMinutes <= 90) {
    return ONE_MINUTE;
  }

  if (safeDurationMinutes <= 240) {
    return TWO_MINUTES;
  }

  return FIVE_MINUTES;
}