import * as Notifications from 'expo-notifications';

const MISSING_DEVICE_DATA_REMINDER_CHANNEL_ID = 'missing-device-data-reminders';
const REMINDER_ID_PREFIX = 'missing-device-data-reminder';

const REMINDER_DELAYS = [
  { id: '3h', label: '3 hours', delayMs: 3 * 60 * 60 * 1000 },
  { id: '6h', label: '6 hours', delayMs: 6 * 60 * 60 * 1000 },
  { id: '12h', label: '12 hours', delayMs: 12 * 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', delayMs: 24 * 60 * 60 * 1000 },
  { id: '2d', label: '2 days', delayMs: 2 * 24 * 60 * 60 * 1000 },
  { id: '3d', label: '3 days', delayMs: 3 * 24 * 60 * 60 * 1000 },
  { id: '5d', label: '5 days', delayMs: 5 * 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', delayMs: 7 * 24 * 60 * 60 * 1000 },
];

function hasNotificationPermission(settings: Notifications.NotificationPermissionsStatus) {
  return settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

function reminderIdentifier(id: string) {
  return `${REMINDER_ID_PREFIX}-${id}`;
}

async function ensureReminderNotificationChannelAsync() {
  await Notifications.setNotificationChannelAsync(MISSING_DEVICE_DATA_REMINDER_CHANNEL_ID, {
    name: 'Missing device data reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {});
}

export async function cancelMissingDeviceDataReminderNotificationsAsync() {
  await Promise.all(
    REMINDER_DELAYS.map((reminder) =>
      Notifications.cancelScheduledNotificationAsync(reminderIdentifier(reminder.id)).catch(() => {}),
    ),
  );
}

export async function scheduleMissingDeviceDataReminderNotificationsAsync(options: {
  deviceName: string;
  syncedAt?: Date;
}) {
  await cancelMissingDeviceDataReminderNotificationsAsync();

  const settings = await Notifications.getPermissionsAsync();
  if (!hasNotificationPermission(settings)) {
    return {
      scheduledCount: 0,
    };
  }

  await ensureReminderNotificationChannelAsync();

  const syncedAt = options.syncedAt ?? new Date();
  const deviceName = options.deviceName.trim() || 'your wearable';

  await Promise.all(
    REMINDER_DELAYS.map((reminder) =>
      Notifications.scheduleNotificationAsync({
        identifier: reminderIdentifier(reminder.id),
        content: {
          title: 'Sync your wearable',
          body: `We may be missing ${deviceName} data. It has been about ${reminder.label} since the last sync. Open Unstrap to sync your device.`,
          sound: false,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(syncedAt.getTime() + reminder.delayMs),
        },
      }),
    ),
  );

  return {
    scheduledCount: REMINDER_DELAYS.length,
  };
}
