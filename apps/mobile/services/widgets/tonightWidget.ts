import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';

import { SQLiteHealthRepository } from '@/data/sqlite/SQLiteHealthRepository';
import type { SleepHistoryData } from '@/types/health';
import { resolveSleepPlanWindow, resolveTonightSurfaceState } from '@/utils/sleepPlan';
import SleepLiveActivity from '@/widgets/SleepLiveActivity';
import TonightWidget from '@/widgets/TonightWidget';
import type { TonightWidgetProps } from '@/widgets/TonightWidget';

const LIVE_ACTIVITY_URL = 'btwearable://';
const LIVE_ACTIVITY_REFRESH_INTERVAL_MS = 60_000;
const WIDGET_TIMELINE_HOLD_MS = 24 * 60 * 60 * 1000;
type TonightWidgetSnapshot = Pick<
  SleepHistoryData,
  'sleepPlan' | 'headlineLabel' | 'headlineScore' | 'completionStatus' | 'isInProgress' | 'sessions'
> & {
  batteryPercent?: number | null;
  chargingStatus?: 'charging' | 'not_charging' | null;
};
type ExpoWidgetsModule = {
  reloadAllWidgets(): void;
};

let expoWidgetsModule: ExpoWidgetsModule | null = null;
let lastKnownBatteryPercent: number | null = null;
let currentSnapshot: TonightWidgetSnapshot | null = null;
let liveActivityRefreshTimeout: ReturnType<typeof setTimeout> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function warnSleepLiveActivityFailure(action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[widgets] Failed to ${action} sleep live activity`, message);
}

function warnTonightWidgetFailure(action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[widgets] Failed to ${action} tonight widget`, message);
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

function buildTonightWidgetProps(snapshot: TonightWidgetSnapshot, now = new Date()): TonightWidgetProps {
  const plan = snapshot.sleepPlan;
  const resolvedBatteryPercent = snapshot.batteryPercent ?? lastKnownBatteryPercent;

  if (snapshot.batteryPercent !== undefined) {
    lastKnownBatteryPercent = snapshot.batteryPercent;
  }

  const { bedtimeDate, wakeDate } = resolveSleepPlanWindow(plan, now);
  const surfaceState = resolveTonightSurfaceState(snapshot, now);
  const sleepInProgress = surfaceState.mode === 'sleep';
  const sleepWindowMs = Math.max(1, wakeDate.getTime() - bedtimeDate.getTime());
  const bedtimePassed = surfaceState.mode === 'bedtime_passed';
  const projectedFullSleepDate = new Date(
    (sleepInProgress ? (surfaceState.sleepStartDate?.getTime() ?? now.getTime()) : now.getTime()) +
      plan.sleepNeedMinutes * 60_000,
  );

  return {
    batteryCharging: snapshot.chargingStatus === 'charging',
    batteryPercent: resolvedBatteryPercent,
    bedtimeTimestamp: bedtimeDate.getTime(),
    napCreditMinutes: plan.napCreditMinutes,
    progress: bedtimePassed
      ? clamp((now.getTime() - bedtimeDate.getTime()) / sleepWindowMs, 0, 1)
      : 0,
    projectedSleepTimestamp: projectedFullSleepDate.getTime(),
    score: snapshot.headlineScore,
    sleepDebtMinutes: plan.sleepDebtMinutes,
    sleepNeedMinutes: plan.sleepNeedMinutes,
    sleepProgress: surfaceState.sleepProgress,
    sleepStartTimestamp: sleepInProgress
      ? (surfaceState.sleepStartDate?.getTime() ?? now.getTime())
      : undefined,
    surfaceMode: surfaceState.mode,
    wakeTimestamp: wakeDate.getTime(),
  };
}

function buildNativeWidgetProps(props: TonightWidgetProps): TonightWidgetProps {
  return Object.fromEntries(
    Object.entries(props).filter(([, value]) => value !== null && value !== undefined),
  ) as TonightWidgetProps;
}

function buildTonightWidgetTimeline(snapshot: TonightWidgetSnapshot, now = new Date()) {
  const props = buildNativeWidgetProps(buildTonightWidgetProps(snapshot, now));

  return [
    {
      date: now,
      props,
    },
    {
      date: new Date(now.getTime() + WIDGET_TIMELINE_HOLD_MS),
      props: { ...props },
    },
  ];
}

function updateTonightWidgetTimeline(timeline: ReturnType<typeof buildTonightWidgetTimeline>, fallbackProps: TonightWidgetProps) {
  try {
    TonightWidget.updateTimeline(timeline);
    return;
  } catch (error) {
    warnTonightWidgetFailure('update timeline for', error);
  }

  try {
    TonightWidget.updateSnapshot(buildNativeWidgetProps(fallbackProps));
  } catch (error) {
    warnTonightWidgetFailure('update snapshot for', error);
  }
}

