import * as Notifications from 'expo-notifications';

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

export function routeFromNotificationData(_data: Record<string, unknown> | undefined | null) {
  return null;
}
