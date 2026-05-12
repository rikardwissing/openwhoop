import * as Notifications from 'expo-notifications';

const SLEEP_PREPARATION_REMINDER_NOTIFICATION_KIND = 'sleep-preparation-reminder';

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
  if (data?.route === '/sleep' || data?.kind === SLEEP_PREPARATION_REMINDER_NOTIFICATION_KIND) {
    return '/sleep';
  }

  return null;
}
