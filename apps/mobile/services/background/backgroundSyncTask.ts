import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { openAppDatabaseAsync } from '@/db/appDatabase';
import {
  deliverBackgroundSyncRunNotification,
  deliverNewBackgroundNotifications,
} from '@/services/background/backgroundSyncNotifications';
import {
  clearBackgroundSyncState,
  getBackgroundSyncState,
  recordBackgroundRunResult,
  recordBackgroundRunStart,
  setBackgroundSyncPairedDevice,
  updateNotificationPermissionState,
} from '@/services/background/backgroundSyncState';
import { WearableSyncService } from '@/services/ble/WearableSyncService';
import { formatSqliteDateTime } from '@/utils/dateTime';
import type { BackgroundSyncDiagnostics, NotificationPermissionState } from '@/types/device';

export const BACKGROUND_SYNC_TASK_NAME = 'btwearable-background-sync';
export const BACKGROUND_SYNC_MIN_INTERVAL_MINUTES = 15;

if (typeof Notifications.setNotificationHandler === 'function') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

function isPermissionGranted(permission: NotificationPermissionState) {
  return permission === 'granted' || permission === 'provisional';
}

function isTransientBackgroundSyncError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('bluetooth') ||
    message.includes('unable to connect') ||
    message.includes('could not find') ||
    message.includes('scan again and keep the wearable awake') ||
    message.includes('sync-lock-active')
  );
}

function mapNotificationPermission(settings: Notifications.NotificationPermissionsStatus): NotificationPermissionState {
  if (settings.granted) {
    return 'granted';
  }

  if (settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return 'provisional';
  }

  return 'denied';
}

function mapBackgroundTaskStatus(status: BackgroundTask.BackgroundTaskStatus): BackgroundSyncDiagnostics['apiStatus'] {
  return status === BackgroundTask.BackgroundTaskStatus.Available ? 'available' : 'restricted';
}

export async function getBackgroundSyncDiagnostics(): Promise<BackgroundSyncDiagnostics> {
  let apiStatus: BackgroundSyncDiagnostics['apiStatus'] = 'unknown';
  let isTaskRegistered = false;

  try {
    apiStatus = mapBackgroundTaskStatus(await BackgroundTask.getStatusAsync());
  } catch {}

  try {
    isTaskRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK_NAME);
  } catch {}

  return {
    apiStatus,
    isTaskDefined: TaskManager.isTaskDefined(BACKGROUND_SYNC_TASK_NAME),
    isTaskRegistered,
    minimumIntervalMinutes: BACKGROUND_SYNC_MIN_INTERVAL_MINUTES,
  };
}

export async function triggerBackgroundSyncForTesting() {
  if (!__DEV__) {
    return false;
  }

  console.log('Triggering background sync for testing...');



  await BackgroundTask.triggerTaskWorkerForTestingAsync();
  return true;
}

export async function syncNotificationPermissionFromSystem(
  requestPermission: boolean,
) {
  const db = await openAppDatabaseAsync();

  try {
    const current = await getBackgroundSyncState(db);
    let settings = await Notifications.getPermissionsAsync();

    if (requestPermission && !settings.granted && settings.canAskAgain !== false) {
      settings = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: false,
          allowSound: true,
        },
      });
    }

    const permission = mapNotificationPermission(settings);
    const gainedPermission = !isPermissionGranted(current.notificationPermission) && isPermissionGranted(permission);
    const baselineAt = gainedPermission
      ? formatSqliteDateTime(new Date())
      : current.notificationBaselineAt;

    await updateNotificationPermissionState(db, permission, baselineAt);

    return {
      permission,
      baselineAt,
    };
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

export async function ensureBackgroundSyncRegistered(deviceId: string | null) {
  if (Platform.OS !== 'ios') {
    return;
  }

  if (!deviceId) {
    await disableBackgroundSync();
    return;
  }

  const db = await openAppDatabaseAsync();

  try {
    await setBackgroundSyncPairedDevice(db, deviceId);
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK_NAME, {
      minimumInterval: BACKGROUND_SYNC_MIN_INTERVAL_MINUTES,
    });

    const current = await getBackgroundSyncState(db);
    const settings = await Notifications.getPermissionsAsync();
    const permission = mapNotificationPermission(settings);
    const baselineAt =
      !isPermissionGranted(current.notificationPermission) && isPermissionGranted(permission)
        ? formatSqliteDateTime(new Date())
        : current.notificationBaselineAt;

    await updateNotificationPermissionState(db, permission, baselineAt);
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

export async function enableBackgroundSyncAfterPairing(deviceId: string) {
  if (Platform.OS !== 'ios') {
    return;
  }

  const db = await openAppDatabaseAsync();

  try {
    await setBackgroundSyncPairedDevice(db, deviceId);
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK_NAME, {
      minimumInterval: BACKGROUND_SYNC_MIN_INTERVAL_MINUTES,
    });

    const current = await getBackgroundSyncState(db);
    let settings = await Notifications.getPermissionsAsync();
    if (!settings.granted && settings.canAskAgain !== false) {
      settings = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: false,
          allowSound: false,
        },
      });
    }

    const permission = mapNotificationPermission(settings);
    const baselineAt =
      !isPermissionGranted(current.notificationPermission) && isPermissionGranted(permission)
        ? formatSqliteDateTime(new Date())
        : current.notificationBaselineAt;

    await updateNotificationPermissionState(db, permission, baselineAt);
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

