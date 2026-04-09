import * as Notifications from 'expo-notifications';

import { openAppDatabaseAsync } from '@/db/appDatabase';
import {
  getBackgroundSyncState,
  updateNotificationPermissionState,
} from '@/services/background/backgroundSyncState';
import type { NotificationPermissionState } from '@/types/device';
import { formatSqliteDateTime } from '@/utils/dateTime';

function isPermissionGranted(permission: NotificationPermissionState) {
  return permission === 'granted' || permission === 'provisional';
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

export async function syncNotificationPermissionFromSystem(requestPermission: boolean) {
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
    const gainedPermission =
      !isPermissionGranted(current.notificationPermission) && isPermissionGranted(permission);
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