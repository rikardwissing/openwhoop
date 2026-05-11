import { requireNativeModule } from 'expo';
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
type TonightWidgetSnapshot = Pick<SleepHistoryData, 'sleepPlan' | 'headlineLabel' | 'headlineScore'> & {
  batteryPercent?: number | null;
  chargingStatus?: 'charging' | 'not_charging' | null;
};
type ExpoWidgetsModule = {
  reloadAllWidgets(): void;
};

let expoWidgetsModule: ExpoWidgetsModule | null = null;
let lastKnownBatteryPercent: number | null = null;
let lastSnapshot: TonightWidgetSnapshot | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function reloadAllWidgetSnapshots() {
  if (Platform.OS !== 'ios') {
    return;
  }

  try {
    expoWidgetsModule ??= requireNativeModule<ExpoWidgetsModule>('ExpoWidgets');
    expoWidgetsModule.reloadAllWidgets();
  } catch {}
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
  options: {
    batteryPercent?: number | null;
    chargingStatus?: 'charging' | 'not_charging' | null;
    headlineLabel?: string;
    headlineScore?: number | null;
  } = {},
): TonightWidgetSnapshot {
  const headlineScore = options.headlineScore ?? null;

  return {
    batteryPercent: options.batteryPercent,
    chargingStatus: options.chargingStatus,
    sleepPlan: plan,
    headlineLabel: options.headlineLabel ?? describeSleepScore(headlineScore),
    headlineScore,
  };
}

function formatBatteryLabel(batteryPercent: number | null | undefined) {
  if (batteryPercent === null || batteryPercent === undefined) {
    return '--%';
  }

  return `${Math.max(0, Math.min(100, Math.round(batteryPercent)))}%`;
}

export function buildTonightWidgetProps(snapshot: TonightWidgetSnapshot, now = new Date()): TonightWidgetProps {
  const plan = snapshot.sleepPlan;
  const resolvedBatteryPercent = snapshot.batteryPercent ?? lastKnownBatteryPercent;

  if (snapshot.batteryPercent !== undefined) {
    lastKnownBatteryPercent = snapshot.batteryPercent;
  }

  const { bedtimeDate, wakeDate } = resolveSleepWindow(plan, now);
  const sleepWindowMs = Math.max(1, wakeDate.getTime() - bedtimeDate.getTime());
  const isInsideSleepWindow = now.getTime() >= bedtimeDate.getTime() && now.getTime() < wakeDate.getTime();
  const projectedFullSleepDate = new Date(now.getTime() + plan.sleepNeedMinutes * 60_000);

  return {
    alarmStatusLabel: buildAlarmLabel(plan, wakeDate),
    bedtimeLabel: formatClock(bedtimeDate),
    bedtimePassed: isInsideSleepWindow,
    phaseLabel: buildPhaseLabel(plan, now, bedtimeDate, wakeDate),
    progress: isInsideSleepWindow
      ? clamp((now.getTime() - bedtimeDate.getTime()) / sleepWindowMs, 0, 1)
      : 0,
    batteryCharging: snapshot.chargingStatus === 'charging',
    batteryLabel: formatBatteryLabel(resolvedBatteryPercent),
    projectedSleepLabel: formatClock(projectedFullSleepDate),
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

  reloadAllWidgetSnapshots();
}

export async function updateTonightWidgetFromSleepHistory(snapshot: TonightWidgetSnapshot) {
  if (Platform.OS !== 'ios') {
    return;
  }

  lastSnapshot = {
    ...snapshot,
    batteryPercent: snapshot.batteryPercent ?? lastSnapshot?.batteryPercent,
    chargingStatus: snapshot.chargingStatus ?? lastSnapshot?.chargingStatus,
  };

  try {
    TonightWidget.updateTimeline(buildTonightWidgetTimeline(lastSnapshot));
  } catch {}
}

export async function updateTonightWidgetPowerState(powerState: {
  batteryPercent?: number | null;
  chargingStatus?: 'charging' | 'not_charging' | null;
}) {
  if (Platform.OS !== 'ios') {
    return;
  }

  if (powerState.batteryPercent !== undefined) {
    lastKnownBatteryPercent = powerState.batteryPercent;
  }

  if (!lastSnapshot) {
    return;
  }

  await updateTonightWidgetFromSleepHistory({
    ...lastSnapshot,
    batteryPercent: powerState.batteryPercent ?? lastSnapshot.batteryPercent,
    chargingStatus: powerState.chargingStatus ?? lastSnapshot.chargingStatus,
  });
}

export async function updateTonightWidgetFromSleepPlan(
  plan: SleepPlan,
  options: {
    batteryPercent?: number | null;
    chargingStatus?: 'charging' | 'not_charging' | null;
    headlineLabel?: string;
    headlineScore?: number | null;
  } = {},
) {
  await updateTonightWidgetFromSleepHistory(buildSnapshotFromPlan(plan, options));
}

async function loadLatestPowerState(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<{
    battery_percent: number | null;
    charging_status: 'charging' | 'not_charging' | null;
  }>(
    'SELECT battery_percent, charging_status FROM device_state ORDER BY last_seen_at DESC LIMIT 1',
  );

  return {
    batteryPercent: rows[0]?.battery_percent ?? null,
    chargingStatus: rows[0]?.charging_status ?? null,
  };
}

export async function updateTonightWidgetFromDatabase(db: SQLiteDatabase) {
  const repository = new SQLiteHealthRepository(db);
  const sleep = await repository.getSleepHistory('14d');
  const powerState = await loadLatestPowerState(db).catch(() => ({
    batteryPercent: null,
    chargingStatus: null,
  }));
  await updateTonightWidgetFromSleepHistory({
    ...sleep,
    batteryPercent: powerState.batteryPercent,
    chargingStatus: powerState.chargingStatus,
  });
}
