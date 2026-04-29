import type { AlarmScheduleKind, AlarmWakeMode } from '@/types/health';

export const BASE_SLEEP_NEED_MINUTES = 8 * 60;
export const MAX_SLEEP_DEBT_MINUTES = 150;
export const SLEEP_TARGET_STEP_MINUTES = 15;
export const ALARM_WEEKDAY_FULL_MASK = 0b1111111;
export const ALARM_IMMEDIATE_RING_DELAY_MS = 60_000;

const RECENT_SLEEP_WEIGHTS = [0.6, 0.3, 0.1];
const MINUTES_PER_DAY = 24 * 60;
const WEEKDAY_COUNT = 7;

export interface AlarmSettingsInput {
  alarmScheduleKind: AlarmScheduleKind;
  alarmWakeMode: AlarmWakeMode;
  alarmWeekdayMask: number;
  targetWakeMinutes: number;
}

export interface AlarmResolutionInput extends AlarmSettingsInput {
  alarmEnabled: boolean;
  alarmOneOffAt: Date | null;
  inProgressSleepStart: Date | null;
  sleepNeedMinutes: number;
}

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

export function normalizeAlarmWeekdayMask(mask: number | null | undefined) {
  return Math.trunc(mask ?? ALARM_WEEKDAY_FULL_MASK) & ALARM_WEEKDAY_FULL_MASK;
}

export function isAlarmWeekdaySelected(mask: number, weekday: number) {
  return (mask & ALARM_WEEKDAY_FULL_MASK & (1 << weekday)) !== 0;
}

export function normalizeAlarmScheduleKind(value: string | null | undefined): AlarmScheduleKind {
  return value === 'one_off' ? 'one_off' : 'recurring';
}

export function normalizeAlarmWakeMode(value: string | null | undefined): AlarmWakeMode {
  return value === 'score_or_time' || value === 'score_and_time' || value === 'score_only'
    ? value
    : 'exact_time';
}

export function nextRecurringClockDate(clockMinutes: number, weekdayMask: number, from = new Date()) {
  const normalizedMask = normalizeAlarmWeekdayMask(weekdayMask);

  for (let dayOffset = 0; dayOffset <= WEEKDAY_COUNT; dayOffset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + dayOffset);

    if (!isAlarmWeekdaySelected(normalizedMask, candidate.getDay())) {
      continue;
    }

    const normalizedMinutes = normalizeClockMinutes(clockMinutes);
    candidate.setHours(Math.floor(normalizedMinutes / 60), normalizedMinutes % 60, 0, 0);

    if (candidate.getTime() > from.getTime()) {
      return candidate;
    }
  }

  return null;
}

export function nextAlarmTargetDate(settings: AlarmSettingsInput, from = new Date()) {
  if (settings.alarmScheduleKind === 'one_off') {
    return nextUpcomingClockDate(settings.targetWakeMinutes, from);
  }

  return nextRecurringClockDate(settings.targetWakeMinutes, settings.alarmWeekdayMask, from);
}

export function resolveNextWearableAlarmDate(settings: AlarmResolutionInput, now = new Date()) {
  if (!settings.alarmEnabled) {
    return null;
  }

  const targetDate =
    settings.alarmScheduleKind === 'one_off'
      ? settings.alarmOneOffAt
      : nextRecurringClockDate(settings.targetWakeMinutes, settings.alarmWeekdayMask, now);
  const projectedScoreDate = settings.inProgressSleepStart
    ? new Date(settings.inProgressSleepStart.getTime() + settings.sleepNeedMinutes * 60_000)
    : null;
  const safeProjectedScoreDate =
    projectedScoreDate && projectedScoreDate.getTime() <= now.getTime()
      ? new Date(now.getTime() + ALARM_IMMEDIATE_RING_DELAY_MS)
      : projectedScoreDate;

  if (settings.alarmWakeMode === 'exact_time') {
    return targetDate && targetDate.getTime() > now.getTime() ? targetDate : null;
  }

  if (settings.alarmWakeMode === 'score_only') {
    return safeProjectedScoreDate;
  }

  if (settings.alarmWakeMode === 'score_and_time') {
    if (!targetDate || targetDate.getTime() <= now.getTime()) {
      return safeProjectedScoreDate;
    }

    if (!safeProjectedScoreDate) {
      return null;
    }

    return safeProjectedScoreDate.getTime() > targetDate.getTime()
      ? safeProjectedScoreDate
      : targetDate;
  }

  if (!targetDate || targetDate.getTime() <= now.getTime()) {
    return safeProjectedScoreDate;
  }

  if (!safeProjectedScoreDate) {
    return targetDate;
  }

  return safeProjectedScoreDate.getTime() < targetDate.getTime()
    ? safeProjectedScoreDate
    : targetDate;
}
