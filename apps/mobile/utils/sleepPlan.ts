import type { AlarmScheduleKind, AlarmWakeMode, SleepCompletionStatus, SleepPlan, SleepSession } from '@/types/health';
import { formatClock, parseSqliteDateTime } from '@/utils/dateTime';

export const BASE_SLEEP_NEED_MINUTES = 8 * 60;
export const MAX_SLEEP_DEBT_MINUTES = 150;
export const SLEEP_TARGET_STEP_MINUTES = 15;
export const WIND_DOWN_PREP_MINUTES = 60;
export const WIND_DOWN_PREVIEW_MINUTES = 90;
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

export type SleepWindDownPhase = 'before_preview' | 'preview' | 'wind_down' | 'bedtime';
export type TonightSurfaceMode = 'sleep' | 'bedtime_passed' | 'wind_down' | 'awake';

export interface SleepWindDownStatus {
  bedtimeDate: Date;
  detail: string;
  greeting: string;
  inlineLabel: string;
  isBedtimeStarted: boolean;
  isWindDownActive: boolean;
  minutesUntilBedtime: number;
  minutesUntilPrepStart: number;
  phase: SleepWindDownPhase;
  prepStartDate: Date;
  wakeDate: Date;
}

type SleepThemeSession = Pick<SleepSession, 'completionStatus' | 'endAt' | 'isInProgress' | 'startAt'>;

export interface TonightSurfaceInput {
  completionStatus?: SleepCompletionStatus | null;
  isInProgress?: boolean | null;
  sessions?: SleepThemeSession[];
  sleepPlan: SleepPlan;
}

