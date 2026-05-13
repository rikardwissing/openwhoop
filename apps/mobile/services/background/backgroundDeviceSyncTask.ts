import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { processPendingDerivedRefresh } from '@/data/sqlite/SQLiteHealthRepository';
import { openAppDatabaseAsync } from '@/db/appDatabase';
import {
  WearableSyncService,
  type SyncExecutionOutcome,
  type SyncRunOptions,
} from '@/services/ble/WearableSyncService';
import {
  writeLocalMetricsToAppleHealthIfAuthorized,
  type AppleHealthExportResult,
} from '@/services/appleHealthExport';
import {
  loadDetectedReviewNotificationSnapshot,
  notifyForNewDetectedReviewItemsAsync,
  type DetectedReviewNotificationResult,
} from '@/services/notifications/detectedReviewNotifications';
import {
  cancelMissingDeviceDataReminderNotificationsAsync,
  syncMissingDeviceDataReminderNotificationsAsync,
} from '@/services/notifications/missingDeviceDataReminders';
import { updateTonightWidgetFromDatabase } from '@/services/widgets/tonightWidget';

export const BACKGROUND_DEVICE_SYNC_TASK_NAME = 'unstrap-background-device-sync-task';
export const BACKGROUND_DEVICE_SYNC_INTERVAL_MINUTES = 15;
export const BACKGROUND_DEVICE_SYNC_TIME_BUDGET_MS = 4 * 60 * 1000;

const BACKGROUND_DEVICE_SYNC_NOTIFICATION_CHANNEL_ID = 'background-device-sync';
const LEGACY_SIMPLE_LOG_BACKGROUND_TASK_NAME = 'unstrap-simple-log-background-task';
const EMPTY_DETECTION_NOTIFICATION_RESULT: DetectedReviewNotificationResult = {
  activityReadyCount: 0,
  sleepReadyCount: 0,
  sleepStartedCount: 0,
};

export interface BackgroundDeviceSyncManualRunResult {
  appleHealthExport: AppleHealthExportResult | null;
  detectionNotifications: DetectedReviewNotificationResult;
  error: string | null;
  importedReadings: number;
  message: string;
  notificationPermissionGranted: boolean;
  processedDerivedRefresh: boolean;
  status: 'completed' | 'failed' | 'no_device' | 'paused' | 'skipped';
}

function hasNotificationPermission(settings: Notifications.NotificationPermissionsStatus) {
  return settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

function formatImportedReadings(count: number) {
  return `${count} ${count === 1 ? 'reading' : 'readings'}`;
}

function formatElapsedDuration(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatAppleHealthExportSuffix(result: AppleHealthExportResult | null) {
  if (!result || result.status !== 'success' || result.totals.exported === 0) {
    return '';
  }

  const count = result.totals.exported;
  return ` Wrote ${count} Apple Health ${count === 1 ? 'sample' : 'samples'}.`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Background sync failed.';
}

async function ensureBackgroundDeviceSyncNotificationPermissionAsync(requestPermission: boolean) {
  let settings = await Notifications.getPermissionsAsync();

  if (hasNotificationPermission(settings)) {
    return true;
  }

  if (requestPermission && settings.canAskAgain !== false) {
    settings = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: false,
        allowSound: true,
      },
    });
  }

  return hasNotificationPermission(settings);
}