export async function disableBackgroundSync() {
  if (Platform.OS !== 'ios') {
    return;
  }

  const db = await openAppDatabaseAsync();

  try {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK_NAME);
    await clearBackgroundSyncState(db);
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

TaskManager.defineTask(BACKGROUND_SYNC_TASK_NAME, async () => {
  if (Platform.OS !== 'ios') {
    return BackgroundTask.BackgroundTaskResult.Success;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Hello world',
      body: 'Hello world',
      sound: 'default',
    },
    trigger: null,
  }).catch(() => {});

  const db = await openAppDatabaseAsync();
  const service = new WearableSyncService(db);
  const startedAt = formatSqliteDateTime(new Date());
  let recordedDeviceId: string | null = null;

  try {
    const backgroundState = await getBackgroundSyncState(db);
    recordedDeviceId = backgroundState.pairedDeviceId;
    await recordBackgroundRunStart(db, {
      deviceId: recordedDeviceId,
      source: 'background',
      startedAt,
    });

    const selected = await service.getDeviceState();
    if (!selected.id) {
      const finishedAt = formatSqliteDateTime(new Date());
      await recordBackgroundRunResult(db, {
        deviceId: recordedDeviceId,
        source: 'background',
        result: 'skipped',
        finishedAt,
        importedReadings: 0,
        error: 'No wearable was selected when the background task started.',
      });
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    const selectedDeviceId = selected.id!;

    if (recordedDeviceId !== selectedDeviceId) {
      recordedDeviceId = selectedDeviceId;
      await recordBackgroundRunStart(db, {
        deviceId: recordedDeviceId,
        source: 'background',
        startedAt,
      });
    }

    const settings = await Notifications.getPermissionsAsync();
    const current = await getBackgroundSyncState(db);
    const permission = mapNotificationPermission(settings);
    const baselineAt =
      !isPermissionGranted(current.notificationPermission) && isPermissionGranted(permission)
        ? startedAt
        : current.notificationBaselineAt;
    await updateNotificationPermissionState(db, permission, baselineAt);

    const outcome = await service.syncInBackground();
    if (outcome.status === 'success') {
      await deliverNewBackgroundNotifications(db, selectedDeviceId);
    }

    await recordBackgroundRunResult(db, {
      deviceId: selectedDeviceId,
      source: 'background',
      result: outcome.status === 'success' ? 'success' : 'skipped',
      finishedAt: outcome.completedAt,
      importedReadings: outcome.importedReadings,
      error: outcome.status === 'success' ? null : outcome.reason ?? null,
    });
    await deliverBackgroundSyncRunNotification(db, {
      deviceId: selectedDeviceId,
      result: outcome.status === 'success' ? 'success' : 'skipped',
      finishedAt: outcome.completedAt,
      importedReadings: outcome.importedReadings,
      error: outcome.status === 'success' ? null : outcome.reason ?? null,
    });

    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (error) {
    const selected = await service.getDeviceState().catch(() => null);
    const selectedDeviceId = selected?.id ?? null;
    if (selectedDeviceId) {
      recordedDeviceId = selectedDeviceId;
    }

    const transient = isTransientBackgroundSyncError(error);
    const finishedAt = formatSqliteDateTime(new Date());
    const errorRecord =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
    const errorMessage: string =
      errorRecord !== null && typeof errorRecord.message === 'string'
        ? errorRecord.message
        : 'Background sync failed.';

    if (recordedDeviceId) {
      const resolvedDeviceId = recordedDeviceId!;
      await recordBackgroundRunResult(db, {
        deviceId: resolvedDeviceId,
        source: 'background',
        result: transient ? 'skipped' : 'error',
        finishedAt,
        importedReadings: 0,
        error: errorMessage,
      }).catch(() => {});
      await deliverBackgroundSyncRunNotification(db, {
        deviceId: resolvedDeviceId,
        result: transient ? 'skipped' : 'error',
        finishedAt,
        importedReadings: 0,
        error: errorMessage,
      }).catch(() => {});

      if (transient) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }
    }

    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    await service.dispose().catch(() => {});
    await db.closeAsync().catch(() => {});
  }
});
