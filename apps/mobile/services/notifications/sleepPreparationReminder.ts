import * as Notifications from 'expo-notifications';

import { brand } from '@/constants/brand';
import { NOTIFICATION_ROUTE_KEY } from '@/services/notifications/notificationRoutes';
import { syncNotificationPermissionFromSystem } from '@/services/notifications/notificationPermissions';
import type { NotificationPermissionState } from '@/types/device';
import type { SleepPlanSnapshot } from '@/types/health';
import { nextUpcomingClockDate, normalizeClockMinutes } from '@/utils/sleepPlan';

export const SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID = 'sleep-preparation-reminder';

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

export async function syncSleepPreparationReminder(
  plan: SleepPlanSnapshot,
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

  const reminderClockMinutes = normalizeClockMinutes(plan.optimalBedtimeMinutes - 60);
  const triggerAt = nextUpcomingClockDate(reminderClockMinutes, options?.now);

  await Notifications.scheduleNotificationAsync({
    identifier: SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID,
    content: {
      title: 'Prepare for bed',
      body: `${brand.appName} says it is time to start winding down. Your optimal bedtime is around ${plan.optimalBedtime}.`,
      data: {
        [NOTIFICATION_ROUTE_KEY]: '/sleep',
      },
      sound: false,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: triggerAt,
    },
  });

  return {
    scheduled: true,
    permission: permissionResult.permission,
    reason: 'scheduled',
    triggerAt,
  };
}