async function ensureBackgroundDeviceSyncNotificationChannelAsync() {
  await Notifications.setNotificationChannelAsync(BACKGROUND_DEVICE_SYNC_NOTIFICATION_CHANNEL_ID, {
    name: 'Background device sync',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {});
}

async function scheduleBackgroundDeviceSyncNotificationAsync(content: {
  body: string;
  title: string;
}) {
  const settings = await Notifications.getPermissionsAsync();

  if (!hasNotificationPermission(settings)) {
    return null;
  }

  await ensureBackgroundDeviceSyncNotificationChannelAsync();

  return Notifications.scheduleNotificationAsync({
    content: {
      title: content.title,
      body: content.body,
      sound: false,
    },
    trigger: {
      channelId: BACKGROUND_DEVICE_SYNC_NOTIFICATION_CHANNEL_ID,
    },
  });
}

async function runBackgroundDeviceSyncTaskAsync() {
  const result = await executeBackgroundDeviceSyncAsync({
    requestNotificationPermission: false,
    triggerLabel: 'background processing',
    useExpirationListener: true,
  });

  return result.status === 'failed'
    ? BackgroundTask.BackgroundTaskResult.Failed
    : BackgroundTask.BackgroundTaskResult.Success;
}

async function executeBackgroundDeviceSyncAsync(options: {
  db?: Awaited<ReturnType<typeof openAppDatabaseAsync>>;
  requestNotificationPermission: boolean;
  service?: WearableSyncService;
  syncRunner?: (
    service: WearableSyncService,
    options: SyncRunOptions,
  ) => Promise<SyncExecutionOutcome>;
  triggerLabel: string;
  useExpirationListener: boolean;
}): Promise<BackgroundDeviceSyncManualRunResult> {
  const runStartedAtMs = Date.now();
  let db: Awaited<ReturnType<typeof openAppDatabaseAsync>> | null = null;
  let service: WearableSyncService | null = null;
  const ownsDatabase = !options.db;
  const ownsService = !options.service;
  const expirationController = new AbortController();
  let expirationSubscription: { remove: () => void } | null = null;
  const notificationPermissionGranted = await ensureBackgroundDeviceSyncNotificationPermissionAsync(
    options.requestNotificationPermission,
  );
  await ensureBackgroundDeviceSyncNotificationChannelAsync();

  try {
    db = options.db ?? await openAppDatabaseAsync();
    service = options.service ?? new WearableSyncService(db);

    if (options.useExpirationListener) {
      try {
        expirationSubscription = BackgroundTask.addExpirationListener(() => {
          expirationController.abort();
        });
      } catch {}
    }

    const deviceState = await service.getDeviceState();
    if (!deviceState.id) {
      await cancelMissingDeviceDataReminderNotificationsAsync().catch(() => {});

      return {
        appleHealthExport: null,
        detectionNotifications: EMPTY_DETECTION_NOTIFICATION_RESULT,
        error: null,
        importedReadings: 0,
        message: 'No wearable is selected, so background sync did not run.',
        notificationPermissionGranted,
        processedDerivedRefresh: false,
        status: 'no_device',
      };
    }

    const deviceName = deviceState.name?.trim() || 'wearable';
    await scheduleBackgroundDeviceSyncNotificationAsync({
      title: 'Background sync started',
      body: `Syncing ${deviceName} in the background. Triggered by ${options.triggerLabel}.`,
    });

    const syncOptions = {
      abortSignal: expirationController.signal,
      maxDurationMs: BACKGROUND_DEVICE_SYNC_TIME_BUDGET_MS,
    };
    const outcome = await (options.syncRunner
      ? options.syncRunner(service, syncOptions)
      : service.syncInBackground(syncOptions));
    const readings = formatImportedReadings(outcome.importedReadings);
    const pausedSafely = outcome.reason === 'time-budget' || outcome.reason === 'expiration';
    const status = pausedSafely ? 'paused' : outcome.status === 'skipped' ? 'skipped' : 'completed';

    let processedDerivedRefresh = false;
    let detectionNotifications = EMPTY_DETECTION_NOTIFICATION_RESULT;
    let appleHealthExport: AppleHealthExportResult | null = null;
    const shouldProcessDetectedReviewItems =
      outcome.status !== 'skipped' &&
      (!options.useExpirationListener || !pausedSafely);

    if (shouldProcessDetectedReviewItems) {
      const previousDetectionSnapshot = await loadDetectedReviewNotificationSnapshot(db);
      processedDerivedRefresh = await processPendingDerivedRefresh(db).catch(() => false);
      detectionNotifications = await notifyForNewDetectedReviewItemsAsync(
        db,
        deviceState.id,
        previousDetectionSnapshot,
      ).catch(() => EMPTY_DETECTION_NOTIFICATION_RESULT);

      const appleHealthExportDeadlineMs = options.useExpirationListener
        ? runStartedAtMs + BACKGROUND_DEVICE_SYNC_TIME_BUDGET_MS
        : undefined;

      appleHealthExport = await writeLocalMetricsToAppleHealthIfAuthorized(db, {
        deadlineMs: appleHealthExportDeadlineMs,
      }).catch((error) => {
        console.warn(
          '[apple-health] Export after sync failed',
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
    }

    const elapsed = formatElapsedDuration(Date.now() - runStartedAtMs);
    const appleHealthSuffix = formatAppleHealthExportSuffix(appleHealthExport);
    const completedBody =
      outcome.reason === 'expiration'
        ? `Paused safely after ${elapsed} because the system background window expired after importing ${readings}. Sync will continue later.`
        : outcome.reason === 'time-budget'
          ? `Paused safely after ${elapsed} with ${readings} imported. Sync will continue in a later background window.`
          : outcome.status === 'skipped'
            ? 'Skipped because another sync is already running.'
            : `Completed background sync in ${elapsed} with ${readings} imported.${appleHealthSuffix}`;

    await scheduleBackgroundDeviceSyncNotificationAsync({
      title:
        pausedSafely
          ? 'Background sync paused'
          : outcome.status === 'skipped'
            ? 'Background sync skipped'
            : 'Background sync completed',
      body: completedBody,
    });

    if (status === 'completed' || status === 'paused') {
      await syncMissingDeviceDataReminderNotificationsAsync(db, {
        dismissDelivered: outcome.importedReadings > 0,
        deviceName,
      }).catch(() => null);
      await updateTonightWidgetFromDatabase(db, {
        allowLiveActivityScheduling: false,
      }).catch(() => null);
    }

    return {
      appleHealthExport,
      detectionNotifications,
      error: null,
      importedReadings: outcome.importedReadings,
      message: completedBody,
      notificationPermissionGranted,
      processedDerivedRefresh,
      status,
    };
  } catch (error) {
    const message = errorMessage(error);
    await scheduleBackgroundDeviceSyncNotificationAsync({
      title: 'Background sync failed',
      body: message,
    });

    return {
      appleHealthExport: null,
      detectionNotifications: EMPTY_DETECTION_NOTIFICATION_RESULT,
      error: message,
      importedReadings: 0,
      message,
      notificationPermissionGranted,
      processedDerivedRefresh: false,
      status: 'failed',
    };
  } finally {
    expirationSubscription?.remove();
    if (service && ownsService) {
      await service.dispose().catch(() => {});
    }
    if (db && ownsDatabase) {
      await db.closeAsync().catch(() => {});
    }
  }
}

if (!TaskManager.isTaskDefined(BACKGROUND_DEVICE_SYNC_TASK_NAME)) {
  TaskManager.defineTask(BACKGROUND_DEVICE_SYNC_TASK_NAME, runBackgroundDeviceSyncTaskAsync);
}

export async function registerBackgroundDeviceSyncTaskAsync(options?: {
  requestNotificationPermission?: boolean;
}) {
  await ensureBackgroundDeviceSyncNotificationPermissionAsync(options?.requestNotificationPermission ?? false);
  await ensureBackgroundDeviceSyncNotificationChannelAsync();
  await unregisterLegacySimpleLogBackgroundTaskAsync();

  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_DEVICE_SYNC_TASK_NAME);

  if (!isRegistered) {
    await BackgroundTask.registerTaskAsync(BACKGROUND_DEVICE_SYNC_TASK_NAME, {
      minimumInterval: BACKGROUND_DEVICE_SYNC_INTERVAL_MINUTES,
    });
  }
}

export async function isBackgroundDeviceSyncTaskRegisteredAsync() {
  return TaskManager.isTaskRegisteredAsync(BACKGROUND_DEVICE_SYNC_TASK_NAME);
}

export async function runBackgroundDeviceSyncNowAsync(options?: {
  triggerLabel?: string;
}) {
  await registerBackgroundDeviceSyncTaskAsync({
    requestNotificationPermission: true,
  });

  return executeBackgroundDeviceSyncAsync({
    requestNotificationPermission: true,
    triggerLabel: options?.triggerLabel ?? 'manual trigger',
    useExpirationListener: false,
  });
}

export async function runBackgroundDeviceSyncWithServiceAsync(
  db: Awaited<ReturnType<typeof openAppDatabaseAsync>>,
  service: WearableSyncService,
  options?: {
    triggerLabel?: string;
  },
) {
  await registerBackgroundDeviceSyncTaskAsync({
    requestNotificationPermission: true,
  });

  return executeBackgroundDeviceSyncAsync({
    db,
    requestNotificationPermission: true,
    service,
    syncRunner: (activeService, syncOptions) => activeService.syncInBackground(syncOptions),
    triggerLabel: options?.triggerLabel ?? 'manual trigger',
    useExpirationListener: false,
  });
}

async function unregisterLegacySimpleLogBackgroundTaskAsync() {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(LEGACY_SIMPLE_LOG_BACKGROUND_TASK_NAME);

  if (isRegistered) {
    await BackgroundTask.unregisterTaskAsync(LEGACY_SIMPLE_LOG_BACKGROUND_TASK_NAME);
  }
}
