import * as Notifications from 'expo-notifications';

export const NOTIFICATION_ROUTE_KEY = 'route';

const NOTIFICATION_ROUTES = new Set([
  '/',
  '/history',
  '/live-events',
  '/settings',
  '/sleep',
  '/trends',
  '/wellness',
]);

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
  return typeof value === 'string' && NOTIFICATION_ROUTES.has(value) ? value : null;
}
