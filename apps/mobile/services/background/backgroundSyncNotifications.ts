import * as Notifications from 'expo-notifications';
import type { SQLiteDatabase } from 'expo-sqlite';

import { brand } from '@/constants/brand';
import { getBackgroundSyncState } from '@/services/background/backgroundSyncState';
import type { BackgroundSyncResult } from '@/types/device';

type DeliveredNotificationKind = 'sleep' | 'nap' | 'activity';

interface SleepNotificationRow {
  sleep_id: string;
  end: string;
}

interface ActivityNotificationRow {
  id: number;
  activity: 'Nap' | 'Activity' | 'Walk' | 'Workout';
  start: string;
  end: string;
}

export const NOTIFICATION_ROUTE_KEY = 'route';

function isPermissionGranted(permission: string) {
  return permission === 'granted' || permission === 'provisional';
}

function buildNotificationIdentifier(deviceId: string, kind: DeliveredNotificationKind, entityId: string) {
  return `${kind}:${deviceId}:${entityId}`;
}

function buildBackgroundSyncNotificationIdentifier(
  deviceId: string,
  result: BackgroundSyncResult,
  finishedAt: string,
) {
  return `background-sync:${deviceId}:${result}:${finishedAt}`;
}

function buildBackgroundSyncNotificationContent(params: {
  importedReadings: number;
  result: BackgroundSyncResult;
  error: string | null;
}) {
  switch (params.result) {
    case 'success':
      return {
        title: 'Background sync complete',
        body:
          params.importedReadings > 0
            ? `${brand.appName} synced ${params.importedReadings} new reading${params.importedReadings === 1 ? '' : 's'} in the background. Your data is unlocked and ready.`
            : `${brand.appName} checked your wearable in the background and found no new readings.`,
      };
    case 'skipped':
      return {
        title: 'Background sync skipped',
        body: params.error
          ? `${brand.appName} skipped this background sync: ${params.error}`
          : `${brand.appName} skipped this background sync and will try again later.`,
      };
    case 'error':
      return {
        title: 'Background sync failed',
        body: params.error
          ? `${brand.appName} hit a background sync error: ${params.error}`
          : `${brand.appName} hit a background sync error. Open Settings for more details.`,
      };
    default:
      return {
        title: 'Background sync update',
        body: `${brand.appName} finished a background sync run.`,
      };
  }
}

async function markNotificationDelivered(
  db: SQLiteDatabase,
  deviceId: string,
  kind: DeliveredNotificationKind,
  entityId: string,
) {
  await db.runAsync(
    `
      INSERT INTO delivered_notifications (device_id, kind, entity_id, delivered_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(device_id, kind, entity_id) DO NOTHING
    `,
    deviceId,
    kind,
    entityId,
  );
}

async function loadNewSleepNotifications(db: SQLiteDatabase, deviceId: string, baselineAt: string) {
  return db.getAllAsync<SleepNotificationRow>(
    `
      SELECT sleep_id, end
      FROM sleep_cycles
      WHERE end > ?
        AND NOT EXISTS (
          SELECT 1
          FROM delivered_notifications AS delivered
          WHERE delivered.device_id = ?
            AND delivered.kind = 'sleep'
            AND delivered.entity_id = sleep_cycles.sleep_id
        )
      ORDER BY end ASC
    `,
    baselineAt,
    deviceId,
  );
}

async function loadNewActivityNotifications(db: SQLiteDatabase, deviceId: string, baselineAt: string) {
  return db.getAllAsync<ActivityNotificationRow>(
    `
      SELECT activity, start, end
      , id
      FROM activities
      WHERE end > ?
        AND NOT EXISTS (
          SELECT 1
          FROM delivered_notifications AS delivered
          WHERE delivered.device_id = ?
            AND delivered.kind = CASE activities.activity WHEN 'Nap' THEN 'nap' ELSE 'activity' END
            AND delivered.entity_id = CAST(activities.id AS TEXT)
        )
      ORDER BY end ASC
    `,
    baselineAt,
    deviceId,
  );
}

export function routeFromNotificationData(data: Record<string, unknown> | undefined | null) {
  const value = data?.[NOTIFICATION_ROUTE_KEY];
  return typeof value === 'string' ? value : null;
}

export async function deliverBackgroundSyncRunNotification(
  db: SQLiteDatabase,
  params: {
    deviceId: string;
    result: BackgroundSyncResult;
    finishedAt: string;
    importedReadings: number;
    error: string | null;
  },
) {
  const state = await getBackgroundSyncState(db);
  if (!isPermissionGranted(state.notificationPermission)) {
    return false;
  }

  const identifier = buildBackgroundSyncNotificationIdentifier(
    params.deviceId,
    params.result,
    params.finishedAt,
  );
  const content = buildBackgroundSyncNotificationContent(params);

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title: content.title,
      body: content.body,
      data: {
        [NOTIFICATION_ROUTE_KEY]: '/settings',
      },
      sound: false,
    },
    trigger: null,
  });

  return true;
}

export async function deliverNewBackgroundNotifications(db: SQLiteDatabase, deviceId: string) {
  const state = await getBackgroundSyncState(db);
  if (!isPermissionGranted(state.notificationPermission) || !state.notificationBaselineAt) {
    return 0;
  }

  const baselineAt = state.notificationBaselineAt;
  const [sleepRows, activityRows] = await Promise.all([
    loadNewSleepNotifications(db, deviceId, baselineAt),
    loadNewActivityNotifications(db, deviceId, baselineAt),
  ]);

  let deliveredCount = 0;

  for (const row of sleepRows) {
    const identifier = buildNotificationIdentifier(deviceId, 'sleep', row.sleep_id);
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: 'Sleep detected',
        body: 'A newly synced overnight sleep is ready in the Sleep tab.',
        data: {
          [NOTIFICATION_ROUTE_KEY]: '/sleep',
        },
        sound: false,
      },
      trigger: null,
    });
    await markNotificationDelivered(db, deviceId, 'sleep', row.sleep_id);
    deliveredCount += 1;
  }

  for (const row of activityRows) {
    const kind: DeliveredNotificationKind = row.activity === 'Nap' ? 'nap' : 'activity';
    const entityId = String(row.id);
    const identifier = buildNotificationIdentifier(deviceId, kind, entityId);
    const activityLabel = row.activity === 'Nap' ? 'Nap' : row.activity;

    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: row.activity === 'Nap' ? 'Nap detected' : `${activityLabel} detected`,
        body:
          row.activity === 'Nap'
            ? 'A newly synced nap is ready in the Sleep tab.'
            : `A completed ${activityLabel.toLowerCase()} session has been synced and is ready in Wellness.`,
        data: {
          [NOTIFICATION_ROUTE_KEY]: row.activity === 'Nap' ? '/sleep' : '/wellness',
        },
        sound: false,
      },
      trigger: null,
    });

    await markNotificationDelivered(db, deviceId, kind, entityId);
    deliveredCount += 1;
  }

  return deliveredCount;
}
