import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';

import { SQLiteHealthRepository } from '@/data/sqlite/SQLiteHealthRepository';
import type { SleepHistoryData, SleepPlan } from '@/types/health';
import { formatClock, parseSqliteDateTime } from '@/utils/dateTime';
import { describeSleepScore, formatShortDuration } from '@/utils/formatters';
import { nextUpcomingClockDate } from '@/utils/sleepPlan';
import TonightWidget from '@/widgets/TonightWidget';
import type { TonightWidgetProps } from '@/widgets/TonightWidget';

const TIMELINE_WINDOW_MS = 30 * 60 * 60 * 1000;
type TonightWidgetSnapshot = Pick<SleepHistoryData, 'sleepPlan' | 'headlineLabel' | 'headlineScore'>;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatCountdown(from: Date, to: Date) {
  const minutes = Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 60_000));

  if (minutes <= 1) {
    return 'now';
  }

  return formatShortDuration(minutes);
}

function parseFutureDate(value: string | null, now: Date) {
  if (!value) {
    return null;
  }

  const date = parseSqliteDateTime(value);
  return Number.isFinite(date.getTime()) && date.getTime() > now.getTime() ? date : null;
}

function resolveWakeDate(plan: SleepPlan, now: Date) {
  return parseFutureDate(plan.nextAlarmAt, now) ?? nextUpcomingClockDate(plan.targetWakeMinutes, now);
}

function resolveSleepWindow(plan: SleepPlan, now: Date) {
  const wakeDate = resolveWakeDate(plan, now);
  const bedtimeDate = new Date(wakeDate.getTime() - plan.sleepNeedMinutes * 60_000);

  return { bedtimeDate, wakeDate };
}

function buildPhaseLabel(plan: SleepPlan, now: Date, bedtimeDate: Date, wakeDate: Date) {
  if (now.getTime() >= bedtimeDate.getTime() && now.getTime() < wakeDate.getTime()) {
    return `Wake in ${formatCountdown(now, wakeDate)}`;
  }

  const minutesUntilBedtime = Math.ceil((bedtimeDate.getTime() - now.getTime()) / 60_000);
  const prefix = minutesUntilBedtime <= 90 ? 'Wind down in' : 'Bed in';
  return `${prefix} ${formatCountdown(now, bedtimeDate)}`;
}

function buildAlarmLabel(plan: SleepPlan, wakeDate: Date) {
  if (!plan.alarmEnabled) {
    return 'Wake target';
  }

  return plan.alarmWakeMode === 'exact_time'
    ? `Alarm ${formatClock(wakeDate)}`
    : `Smart alarm ${formatClock(wakeDate)}`;
}

function buildSleepDebtLabel(plan: SleepPlan) {
  if (plan.sleepDebtMinutes > 0) {
    return `${formatShortDuration(plan.sleepDebtMinutes)} debt`;
  }

  if (plan.napCreditMinutes > 0) {
    return `${formatShortDuration(plan.napCreditMinutes)} nap credit`;
  }

  return 'No sleep debt';
}

function buildSnapshotFromPlan(
  plan: SleepPlan,
  options: { headlineLabel?: string; headlineScore?: number | null } = {},
): TonightWidgetSnapshot {
  const headlineScore = options.headlineScore ?? null;

  return {
    sleepPlan: plan,
    headlineLabel: options.headlineLabel ?? describeSleepScore(headlineScore),
    headlineScore,
  };
}

export function buildTonightWidgetProps(snapshot: TonightWidgetSnapshot, now = new Date()): TonightWidgetProps {
  const plan = snapshot.sleepPlan;
  const { bedtimeDate, wakeDate } = resolveSleepWindow(plan, now);
  const sleepWindowMs = Math.max(1, wakeDate.getTime() - bedtimeDate.getTime());
  const isInsideSleepWindow = now.getTime() >= bedtimeDate.getTime() && now.getTime() < wakeDate.getTime();

  return {
    alarmStatusLabel: buildAlarmLabel(plan, wakeDate),
    bedtimeLabel: formatClock(bedtimeDate),
    phaseLabel: buildPhaseLabel(plan, now, bedtimeDate, wakeDate),
    progress: isInsideSleepWindow
      ? clamp((now.getTime() - bedtimeDate.getTime()) / sleepWindowMs, 0, 1)
      : 0,
    score: snapshot.headlineScore,
    scoreLabel: snapshot.headlineLabel,
    sleepDebtLabel: buildSleepDebtLabel(plan),
    sleepNeedLabel: formatShortDuration(plan.sleepNeedMinutes),
    updatedAtLabel: formatClock(now),
    wakeLabel: formatClock(wakeDate),
  };
}

function buildTimelineDates(plan: SleepPlan, now: Date) {
  const { bedtimeDate, wakeDate } = resolveSleepWindow(plan, now);
  const candidates = [
    now,
    bedtimeDate,
    wakeDate,
    new Date(wakeDate.getTime() + 60_000),
  ];
  const latestDate = new Date(now.getTime() + TIMELINE_WINDOW_MS);
  const uniqueDates = new Map<number, Date>();

  for (const date of candidates) {
    if (date.getTime() < now.getTime() || date.getTime() > latestDate.getTime()) {
      continue;
    }

    uniqueDates.set(Math.round(date.getTime() / 60_000), date);
  }

  return [...uniqueDates.values()].sort((left, right) => left.getTime() - right.getTime());
}

export function buildTonightWidgetTimeline(snapshot: TonightWidgetSnapshot, now = new Date()) {
  return buildTimelineDates(snapshot.sleepPlan, now).map((date) => ({
    date,
    props: buildTonightWidgetProps(snapshot, date),
  }));
}

export async function registerTonightWidgetLayout() {
  if (Platform.OS !== 'ios') {
    return;
  }

  try {
    TonightWidget.reload();
  } catch {}
}

export async function updateTonightWidgetFromSleepHistory(snapshot: TonightWidgetSnapshot) {
  if (Platform.OS !== 'ios') {
    return;
  }

  try {
    TonightWidget.updateTimeline(buildTonightWidgetTimeline(snapshot));
  } catch {}
}

export async function updateTonightWidgetFromSleepPlan(
  plan: SleepPlan,
  options: { headlineLabel?: string; headlineScore?: number | null } = {},
) {
  await updateTonightWidgetFromSleepHistory(buildSnapshotFromPlan(plan, options));
}

export async function updateTonightWidgetFromDatabase(db: SQLiteDatabase) {
  const repository = new SQLiteHealthRepository(db);
  const sleep = await repository.getSleepHistory('14d');
  await updateTonightWidgetFromSleepHistory(sleep);
}
