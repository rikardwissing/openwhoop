import * as Notifications from 'expo-notifications';

export const NOTIFICATION_ROUTE_KEY = 'route';

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

export function routeFromNotificationData(data: Record<string, unknown> | undefined | null) {
  const value = data?.[NOTIFICATION_ROUTE_KEY];
  return typeof value === 'string' ? value : null;
}