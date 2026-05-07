export const MIN_PLAUSIBLE_RESPIRATORY_RATE = 4;
export const MAX_PLAUSIBLE_RESPIRATORY_RATE = 60;
// Firmware stores the respiratory rate in the high byte; the low byte appears to be a status flag.
export const RESPIRATORY_RATE_RAW_VALUE_DIVISOR = 256;
export const MIN_PLAUSIBLE_RESPIRATORY_RATE_RAW = MIN_PLAUSIBLE_RESPIRATORY_RATE * RESPIRATORY_RATE_RAW_VALUE_DIVISOR;
export const MAX_PLAUSIBLE_RESPIRATORY_RATE_RAW =
  MAX_PLAUSIBLE_RESPIRATORY_RATE * RESPIRATORY_RATE_RAW_VALUE_DIVISOR +
  (RESPIRATORY_RATE_RAW_VALUE_DIVISOR - 1);

export function normalizeRespiratoryRateRaw(value: number | null | undefined) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value < MIN_PLAUSIBLE_RESPIRATORY_RATE_RAW ||
    value > MAX_PLAUSIBLE_RESPIRATORY_RATE_RAW
  ) {
    return null;
  }

  const breathsPerMinute = Math.floor(value / RESPIRATORY_RATE_RAW_VALUE_DIVISOR);

  return breathsPerMinute >= MIN_PLAUSIBLE_RESPIRATORY_RATE && breathsPerMinute <= MAX_PLAUSIBLE_RESPIRATORY_RATE
    ? breathsPerMinute
    : null;
}
