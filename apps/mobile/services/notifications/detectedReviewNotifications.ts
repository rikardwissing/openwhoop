import type { SQLiteDatabase } from 'expo-sqlite';
import * as Notifications from 'expo-notifications';

import { formatClock, formatSqliteDateTime, minutesBetween, parseSqliteDateTime } from '@/utils/dateTime';

const DETECTED_REVIEW_NOTIFICATION_CHANNEL_ID = 'detected-review';
const DETECTED_ACTIVITY_READY_KIND = 'detected-activity-ready';
const DETECTED_SLEEP_READY_KIND = 'detected-sleep-ready';
const DETECTED_SLEEP_STARTED_KIND = 'detected-sleep-started';

interface ActivityReviewNotificationRow {
  activity: string;
  end: string;
  start: string;
}

interface SleepReviewNotificationRow {
  completion_status: string | null;
  end: string;
  sleep_id: string;
  start: string;
}

export interface DetectedReviewNotificationSnapshot {
  activityReadyEntities: ReadonlySet<string>;
  sleepReadyEntities: ReadonlySet<string>;
  sleepStartedEntities: ReadonlySet<string>;
}

export interface DetectedReviewNotificationResult {
  activityReadyCount: number;
  sleepReadyCount: number;
  sleepStartedCount: number;
}

