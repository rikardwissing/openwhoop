import * as Notifications from 'expo-notifications';

import type { NotificationPermissionState } from '@/types/device';

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

  return {
    permission: mapNotificationPermission(settings),
    baselineAt: null,
  };
}
