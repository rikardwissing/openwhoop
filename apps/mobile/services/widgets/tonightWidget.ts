import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';

import { SQLiteHealthRepository } from '@/data/sqlite/SQLiteHealthRepository';
import type { SleepHistoryData, SleepPlan } from '@/types/health';
import { formatClock } from '@/utils/dateTime';
import { describeSleepScore, formatShortDuration } from '@/utils/formatters';
import { buildSleepPlanGreeting, buildSleepWindDownStatus, resolveSleepPlanWindow } from '@/utils/sleepPlan';
import TonightWidget from '@/widgets/TonightWidget';
import type { TonightWidgetProps } from '@/widgets/TonightWidget';

const TIMELINE_WINDOW_MS = 30 * 60 * 60 * 1000;
type TonightWidgetSnapshot = Pick<
  SleepHistoryData,
  'sleepPlan' | 'headlineLabel' | 'headlineScore' | 'completionStatus' | 'isInProgress'
> & {
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
    completionStatus: 'complete',
    isInProgress: false,
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
  const sleepInProgress = snapshot.isInProgress || snapshot.completionStatus === 'in_progress';

  if (snapshot.batteryPercent !== undefined) {
    lastKnownBatteryPercent = snapshot.batteryPercent;
  }

  const { bedtimeDate, wakeDate } = resolveSleepPlanWindow(plan, now);
  const windDownStatus = buildSleepWindDownStatus(plan, now);
  const sleepWindowMs = Math.max(1, wakeDate.getTime() - bedtimeDate.getTime());
  const bedtimePassed = !sleepInProgress && windDownStatus.isBedtimeStarted;
  const projectedFullSleepDate = new Date(now.getTime() + plan.sleepNeedMinutes * 60_000);

  return {
    alarmStatusLabel: buildAlarmLabel(plan, wakeDate),
    bedtimeLabel: sleepInProgress ? 'Now' : formatClock(bedtimeDate),
    bedtimePassed,
    greetingLabel: sleepInProgress ? 'Sleep in progress' : buildSleepPlanGreeting(plan, now),
    phaseLabel: sleepInProgress ? 'Sleep in progress' : windDownStatus.phaseLabel,
    progress: bedtimePassed
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
  const { bedtimeDate, previewStartDate, prepStartDate, wakeDate } = resolveSleepPlanWindow(plan, now);
  const candidates = [
    now,
    previewStartDate,
    prepStartDate,
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
