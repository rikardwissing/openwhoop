import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';

import { SQLiteHealthRepository } from '@/data/sqlite/SQLiteHealthRepository';
import type { SleepHistoryData, SleepPlan } from '@/types/health';
import { formatClock } from '@/utils/dateTime';
import { describeSleepScore } from '@/utils/formatters';
import { resolveSleepPlanWindow, resolveTonightSurfaceState } from '@/utils/sleepPlan';
import SleepLiveActivity from '@/widgets/SleepLiveActivity';
import TonightWidget from '@/widgets/TonightWidget';
import type { TonightWidgetProps } from '@/widgets/TonightWidget';

const TIMELINE_WINDOW_MS = 30 * 60 * 60 * 1000;
const LIVE_ACTIVITY_URL = 'btwearable://';
const LIVE_ACTIVITY_WIND_DOWN_PREVIEW_MINUTES = 30;
const LIVE_ACTIVITY_SLEEP_PREVIEW_MINUTES = 120;
const LIVE_ACTIVITY_REFRESH_INTERVAL_MS = 60_000;
const LIVE_ACTIVITY_SCHEDULED_START_MIN_IOS_VERSION = 26;
const LIVE_ACTIVITY_SCHEDULED_WIND_DOWN_ALERT_TITLE = 'Time to wind down';
const PREVIEW_TIMELINE_HOLD_MS = 24 * 60 * 60 * 1000;
type TonightWidgetSnapshot = Pick<
  SleepHistoryData,
  'sleepPlan' | 'headlineLabel' | 'headlineScore' | 'completionStatus' | 'isInProgress' | 'sessions'
> & {
  batteryPercent?: number | null;
  chargingStatus?: 'charging' | 'not_charging' | null;
};
export type SleepSurfacePreviewMode = 'wind_down' | 'sleep_in_progress';
type TonightWidgetUpdateOptions = {
  allowLiveActivityScheduling?: boolean;
};
type SleepLiveActivityStartOptions = {
  alertBody?: string;
  alertTitle?: string;
  startDate?: Date;
};
type ExpoWidgetsModule = {
  reloadAllWidgets(): void;
};

let expoWidgetsModule: ExpoWidgetsModule | null = null;
let lastKnownBatteryPercent: number | null = null;
let lastSnapshot: TonightWidgetSnapshot | null = null;
let sleepSurfacePreviewProps: TonightWidgetProps | null = null;
let sleepSurfacePreviewTimeline: { date: Date; props: TonightWidgetProps }[] | null = null;
let lastWidgetTimelineKey: string | null = null;
let lastLiveActivityPropsKey: string | null = null;
let lastLiveActivityInstanceCount = 0;
let liveActivityRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
let scheduledLiveActivityPropsKey: string | null = null;
let scheduledLiveActivityStartAtMs: number | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getCurrentIOSVersion() {
  if (Platform.OS !== 'ios') {
    return null;
  }

  const rawVersion = typeof Platform.Version === 'string' ? Number.parseFloat(Platform.Version) : Platform.Version;
  return Number.isFinite(rawVersion) ? rawVersion : null;
}

function supportsScheduledSleepLiveActivityStart() {
  const version = getCurrentIOSVersion();
  return version !== null && version >= LIVE_ACTIVITY_SCHEDULED_START_MIN_IOS_VERSION;
}

