import type { SQLiteDatabase } from 'expo-sqlite';
import * as Notifications from 'expo-notifications';

import { parseSqliteDateTime } from '@/utils/dateTime';

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
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => {});
}

async function cancelScheduledMissingDeviceDataReminderNotificationsAsync() {
  await Promise.all(
    REMINDER_DELAYS.map((reminder) =>
      Notifications.cancelScheduledNotificationAsync(reminderIdentifier(reminder.id)).catch(() => {}),
    ),
  );
}

export async function cancelMissingDeviceDataReminderNotificationsAsync() {
  await cancelScheduledMissingDeviceDataReminderNotificationsAsync();
  await Promise.all(
    REMINDER_DELAYS.map((reminder) =>
      Notifications.dismissNotificationAsync(reminderIdentifier(reminder.id)).catch(() => {}),
    ),
  );
}

async function loadLatestDeviceDataAt(db: Pick<SQLiteDatabase, 'getFirstAsync'>) {
  const row = await db.getFirstAsync<{ time: string }>(
    'SELECT time FROM heart_rate ORDER BY time DESC LIMIT 1',
  );

  return row?.time ? parseSqliteDateTime(row.time) : null;
}

export async function syncMissingDeviceDataReminderNotificationsAsync(
  db: Pick<SQLiteDatabase, 'getFirstAsync'>,
  options: {
    deviceName: string;
    dismissDelivered?: boolean;
    now?: Date;
  },
) {
  const latestDataAt = await loadLatestDeviceDataAt(db);

  if (!latestDataAt) {
    await cancelMissingDeviceDataReminderNotificationsAsync();
    return {
      scheduledCount: 0,
    };
  }

  if (options.dismissDelivered) {
    await cancelMissingDeviceDataReminderNotificationsAsync();
  }

  return scheduleMissingDeviceDataReminderNotificationsAsync({
    dataAt: latestDataAt,
    deviceName: options.deviceName,
    now: options.now,
  });
}

async function scheduleMissingDeviceDataReminderNotificationsAsync(options: {
  dataAt: Date;
  deviceName: string;
  now?: Date;
}) {
  await cancelScheduledMissingDeviceDataReminderNotificationsAsync();

  const settings = await Notifications.getPermissionsAsync();
  if (!hasNotificationPermission(settings)) {
    return {
      scheduledCount: 0,
    };
  }

  await ensureReminderNotificationChannelAsync();

  const now = options.now ?? new Date();
  const deviceName = options.deviceName.trim() || 'your wearable';
  const reminders = REMINDER_DELAYS
    .map((reminder) => ({
      ...reminder,
      triggerAt: new Date(options.dataAt.getTime() + reminder.delayMs),
    }))
    .filter((reminder) => reminder.triggerAt.getTime() > now.getTime());

  await Promise.all(
    reminders.map((reminder) =>
      Notifications.scheduleNotificationAsync({
        identifier: reminderIdentifier(reminder.id),
        content: {
          title: 'Sync your wearable',
          body: `We may be missing ${deviceName} data. It has been about ${reminder.label} since data was last received. Open Unstrap to sync your device.`,
          interruptionLevel: 'active',
          priority: Notifications.AndroidNotificationPriority.HIGH,
          sound: false,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          channelId: MISSING_DEVICE_DATA_REMINDER_CHANNEL_ID,
          date: reminder.triggerAt,
        },
      }),
    ),
  );

  return {
    scheduledCount: reminders.length,
  };
}
