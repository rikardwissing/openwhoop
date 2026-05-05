import type { SQLiteDatabase } from 'expo-sqlite';
import * as Notifications from 'expo-notifications';

import { EventNumber } from '@/services/ble/constants';
import type { DeviceEventPacket } from '@/services/ble/codec';
import { NOTIFICATION_ROUTE_KEY } from '@/services/notifications/notificationRouting';
import { formatSqliteDateTime } from '@/utils/dateTime';

const WEARABLE_NOTIFICATION_CHANNEL_ID = 'wearable-events';
const WEARABLE_EVENT_NOTIFICATION_KIND = 'wearable-event';
const WEARABLE_BATTERY_NOTIFICATION_KIND = 'wearable-battery-threshold';
const WEARABLE_NOTIFICATION_ROUTE = '/live-events';

const BATTERY_THRESHOLDS = [
  {
    entityId: 'below-20',
    percent: 20,
    title: 'Wearable battery low',
    body: (deviceName: string, batteryPercent: number) =>
      `${deviceName} battery is ${batteryPercent}%. Charge it soon.`,
  },
  {
    entityId: 'below-10',
    percent: 10,
    title: 'Wearable battery very low',
    body: (deviceName: string, batteryPercent: number) =>
      `${deviceName} battery is ${batteryPercent}%. Charge it now to avoid missing data.`,
  },
  {
    entityId: 'below-5',
    percent: 5,
    title: 'Wearable battery critical',
    body: (deviceName: string, batteryPercent: number) =>
      `${deviceName} battery is ${batteryPercent}%. It may shut down soon.`,
  },
] as const;

type BatteryThreshold = typeof BATTERY_THRESHOLDS[number];

interface WearableNotificationContent {
  body: string;
  title: string;
}