function warnSleepLiveActivityFailure(action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[widgets] Failed to ${action} sleep live activity`, message);
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
    sessions: [],
    sleepPlan: plan,
    headlineLabel: options.headlineLabel ?? describeSleepScore(headlineScore),
    headlineScore,
  };
}

export function buildTonightWidgetProps(snapshot: TonightWidgetSnapshot, now = new Date()): TonightWidgetProps {
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

function buildTimelineDates(snapshot: TonightWidgetSnapshot, now: Date) {
  const plan = snapshot.sleepPlan;
  const { bedtimeDate, previewStartDate, prepStartDate, wakeDate } = resolveSleepPlanWindow(plan, now);
  const surfaceState = resolveTonightSurfaceState(snapshot, now);
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

  if (surfaceState.mode === 'sleep') {
    const sleepEndEstimate = surfaceState.sleepStartDate
      ? new Date(surfaceState.sleepStartDate.getTime() + plan.sleepNeedMinutes * 60_000)
      : wakeDate;
    const progressTimelineEnd = new Date(Math.min(latestDate.getTime(), sleepEndEstimate.getTime() + 60 * 60_000));
    const nextHalfHour = new Date(Math.ceil(now.getTime() / (30 * 60_000)) * 30 * 60_000);

    candidates.push(sleepEndEstimate);

    for (
      let time = nextHalfHour.getTime();
      time <= progressTimelineEnd.getTime();
      time += 30 * 60_000
    ) {
      candidates.push(new Date(time));
    }
  }

  for (const date of candidates) {
    if (date.getTime() < now.getTime() || date.getTime() > latestDate.getTime()) {
      continue;
    }

    uniqueDates.set(Math.round(date.getTime() / 60_000), date);
  }

  return [...uniqueDates.values()].sort((left, right) => left.getTime() - right.getTime());
}

export function buildTonightWidgetTimeline(snapshot: TonightWidgetSnapshot, now = new Date()) {
  return buildTimelineDates(snapshot, now).map((date) => ({
    date,
    props: buildTonightWidgetProps(snapshot, date),
  }));
}

function buildPreviewWidgetTimeline(props: TonightWidgetProps, now = new Date()) {
  const holdUntil = new Date(now.getTime() + PREVIEW_TIMELINE_HOLD_MS);

  return [
    {
      date: now,
      props,
    },
    {
      date: holdUntil,
      props,
    },
  ];
}

function getPreviewWidgetTimeline() {
  if (!sleepSurfacePreviewProps) {
    return null;
  }

  if (!sleepSurfacePreviewTimeline) {
    sleepSurfacePreviewTimeline = buildPreviewWidgetTimeline(sleepSurfacePreviewProps);
  }

  return sleepSurfacePreviewTimeline;
}

function buildWidgetTimelineKey(entries: { date: Date; props: TonightWidgetProps }[]) {
  return JSON.stringify(
    entries.map((entry) => ({
      timestamp: entry.date.getTime(),
      props: entry.props,
    })),
  );
}

function syncTonightWidgetPreviewOrLive(snapshot?: TonightWidgetSnapshot) {
  if (!sleepSurfacePreviewProps && !snapshot) {
    return;
  }

  const entries = sleepSurfacePreviewProps
    ? getPreviewWidgetTimeline() ?? buildPreviewWidgetTimeline(sleepSurfacePreviewProps)
    : buildTonightWidgetTimeline(snapshot as TonightWidgetSnapshot);
  const nextKey = buildWidgetTimelineKey(entries);

  if (nextKey === lastWidgetTimelineKey) {
    return;
  }

  try {
    TonightWidget.updateTimeline(entries);
    lastWidgetTimelineKey = nextKey;
  } catch {
    lastWidgetTimelineKey = null;
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

  if (sleepSurfacePreviewProps) {
    await startOrUpdateSleepLiveActivity(sleepSurfacePreviewProps);
    scheduleSleepLiveActivityRefresh();
    return;
  }

  if (!lastSnapshot) {
    return;
  }

  const props = buildTonightWidgetProps(lastSnapshot);

  if (props.surfaceMode === 'awake') {
    await endSleepLiveActivities();
    return;
  }

  await endPendingSleepLiveActivities();
  await startOrUpdateSleepLiveActivity(props);
  scheduleSleepLiveActivityRefresh();
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

  lastLiveActivityPropsKey = null;
  lastLiveActivityInstanceCount = 0;
  scheduledLiveActivityPropsKey = null;
  scheduledLiveActivityStartAtMs = null;
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

  lastLiveActivityPropsKey = null;
  lastLiveActivityInstanceCount = 0;
  scheduledLiveActivityPropsKey = null;
  scheduledLiveActivityStartAtMs = null;
  return true;
}

async function startOrUpdateSleepLiveActivity(
  props: TonightWidgetProps,
  options: SleepLiveActivityStartOptions = {},
) {
  const instances = getSleepLiveActivityInstances();
  const nextPropsKey = JSON.stringify(props);

  if (instances.length === 0) {
    try {
      SleepLiveActivity.start(props, LIVE_ACTIVITY_URL, options);
      lastLiveActivityPropsKey = nextPropsKey;
      lastLiveActivityInstanceCount = 1;
      return true;
    } catch (error) {
      lastLiveActivityPropsKey = null;
      lastLiveActivityInstanceCount = 0;
      warnSleepLiveActivityFailure(options.startDate ? 'schedule' : 'start', error);
    }

    return false;
  }

  if (nextPropsKey === lastLiveActivityPropsKey && instances.length === lastLiveActivityInstanceCount) {
    return true;
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
    lastLiveActivityPropsKey = nextPropsKey;
    lastLiveActivityInstanceCount = instances.length;
    return true;
  } else {
    lastLiveActivityPropsKey = null;
    lastLiveActivityInstanceCount = instances.length;
  }

  if (updateFailures[0]) {
    warnSleepLiveActivityFailure('update', updateFailures[0]);
  }

  return false;
}

async function scheduleSleepLiveActivityAtWindDown(snapshot: TonightWidgetSnapshot, now = new Date()) {
  if (!supportsScheduledSleepLiveActivityStart()) {
    return false;
  }

  let { prepStartDate, wakeDate } = resolveSleepPlanWindow(snapshot.sleepPlan, now);

  if (prepStartDate.getTime() <= now.getTime()) {
    ({ prepStartDate, wakeDate } = resolveSleepPlanWindow(
      snapshot.sleepPlan,
      new Date(wakeDate.getTime() + 60_000),
    ));
  }

  if (prepStartDate.getTime() <= now.getTime()) {
    return false;
  }

  const props = buildTonightWidgetProps(snapshot, prepStartDate);
  const nextPropsKey = JSON.stringify(props);
  const instances = getSleepLiveActivityInstances();

  if (
    instances.length > 0 &&
    scheduledLiveActivityStartAtMs === prepStartDate.getTime() &&
    scheduledLiveActivityPropsKey === nextPropsKey
  ) {
    return true;
  }

  clearSleepLiveActivityRefreshTimer();

  if (instances.length > 0) {
    await endSleepLiveActivities();
  }

  const scheduled = await startOrUpdateSleepLiveActivity(props, {
    alertBody: `Bed ${formatClock(prepStartDate)}, wake ${formatClock(wakeDate)}`,
    alertTitle: LIVE_ACTIVITY_SCHEDULED_WIND_DOWN_ALERT_TITLE,
    startDate: prepStartDate,
  });

  if (!scheduled) {
    return false;
  }

  scheduledLiveActivityStartAtMs = prepStartDate.getTime();
  scheduledLiveActivityPropsKey = nextPropsKey;
  return true;
}

function buildSleepSurfacePreviewProps(
  snapshot: TonightWidgetSnapshot,
  mode: SleepSurfacePreviewMode,
) {
  const { bedtimeDate, wakeDate } = resolveSleepPlanWindow(snapshot.sleepPlan, new Date());

  if (mode === 'wind_down') {
    const previewDate = new Date(bedtimeDate.getTime() - LIVE_ACTIVITY_WIND_DOWN_PREVIEW_MINUTES * 60_000);
    const previewProps = buildTonightWidgetProps(snapshot, previewDate);

    return {
      ...previewProps,
      surfaceMode: 'wind_down',
    } satisfies TonightWidgetProps;
  }

  const previewDate = new Date(
    Math.min(
      wakeDate.getTime() - 60_000,
      bedtimeDate.getTime() + LIVE_ACTIVITY_SLEEP_PREVIEW_MINUTES * 60_000,
    ),
  );
  const previewProps = buildTonightWidgetProps(snapshot, previewDate);
  const previewSleepProgress = clamp(
    (previewDate.getTime() - bedtimeDate.getTime()) / Math.max(1, snapshot.sleepPlan.sleepNeedMinutes * 60_000),
    0.06,
    0.96,
  );

  return {
    ...previewProps,
    projectedSleepTimestamp: bedtimeDate.getTime() + snapshot.sleepPlan.sleepNeedMinutes * 60_000,
    sleepProgress: previewSleepProgress,
    sleepStartTimestamp: bedtimeDate.getTime(),
    surfaceMode: 'sleep',
  } satisfies TonightWidgetProps;
}

async function syncSleepLiveActivity(
  snapshot: TonightWidgetSnapshot,
  options: TonightWidgetUpdateOptions = {},
) {
  const now = new Date();
  const props = sleepSurfacePreviewProps ?? buildTonightWidgetProps(snapshot, now);
  const allowLiveActivityScheduling = options.allowLiveActivityScheduling ?? true;

  if (props.surfaceMode === 'awake') {
    if (
      allowLiveActivityScheduling &&
      !sleepSurfacePreviewProps &&
      (await scheduleSleepLiveActivityAtWindDown(snapshot, now))
    ) {
      return;
    }

    await endSleepLiveActivities();
    return;
  }

  await endPendingSleepLiveActivities();
  scheduledLiveActivityPropsKey = null;
  scheduledLiveActivityStartAtMs = null;

  if (await startOrUpdateSleepLiveActivity(props)) {
    scheduleSleepLiveActivityRefresh();
  }
}

export async function previewSleepSurfaces(
  snapshot: TonightWidgetSnapshot,
  mode: SleepSurfacePreviewMode,
) {
  if (Platform.OS !== 'ios') {
    return;
  }

  lastSnapshot = {
    ...snapshot,
    batteryPercent: snapshot.batteryPercent ?? lastSnapshot?.batteryPercent,
    chargingStatus: snapshot.chargingStatus ?? lastSnapshot?.chargingStatus,
  };

  sleepSurfacePreviewProps = buildSleepSurfacePreviewProps(lastSnapshot, mode);
  sleepSurfacePreviewTimeline = buildPreviewWidgetTimeline(sleepSurfacePreviewProps);
  lastWidgetTimelineKey = null;
  syncTonightWidgetPreviewOrLive(lastSnapshot);
  await startOrUpdateSleepLiveActivity(sleepSurfacePreviewProps);
  scheduleSleepLiveActivityRefresh();
}

export async function restoreSleepSurfacePreview() {
  if (Platform.OS !== 'ios') {
    return;
  }

  sleepSurfacePreviewProps = null;
  sleepSurfacePreviewTimeline = null;
  lastWidgetTimelineKey = null;

  if (lastSnapshot) {
    await applyTonightWidgetSnapshot(lastSnapshot);
    return;
  }

  await endSleepLiveActivities();
}

async function applyTonightWidgetSnapshot(
  snapshot: TonightWidgetSnapshot,
  options: TonightWidgetUpdateOptions = {},
) {
  lastSnapshot = {
    ...snapshot,
    batteryPercent: snapshot.batteryPercent ?? lastSnapshot?.batteryPercent,
    chargingStatus: snapshot.chargingStatus ?? lastSnapshot?.chargingStatus,
  };

  syncTonightWidgetPreviewOrLive(lastSnapshot);
  reloadAllWidgetSnapshots();

  await syncSleepLiveActivity(lastSnapshot, options).catch(() => {});
}

export async function registerTonightWidgetLayout() {
  if (Platform.OS !== 'ios') {
    return;
  }

  try {
    TonightWidget.reload();
  } catch {}

  getSleepLiveActivityInstances();
  lastWidgetTimelineKey = null;
  lastLiveActivityPropsKey = null;
  lastLiveActivityInstanceCount = 0;

  if (lastSnapshot) {
    await applyTonightWidgetSnapshot(lastSnapshot).catch(() => {});
  } else if (sleepSurfacePreviewProps) {
    syncTonightWidgetPreviewOrLive();

    await startOrUpdateSleepLiveActivity(sleepSurfacePreviewProps).catch(() => {});
    scheduleSleepLiveActivityRefresh();
  }

  reloadAllWidgetSnapshots();
}

export async function updateTonightWidgetFromSleepHistory(
  snapshot: TonightWidgetSnapshot,
  options: TonightWidgetUpdateOptions = {},
) {
  if (Platform.OS !== 'ios') {
    return;
  }

  await applyTonightWidgetSnapshot(snapshot, options);
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

export async function updateTonightWidgetFromDatabase(
  db: SQLiteDatabase,
  options: TonightWidgetUpdateOptions = {},
) {
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
  }, options);
}