function getSleepLiveActivityInstances() {
  try {
    return SleepLiveActivity.getInstances();
  } catch {
    return [];
  }
}

function clearSleepLiveActivityRefreshTimer() {
  if (liveActivityRefreshTimeout === null) {
    return;
  }

  clearTimeout(liveActivityRefreshTimeout);
  liveActivityRefreshTimeout = null;
}

function scheduleSleepLiveActivityRefresh() {
  if (Platform.OS !== 'ios') {
    return;
  }

  clearSleepLiveActivityRefreshTimer();

  const delay = LIVE_ACTIVITY_REFRESH_INTERVAL_MS - (Date.now() % LIVE_ACTIVITY_REFRESH_INTERVAL_MS);

  liveActivityRefreshTimeout = setTimeout(() => {
    liveActivityRefreshTimeout = null;
    void refreshSleepLiveActivityForClockTick();
  }, delay + 250);
}

async function refreshSleepLiveActivityForClockTick() {
  if (Platform.OS !== 'ios') {
    return;
  }

  if (getSleepLiveActivityInstances().length === 0) {
    return;
  }

  await buildAndPublishTonightWidget();
}

async function endSleepLiveActivities() {
  clearSleepLiveActivityRefreshTimer();

  const instances = getSleepLiveActivityInstances();

  await Promise.all(
    instances.map(async (instance) => {
      try {
        await instance.end('immediate');
      } catch {}
    }),
  );

}

async function endPendingSleepLiveActivities() {
  const instances = getSleepLiveActivityInstances();

  if (instances.length === 0) {
    return false;
  }

  const pendingInstances: typeof instances = [];

  await Promise.all(
    instances.map(async (instance) => {
      try {
        if ((await instance.getState()) === 'pending') {
          pendingInstances.push(instance);
        }
      } catch {}
    }),
  );

  if (pendingInstances.length === 0) {
    return false;
  }

  await Promise.all(
    pendingInstances.map(async (instance) => {
      try {
        await instance.end('immediate');
      } catch {}
    }),
  );

  return true;
}

async function startOrUpdateSleepLiveActivity(
  props: TonightWidgetProps,
) {
  const instances = getSleepLiveActivityInstances();

  if (instances.length === 0) {
    try {
      SleepLiveActivity.start(props, LIVE_ACTIVITY_URL);
      return true;
    } catch (error) {
      warnSleepLiveActivityFailure('start', error);
    }

    return false;
  }

  const updateFailures: unknown[] = [];
  const updateResults = await Promise.all(
    instances.map(async (instance) => {
      try {
        await instance.update(props);
        return true;
      } catch (error) {
        updateFailures.push(error);
      }

      return false;
    }),
  );

  if (updateResults.some(Boolean)) {
    return true;
  }

  if (updateFailures[0]) {
    warnSleepLiveActivityFailure('update', updateFailures[0]);
  }

  return false;
}

async function buildAndPublishTonightWidget() {
  if (Platform.OS !== 'ios') {
    return;
  }

  const snapshot = currentSnapshot;
  const props = snapshot ? buildTonightWidgetProps(snapshot) : null;

  if (!props) {
    return;
  }

  const timeline = snapshot ? buildTonightWidgetTimeline(snapshot) : null;

  if (timeline) {
    updateTonightWidgetTimeline(timeline, props);
    reloadAllWidgetSnapshots();
  }

  if (props.surfaceMode === 'awake') {
    await endSleepLiveActivities();
    return;
  }

  await endPendingSleepLiveActivities();

  if (await startOrUpdateSleepLiveActivity(props)) {
    scheduleSleepLiveActivityRefresh();
  }
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

async function rememberDatabaseSnapshot(db: SQLiteDatabase) {
  const repository = new SQLiteHealthRepository(db);
  const sleep = await repository.getSleepHistory('14d');
  const powerState = await loadLatestPowerState(db).catch(() => ({
    batteryPercent: null,
    chargingStatus: null,
  }));

  currentSnapshot = {
    ...sleep,
    batteryPercent: powerState.batteryPercent,
    chargingStatus: powerState.chargingStatus,
  };

  if (currentSnapshot.batteryPercent !== undefined) {
    lastKnownBatteryPercent = currentSnapshot.batteryPercent;
  }
}

export async function updateTonightWidget(db: SQLiteDatabase) {
  if (Platform.OS !== 'ios') {
    return;
  }

  try {
    await rememberDatabaseSnapshot(db);
    await buildAndPublishTonightWidget();
  } catch (error) {
    warnTonightWidgetFailure('update', error);
  }
}