function hasNotificationPermission(settings: Notifications.NotificationPermissionsStatus) {
  return settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

async function ensureDetectedReviewNotificationPermissionAsync() {
  const settings = await Notifications.getPermissionsAsync();
  return hasNotificationPermission(settings);
}

async function ensureDetectedReviewNotificationChannelAsync() {
  await Notifications.setNotificationChannelAsync(DETECTED_REVIEW_NOTIFICATION_CHANNEL_ID, {
    name: 'Detected sleep and activity',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {});
}

async function scheduleDetectedReviewNotificationAsync(content: {
  body: string;
  title: string;
}) {
  await ensureDetectedReviewNotificationChannelAsync();

  await Notifications.scheduleNotificationAsync({
    content: {
      title: content.title,
      body: content.body,
      sound: false,
    },
    trigger: {
      channelId: DETECTED_REVIEW_NOTIFICATION_CHANNEL_ID,
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

function activityEntityId(row: ActivityReviewNotificationRow) {
  return `${row.activity}:${row.start}`;
}

function sleepReadyEntityId(row: SleepReviewNotificationRow) {
  return row.sleep_id;
}

function sleepStartedEntityId(row: SleepReviewNotificationRow) {
  return row.start;
}

function describeTimeRange(startSql: string, endSql: string) {
  const start = parseSqliteDateTime(startSql);
  const end = parseSqliteDateTime(endSql);
  return `${formatClock(start)}-${formatClock(end)}`;
}

function describeDuration(startSql: string, endSql: string) {
  const minutes = minutesBetween(parseSqliteDateTime(startSql), parseSqliteDateTime(endSql));

  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    const hourLabel = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    return remainingMinutes === 0
      ? hourLabel
      : `${hourLabel} ${remainingMinutes} min`;
  }

  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function activityNotificationBody(rows: readonly ActivityReviewNotificationRow[]) {
  if (rows.length === 1) {
    const [row] = rows;
    return `${row.activity} from ${describeTimeRange(row.start, row.end)} is ready for review.`;
  }

  return `${rows.length} detected activities are ready for review.`;
}

function sleepReadyNotificationBody(rows: readonly SleepReviewNotificationRow[]) {
  if (rows.length === 1) {
    const [row] = rows;
    return `Sleep from ${describeTimeRange(row.start, row.end)} is ready for review.`;
  }

  return `${rows.length} sleeps are ready for review.`;
}

function sleepStartedNotificationBody(rows: readonly SleepReviewNotificationRow[]) {
  const latest = [...rows].sort((left, right) => right.end.localeCompare(left.end))[0];
  return `Sleep has started. ${describeDuration(latest.start, latest.end)} synced so far, through ${formatClock(parseSqliteDateTime(latest.end))}.`;
}

async function loadActivityReadyRows(db: SQLiteDatabase) {
  return db.getAllAsync<ActivityReviewNotificationRow>(
    `
      SELECT activity, start, end
      FROM activities
      WHERE source = 'detected'
        AND review_state = 'none'
      ORDER BY start ASC
    `,
  );
}

async function loadCompleteSleepRows(db: SQLiteDatabase) {
  return db.getAllAsync<SleepReviewNotificationRow>(
    `
      SELECT sleep_id, start, end, completion_status
      FROM sleep_cycles
      WHERE (source IS NULL OR source = 'detected')
        AND (review_state IS NULL OR review_state = 'none')
        AND COALESCE(completion_status, 'complete') = 'complete'
      ORDER BY start ASC
    `,
  );
}

async function loadInProgressSleepRows(db: SQLiteDatabase) {
  return db.getAllAsync<SleepReviewNotificationRow>(
    `
      SELECT sleep_id, start, end, completion_status
      FROM sleep_cycles
      WHERE (source IS NULL OR source = 'detected')
        AND (review_state IS NULL OR review_state = 'none')
        AND completion_status = 'in_progress'
      ORDER BY start ASC
    `,
  );
}

export async function loadDetectedReviewNotificationSnapshot(
  db: SQLiteDatabase,
): Promise<DetectedReviewNotificationSnapshot> {
  const [activityRows, completeSleepRows, inProgressSleepRows] = await Promise.all([
    loadActivityReadyRows(db),
    loadCompleteSleepRows(db),
    loadInProgressSleepRows(db),
  ]);

  return {
    activityReadyEntities: new Set(activityRows.map(activityEntityId)),
    sleepReadyEntities: new Set(completeSleepRows.map(sleepReadyEntityId)),
    sleepStartedEntities: new Set(inProgressSleepRows.map(sleepStartedEntityId)),
  };
}

async function reserveNewRows<Row>(
  db: SQLiteDatabase,
  deviceId: string,
  kind: string,
  rows: readonly Row[],
  previousEntities: ReadonlySet<string>,
  entityId: (row: Row) => string,
) {
  const reservedRows: Row[] = [];

  for (const row of rows) {
    const id = entityId(row);

    if (previousEntities.has(id)) {
      continue;
    }

    if (await reserveDeliveredNotification(db, deviceId, kind, id)) {
      reservedRows.push(row);
    }
  }

  return reservedRows;
}

export async function notifyForNewDetectedReviewItemsAsync(
  db: SQLiteDatabase,
  deviceId: string,
  previous: DetectedReviewNotificationSnapshot,
): Promise<DetectedReviewNotificationResult> {
  if (!(await ensureDetectedReviewNotificationPermissionAsync())) {
    return {
      activityReadyCount: 0,
      sleepReadyCount: 0,
      sleepStartedCount: 0,
    };
  }

  const [activityRows, completeSleepRows, inProgressSleepRows] = await Promise.all([
    loadActivityReadyRows(db),
    loadCompleteSleepRows(db),
    loadInProgressSleepRows(db),
  ]);
  const [newActivityRows, newCompleteSleepRows, newInProgressSleepRows] = await Promise.all([
    reserveNewRows(
      db,
      deviceId,
      DETECTED_ACTIVITY_READY_KIND,
      activityRows,
      previous.activityReadyEntities,
      activityEntityId,
    ),
    reserveNewRows(
      db,
      deviceId,
      DETECTED_SLEEP_READY_KIND,
      completeSleepRows,
      previous.sleepReadyEntities,
      sleepReadyEntityId,
    ),
    reserveNewRows(
      db,
      deviceId,
      DETECTED_SLEEP_STARTED_KIND,
      inProgressSleepRows,
      previous.sleepStartedEntities,
      sleepStartedEntityId,
    ),
  ]);

  if (newActivityRows.length > 0) {
    await scheduleDetectedReviewNotificationAsync({
      title: newActivityRows.length === 1 ? 'Activity ready for review' : 'Activities ready for review',
      body: activityNotificationBody(newActivityRows),
    });
  }

  if (newCompleteSleepRows.length > 0) {
    await scheduleDetectedReviewNotificationAsync({
      title: newCompleteSleepRows.length === 1 ? 'Sleep ready for review' : 'Sleeps ready for review',
      body: sleepReadyNotificationBody(newCompleteSleepRows),
    });
  }

  if (newInProgressSleepRows.length > 0) {
    await scheduleDetectedReviewNotificationAsync({
      title: 'Sleep detected',
      body: sleepStartedNotificationBody(newInProgressSleepRows),
    });
  }

  return {
    activityReadyCount: newActivityRows.length,
    sleepReadyCount: newCompleteSleepRows.length,
    sleepStartedCount: newInProgressSleepRows.length,
  };
}
