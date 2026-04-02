export const BASE_SLEEP_NEED_MINUTES = 8 * 60;
export const MAX_SLEEP_DEBT_MINUTES = 150;
export const SLEEP_TARGET_STEP_MINUTES = 15;

const RECENT_SLEEP_WEIGHTS = [0.6, 0.3, 0.1];
const MINUTES_PER_DAY = 24 * 60;

export function normalizeClockMinutes(minutes: number) {
  return ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function roundClockMinutes(minutes: number, step = SLEEP_TARGET_STEP_MINUTES) {
  return normalizeClockMinutes(Math.round(normalizeClockMinutes(minutes) / step) * step);
}

export function calculateSleepDebtMinutes(recentSleepDurationsMinutes: number[]) {
  const weightedShortfall = recentSleepDurationsMinutes
    .slice(-RECENT_SLEEP_WEIGHTS.length)
    .reverse()
    .map((durationMinutes, index) => Math.max(0, BASE_SLEEP_NEED_MINUTES - durationMinutes) * (RECENT_SLEEP_WEIGHTS[index] ?? 0))
    .reduce((sum, value) => sum + value, 0);

  return Math.min(MAX_SLEEP_DEBT_MINUTES, Math.round(weightedShortfall));
}

export function calculateSleepNeedMinutes(recentSleepDurationsMinutes: number[]) {
  return BASE_SLEEP_NEED_MINUTES + calculateSleepDebtMinutes(recentSleepDurationsMinutes);
}

export function applyNapCreditToSleepDebt(sleepDebtMinutes: number, napCreditMinutes: number) {
  return Math.max(0, Math.min(MAX_SLEEP_DEBT_MINUTES, sleepDebtMinutes - Math.max(0, napCreditMinutes)));
}

export function calculateOptimalBedtimeMinutes(targetWakeMinutes: number, sleepNeedMinutes: number) {
  return normalizeClockMinutes(targetWakeMinutes - sleepNeedMinutes);
}

export function nextUpcomingClockDate(clockMinutes: number, from = new Date()) {
  const next = new Date(from);
  const normalized = normalizeClockMinutes(clockMinutes);
  next.setHours(Math.floor(normalized / 60), normalized % 60, 0, 0);

  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}
