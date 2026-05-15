import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { openAppDatabaseAsync } from '@/db/appDatabase';
import { recordAppIntentEvent } from '@/services/appIntentEvents';
import { syncNotificationPermissionFromSystem } from '@/services/notifications/notificationPermissions';
import type { NotificationPermissionState } from '@/types/device';
import type { SleepPlan } from '@/types/health';
import type { TonightWidgetProps } from '@/widgets/TonightWidget';
import { formatClock } from '@/utils/dateTime';
import { formatShortDuration } from '@/utils/formatters';
import {
  buildSleepWindDownStatus,
  nextUpcomingClockDate,
  normalizeClockMinutes,
  resolveSleepPlanWindow,
  WIND_DOWN_PREP_MINUTES,
} from '@/utils/sleepPlan';

export const SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID = 'sleep-preparation-reminder';
export const SLEEP_PREPARATION_REMINDER_NOTIFICATION_KIND = 'sleep-preparation-reminder';
export const SLEEP_PREPARATION_REMINDER_NOTIFICATION_CATEGORY_ID = 'sleep-preparation-reminder-actions';
export const SLEEP_PREPARATION_START_LIVE_ACTIVITY_ACTION_ID = 'start_sleep_live_activity';

export type SleepPreparationReminderSyncResult =
  | {
      scheduled: true;
      permission: NotificationPermissionState;
      reason: 'scheduled';
      triggerAt: Date;
    }
  | {
      scheduled: false;
      permission: NotificationPermissionState | null;
      reason: 'disabled' | 'permission-denied';
      triggerAt: null;
    };

function isPermissionGranted(permission: NotificationPermissionState) {
  return permission === 'granted' || permission === 'provisional';
}

async function ensureSleepPreparationReminderNotificationCategory() {
  if (Platform.OS !== 'ios' || typeof Notifications.setNotificationCategoryAsync !== 'function') {
    return;
  }

  await Notifications.setNotificationCategoryAsync(
    SLEEP_PREPARATION_REMINDER_NOTIFICATION_CATEGORY_ID,
    [
      {
        identifier: SLEEP_PREPARATION_START_LIVE_ACTIVITY_ACTION_ID,
        buttonTitle: 'Start Live Activity',
        options: {
          opensAppToForeground: false,
        },
      },
    ],
  ).catch(() => {});
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

function buildSleepPreparationLiveActivityProps(plan: SleepPlan, triggerAt: Date): TonightWidgetProps {
  const { bedtimeDate, wakeDate } = resolveSleepPlanWindow(plan, triggerAt);
  const windDownStatus = buildSleepWindDownStatus(plan, triggerAt);

  return {
    alarmStatusLabel: plan.alarmWakeMode === 'exact_time'
      ? `Alarm ${formatClock(wakeDate)}`
      : `Smart alarm ${formatClock(wakeDate)}`,
    batteryCharging: false,
    batteryLabel: '--%',
    bedtimeLabel: formatClock(bedtimeDate),
    bedtimeTimestamp: bedtimeDate.getTime(),
    bedtimePassed: false,
    greetingLabel: 'Time to wind down',
    phaseLabel: windDownStatus.phaseLabel,
    projectedSleepLabel: formatClock(wakeDate),
    progress: 0,
    score: null,
    scoreLabel: 'Waiting for sleep',
    sleepDebtLabel: buildSleepDebtLabel(plan),
    sleepInProgress: false,
    sleepNeedLabel: formatShortDuration(plan.sleepNeedMinutes),
    sleepProgress: 0,
    sleepThemeActive: true,
    sleepThemeLabel: 'Time to wind down',
    updatedAtLabel: formatClock(triggerAt),
    wakeLabel: formatClock(wakeDate),
  };
}

export async function syncSleepPreparationReminder(
  plan: SleepPlan,
  options?: {
    now?: Date;
    requestPermission?: boolean;
  },
): Promise<SleepPreparationReminderSyncResult> {
  await Notifications.cancelScheduledNotificationAsync(
    SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID,
  ).catch(() => {});

  if (!plan.alarmEnabled) {
    return {
      scheduled: false,
      permission: null,
      reason: 'disabled',
      triggerAt: null,
    };
  }

  const permissionResult = await syncNotificationPermissionFromSystem(
    options?.requestPermission ?? false,
  );

  if (!isPermissionGranted(permissionResult.permission)) {
    return {
      scheduled: false,
      permission: permissionResult.permission,
      reason: 'permission-denied',
      triggerAt: null,
    };
  }

  const reminderClockMinutes = normalizeClockMinutes(plan.optimalBedtimeMinutes - WIND_DOWN_PREP_MINUTES);
  const triggerAt = nextUpcomingClockDate(reminderClockMinutes, options?.now);
  const liveActivityProps = buildSleepPreparationLiveActivityProps(plan, triggerAt);

  await ensureSleepPreparationReminderNotificationCategory();

  await Notifications.scheduleNotificationAsync({
    identifier: SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID,
    content: {
      categoryIdentifier: SLEEP_PREPARATION_REMINDER_NOTIFICATION_CATEGORY_ID,
      title: 'Start winding down',
      body: 'Bedtime is in one hour. Charge your wearable, dim lights, and protect the next hour for sleep.',
      data: {
        kind: SLEEP_PREPARATION_REMINDER_NOTIFICATION_KIND,
        liveActivityProps,
        route: '/sleep',
      },
      interruptionLevel: 'timeSensitive',
      sound: false,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: triggerAt,
    },
  });
  await recordBedtimeStartAppIntentEvent(plan, triggerAt, liveActivityProps).catch(() => {});

  return {
    scheduled: true,
    permission: permissionResult.permission,
    reason: 'scheduled',
    triggerAt,
  };
}

async function recordBedtimeStartAppIntentEvent(
  plan: SleepPlan,
  triggerAt: Date,
  liveActivityProps: TonightWidgetProps,
) {
  const db = await openAppDatabaseAsync();

  try {
    await recordAppIntentEvent(db, {
      kind: 'bedtime_start',
      entityId: triggerAt.toISOString(),
      occurredAt: triggerAt,
      payload: {
        optimalBedtime: plan.optimalBedtime,
        optimalBedtimeMinutes: plan.optimalBedtimeMinutes,
        sleepNeedMinutes: plan.sleepNeedMinutes,
        targetWakeTime: plan.targetWakeTime,
        liveActivityProps,
      },
    });
  } finally {
    await db.closeAsync().catch(() => {});
  }
}