export interface TonightSurfaceState {
  completedSleepEndDate: Date | null;
  currentNightSleepEndDate: Date | null;
  currentNightSleepStartDate: Date | null;
  hasCurrentNightSleep: boolean;
  mode: TonightSurfaceMode;
  sleepProgress: number;
  sleepStartDate: Date | null;
  windDownStatus: SleepWindDownStatus;
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

export function buildTimeOfDayGreeting(now = new Date()) {
  const hour = now.getHours();

  if (hour < 12) {
    return 'Good morning';
  }

  if (hour < 18) {
    return 'Good afternoon';
  }

  if (hour < 22) {
    return 'Good evening';
  }

  return 'Good night';
}

function parseFutureDate(value: string | null, now: Date) {
  if (!value) {
    return null;
  }

  const date = parseSqliteDateTime(value);
  return Number.isFinite(date.getTime()) && date.getTime() > now.getTime() ? date : null;
}

function formatCountdownMinutes(minutes: number) {
  const safeMinutes = Math.max(0, Math.ceil(minutes));

  if (safeMinutes <= 1) {
    return 'now';
  }

  const hours = Math.floor(safeMinutes / 60);
  const remainingMinutes = safeMinutes % 60;

  if (hours === 0) {
    return `${remainingMinutes}m`;
  }

  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

function parseValidDate(value: string) {
  const date = parseSqliteDateTime(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function latestSessionByDate(
  sessions: SleepThemeSession[],
  getDate: (session: SleepThemeSession) => Date | null,
) {
  return sessions.reduce<{ date: Date; session: SleepThemeSession } | null>((latest, session) => {
    const date = getDate(session);

    if (!date) {
      return latest;
    }

    if (!latest || date.getTime() > latest.date.getTime()) {
      return { date, session };
    }

    return latest;
  }, null);
}

function sessionInterval(session: SleepThemeSession) {
  const startDate = parseValidDate(session.startAt);
  const endDate = parseValidDate(session.endAt);

  if (!startDate || !endDate) {
    return null;
  }

  return { endDate, startDate };
}

export function resolveSleepPlanWakeDate(plan: SleepPlan, now = new Date()) {
  return parseFutureDate(plan.nextAlarmAt, now) ?? nextUpcomingClockDate(plan.targetWakeMinutes, now);
}

export function resolveSleepPlanWindow(plan: SleepPlan, now = new Date()) {
  const wakeDate = resolveSleepPlanWakeDate(plan, now);
  const bedtimeDate = new Date(wakeDate.getTime() - plan.sleepNeedMinutes * 60_000);
  const prepStartDate = new Date(bedtimeDate.getTime() - WIND_DOWN_PREP_MINUTES * 60_000);
  const previewStartDate = new Date(bedtimeDate.getTime() - WIND_DOWN_PREVIEW_MINUTES * 60_000);

  return {
    bedtimeDate,
    previewStartDate,
    prepStartDate,
    wakeDate,
  };
}

export function buildSleepWindDownStatus(plan: SleepPlan, now = new Date()): SleepWindDownStatus {
  const { bedtimeDate, previewStartDate, prepStartDate, wakeDate } = resolveSleepPlanWindow(plan, now);
  const minutesUntilBedtime = Math.ceil((bedtimeDate.getTime() - now.getTime()) / 60_000);
  const minutesUntilPrepStart = Math.ceil((prepStartDate.getTime() - now.getTime()) / 60_000);
  const minutesUntilWake = Math.ceil((wakeDate.getTime() - now.getTime()) / 60_000);
  const phase: SleepWindDownPhase =
    now.getTime() >= bedtimeDate.getTime() && now.getTime() < wakeDate.getTime()
      ? 'bedtime'
      : now.getTime() >= prepStartDate.getTime() && now.getTime() < bedtimeDate.getTime()
        ? 'wind_down'
        : now.getTime() >= previewStartDate.getTime() && now.getTime() < prepStartDate.getTime()
          ? 'preview'
          : 'before_preview';

  if (phase === 'bedtime') {
    return {
      bedtimeDate,
      detail: `Aim to be asleep until ${formatClock(wakeDate)}.`,
      greeting: 'Bedtime has started',
      inlineLabel: 'Bedtime',
      isBedtimeStarted: true,
      isWindDownActive: true,
      minutesUntilBedtime,
      minutesUntilPrepStart,
      phase,
      prepStartDate,
      wakeDate,
    };
  }

  if (phase === 'wind_down') {
    return {
      bedtimeDate,
      detail: `Bedtime in ${formatCountdownMinutes(minutesUntilBedtime)}.`,
      greeting: 'Time to wind down',
      inlineLabel: 'Wind down',
      isBedtimeStarted: false,
      isWindDownActive: true,
      minutesUntilBedtime,
      minutesUntilPrepStart,
      phase,
      prepStartDate,
      wakeDate,
    };
  }

  if (phase === 'preview') {
    return {
      bedtimeDate,
      detail: `Wind-down starts at ${formatClock(prepStartDate)}.`,
      greeting: 'Wind-down soon',
      inlineLabel: 'Wind-down soon',
      isBedtimeStarted: false,
      isWindDownActive: false,
      minutesUntilBedtime,
      minutesUntilPrepStart,
      phase,
      prepStartDate,
      wakeDate,
    };
  }

  return {
    bedtimeDate,
    detail: `Wind-down starts at ${formatClock(prepStartDate)}.`,
    greeting: "Tonight's plan",
    inlineLabel: 'Tonight',
    isBedtimeStarted: false,
    isWindDownActive: false,
    minutesUntilBedtime,
    minutesUntilPrepStart,
    phase,
    prepStartDate,
    wakeDate,
  };
}

export function buildSleepPlanGreeting(plan: SleepPlan, now = new Date()) {
  const windDownStatus = buildSleepWindDownStatus(plan, now);
  return windDownStatus.phase === 'wind_down' || windDownStatus.phase === 'bedtime'
    ? windDownStatus.greeting
    : buildTimeOfDayGreeting(now);
}

export function resolveTonightSurfaceState(input: TonightSurfaceInput, now = new Date()): TonightSurfaceState {
  const windDownStatus = buildSleepWindDownStatus(input.sleepPlan, now);
  const sessions = input.sessions ?? [];
  const fallbackSleepInProgress = Boolean(input.isInProgress || input.completionStatus === 'in_progress');
  const inProgressSession = latestSessionByDate(
    sessions.filter((session) => session.isInProgress || session.completionStatus === 'in_progress'),
    (session) => parseValidDate(session.startAt),
  );
  const latestSession = latestSessionByDate(sessions, (session) => parseValidDate(session.startAt));
  const currentNightCompletedSleep = latestSessionByDate(
    sessions.filter((session) => !session.isInProgress && session.completionStatus === 'complete'),
    (session) => {
      const interval = sessionInterval(session);

      if (!interval) {
        return null;
      }

      const overlapsCurrentNight =
        interval.startDate.getTime() < windDownStatus.wakeDate.getTime() &&
        interval.endDate.getTime() > windDownStatus.bedtimeDate.getTime();

      return overlapsCurrentNight ? interval.endDate : null;
    },
  );
  const sleepInProgress = Boolean(inProgressSession || fallbackSleepInProgress);
  const sleepStartDate =
    inProgressSession?.date ?? (fallbackSleepInProgress ? latestSession?.date ?? null : null);
  const rawSleepProgress = sleepStartDate
    ? (now.getTime() - sleepStartDate.getTime()) / Math.max(1, input.sleepPlan.sleepNeedMinutes * 60_000)
    : 0;
  const sleepProgress = sleepInProgress
    ? Math.max(0.06, Math.min(0.96, rawSleepProgress))
    : 0;
  const hasCurrentNightSleep = sleepInProgress || Boolean(currentNightCompletedSleep);
  const mode: TonightSurfaceMode = sleepInProgress
    ? 'sleep'
    : windDownStatus.phase === 'bedtime' && !hasCurrentNightSleep
      ? 'bedtime_passed'
      : windDownStatus.phase === 'wind_down' && !hasCurrentNightSleep
        ? 'wind_down'
        : 'awake';

  return {
    completedSleepEndDate: currentNightCompletedSleep?.date ?? null,
    currentNightSleepEndDate: currentNightCompletedSleep?.date ?? null,
    currentNightSleepStartDate: currentNightCompletedSleep
      ? (sessionInterval(currentNightCompletedSleep.session)?.startDate ?? null)
      : sleepStartDate,
    hasCurrentNightSleep,
    mode,
    sleepProgress,
    sleepStartDate,
    windDownStatus,
  };
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
