import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { NOTIFICATION_ROUTE_KEY } from '@/services/notifications/notificationRouting';

export const SIMPLE_LOG_BACKGROUND_TASK_NAME = 'unstrap-simple-log-background-task';

const SIMPLE_LOG_BACKGROUND_TASK_INTERVAL_MINUTES = 15;
const SIMPLE_LOG_BACKGROUND_TASK_NOTIFICATION_CHANNEL_ID = 'background-task-log';

type SimpleLogBackgroundTaskRunMode = 'expo-worker' | 'manual';

export interface SimpleLogBackgroundTaskRunResult {
  loggedAt: string | null;
  mode: SimpleLogBackgroundTaskRunMode;
  notificationId: string | null;
  notificationPermissionGranted: boolean;
  triggered: boolean;
}

function hasNotificationPermission(settings: Notifications.NotificationPermissionsStatus) {
  return settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

async function ensureSimpleLogNotificationPermissionAsync() {
  let settings = await Notifications.getPermissionsAsync();

  if (hasNotificationPermission(settings)) {
    return true;
  }

  if (settings.canAskAgain === false) {
    return false;
  }

  settings = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: false,
      allowSound: true,
    },
  });

  return hasNotificationPermission(settings);
}

async function scheduleSimpleLogNotificationAsync(loggedAt: string) {
  const settings = await Notifications.getPermissionsAsync();

  if (!hasNotificationPermission(settings)) {
    console.warn('[Unstrap] Simple background task notification skipped because notifications are not permitted.');
    return null;
  }

  await Notifications.setNotificationChannelAsync(SIMPLE_LOG_BACKGROUND_TASK_NOTIFICATION_CHANNEL_ID, {
    name: 'Background task log',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {});

  return Notifications.scheduleNotificationAsync({
    content: {
      title: 'Background task ran',
      body: `Simple log task ran at ${loggedAt}.`,
      data: {
        [NOTIFICATION_ROUTE_KEY]: '/settings',
      },
      sound: false,
    },
    trigger: {
      channelId: SIMPLE_LOG_BACKGROUND_TASK_NOTIFICATION_CHANNEL_ID,
    },
  });
}

async function executeSimpleLogBackgroundTask(mode: SimpleLogBackgroundTaskRunMode) {
  const loggedAt = new Date().toISOString();
  console.log(`[Unstrap] Simple background task ran via ${mode} at ${loggedAt}.`);
  const notificationId = await scheduleSimpleLogNotificationAsync(loggedAt);
  return {
    loggedAt,
    notificationId,
  };
}

if (!TaskManager.isTaskDefined(SIMPLE_LOG_BACKGROUND_TASK_NAME)) {
  TaskManager.defineTask(SIMPLE_LOG_BACKGROUND_TASK_NAME, async () => {
    try {
      await executeSimpleLogBackgroundTask('expo-worker');
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
      console.error('[Unstrap] Simple background task failed.', error);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerSimpleLogBackgroundTaskAsync() {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(SIMPLE_LOG_BACKGROUND_TASK_NAME);

  if (!isRegistered) {
    await BackgroundTask.registerTaskAsync(SIMPLE_LOG_BACKGROUND_TASK_NAME, {
      minimumInterval: SIMPLE_LOG_BACKGROUND_TASK_INTERVAL_MINUTES,
    });
  }
}

export async function runSimpleLogBackgroundTaskAsync(): Promise<SimpleLogBackgroundTaskRunResult> {
  await registerSimpleLogBackgroundTaskAsync();
  const notificationPermissionGranted = await ensureSimpleLogNotificationPermissionAsync();

  if (__DEV__) {
    const triggered = await BackgroundTask.triggerTaskWorkerForTestingAsync();
    return {
      loggedAt: null,
      mode: 'expo-worker',
      notificationId: null,
      notificationPermissionGranted,
      triggered,
    };
  }

  const result = await executeSimpleLogBackgroundTask('manual');
  return {
    loggedAt: result.loggedAt,
    mode: 'manual',
    notificationId: result.notificationId,
    notificationPermissionGranted,
    triggered: false,
  };
}