function hasNotificationPermission(settings: Notifications.NotificationPermissionsStatus) {
  return settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

function resolveNotificationDeviceName(deviceName: string | null | undefined) {
  return deviceName?.trim() || 'Your wearable';
}

async function ensureWearableNotificationPermissionAsync() {
  const settings = await Notifications.getPermissionsAsync();
  return hasNotificationPermission(settings);
}

async function ensureWearableNotificationChannelAsync() {
  await Notifications.setNotificationChannelAsync(WEARABLE_NOTIFICATION_CHANNEL_ID, {
    name: 'Wearable alerts',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {});
}

async function scheduleWearableNotificationAsync(content: WearableNotificationContent) {
  await ensureWearableNotificationChannelAsync();

  await Notifications.scheduleNotificationAsync({
    content: {
      title: content.title,
      body: content.body,
      data: {
        [NOTIFICATION_ROUTE_KEY]: WEARABLE_NOTIFICATION_ROUTE,
      },
      sound: false,
    },
    trigger: {
      channelId: WEARABLE_NOTIFICATION_CHANNEL_ID,
    },
  });
}

async function reserveDeliveredNotification(
  db: SQLiteDatabase,
  deviceId: string,
  kind: string,
  entityId: string,
) {
  const result = await db.runAsync(
    `
      INSERT OR IGNORE INTO delivered_notifications (device_id, kind, entity_id, delivered_at)
      VALUES (?, ?, ?, ?)
    `,
    deviceId,
    kind,
    entityId,
    formatSqliteDateTime(new Date()),
  );

  return !('changes' in result) || result.changes > 0;
}

async function markDeliveredNotification(
  db: SQLiteDatabase,
  deviceId: string,
  kind: string,
  entityId: string,
) {
  await reserveDeliveredNotification(db, deviceId, kind, entityId);
}

function notificationForWearableEvent(
  event: DeviceEventPacket,
  deviceName: string | null | undefined,
): WearableNotificationContent | null {
  const resolvedDeviceName = resolveNotificationDeviceName(deviceName);

  switch (event.event) {
    case EventNumber.BatteryLevel:
      return {
        title: 'Battery level received',
        body: `${resolvedDeviceName} reported ${event.percent}% battery.`,
      };
    case EventNumber.WristOn:
      return {
        title: 'Wearable on body',
        body: `${resolvedDeviceName} is back on body.`,
      };
    case EventNumber.WristOff:
      return {
        title: 'Wearable off body',
        body: `${resolvedDeviceName} was taken off body.`,
      };
    case EventNumber.ChargingOn:
      return {
        title: 'Wearable charging',
        body: `${resolvedDeviceName} started charging.`,
      };
    case EventNumber.ChargingOff:
      return {
        title: 'Wearable unplugged',
        body: `${resolvedDeviceName} stopped charging.`,
      };
    case EventNumber.DoubleTap:
      return {
        title: 'Device double tapped',
        body: `${resolvedDeviceName} was double tapped.`,
      };
    case EventNumber.HighFreqSyncPrompt:
      return {
        title: 'Sync prompt received',
        body: `${resolvedDeviceName} requested a high-frequency sync.`,
      };
    default:
      return null;
  }
}

function batteryThresholdForPercent(batteryPercent: number): BatteryThreshold | null {
  if (batteryPercent < 5) {
    return BATTERY_THRESHOLDS[2];
  }

  if (batteryPercent < 10) {
    return BATTERY_THRESHOLDS[1];
  }

  if (batteryPercent < 20) {
    return BATTERY_THRESHOLDS[0];
  }

  return null;
}

async function resetLowBatteryNotificationsIfRecovered(
  db: SQLiteDatabase,
  deviceId: string,
  batteryPercent: number,
) {
  if (batteryPercent < 20) {
    return;
  }

  await db.runAsync(
    `
      DELETE FROM delivered_notifications
      WHERE device_id = ?
        AND kind = ?
        AND entity_id IN (?, ?, ?)
    `,
    deviceId,
    WEARABLE_BATTERY_NOTIFICATION_KIND,
    BATTERY_THRESHOLDS[0].entityId,
    BATTERY_THRESHOLDS[1].entityId,
    BATTERY_THRESHOLDS[2].entityId,
  );
}

async function markImpliedBatteryThresholdsDelivered(
  db: SQLiteDatabase,
  deviceId: string,
  threshold: BatteryThreshold,
) {
  const impliedThresholds = BATTERY_THRESHOLDS.filter(
    (candidate) => candidate.percent > threshold.percent,
  );

  await Promise.all(
    impliedThresholds.map((candidate) =>
      markDeliveredNotification(
        db,
        deviceId,
        WEARABLE_BATTERY_NOTIFICATION_KIND,
        candidate.entityId,
      ),
    ),
  );
}

export async function notifyForWearableEventAsync(
  db: SQLiteDatabase,
  deviceId: string,
  deviceName: string | null | undefined,
  event: DeviceEventPacket,
) {
  const content = notificationForWearableEvent(event, deviceName);

  if (!content || !(await ensureWearableNotificationPermissionAsync())) {
    return false;
  }

  const entityId = `${event.event}:${event.unix}`;
  const reserved = await reserveDeliveredNotification(
    db,
    deviceId,
    WEARABLE_EVENT_NOTIFICATION_KIND,
    entityId,
  );

  if (!reserved) {
    return false;
  }

  await scheduleWearableNotificationAsync(content);
  return true;
}

export async function notifyForWearableBatteryLevelAsync(
  db: SQLiteDatabase,
  deviceId: string,
  deviceName: string | null | undefined,
  batteryPercent: number,
) {
  const roundedBatteryPercent = Math.max(0, Math.min(100, Math.round(batteryPercent)));
  await resetLowBatteryNotificationsIfRecovered(db, deviceId, roundedBatteryPercent);

  const threshold = batteryThresholdForPercent(roundedBatteryPercent);
  if (!threshold || !(await ensureWearableNotificationPermissionAsync())) {
    return false;
  }

  const reserved = await reserveDeliveredNotification(
    db,
    deviceId,
    WEARABLE_BATTERY_NOTIFICATION_KIND,
    threshold.entityId,
  );

  if (!reserved) {
    return false;
  }

  await markImpliedBatteryThresholdsDelivered(db, deviceId, threshold);
  await scheduleWearableNotificationAsync({
    title: threshold.title,
    body: threshold.body(resolveNotificationDeviceName(deviceName), roundedBatteryPercent),
  });

  return true;
}
