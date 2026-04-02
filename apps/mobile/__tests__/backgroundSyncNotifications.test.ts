jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
}));

import * as Notifications from 'expo-notifications';

import {
  deliverBackgroundSyncRunNotification,
  deliverNewBackgroundNotifications,
  routeFromNotificationData,
} from '@/services/background/backgroundSyncNotifications';

interface FakeBackgroundStateRow {
  paired_device_id: string | null;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_success_at: string | null;
  last_source: 'foreground' | 'background' | null;
  last_result: 'success' | 'skipped' | 'error' | null;
  last_error: string | null;
  last_imported_readings: number | null;
  notification_permission: 'unknown' | 'granted' | 'provisional' | 'denied';
  notification_baseline_at: string | null;
  lock_owner: string | null;
  lock_started_at: string | null;
}

class MockNotificationDb {
  backgroundState: FakeBackgroundStateRow;
  sleepRows = [{ sleep_id: '2026-04-02', end: '2026-04-02 07:15:00' }];
  activityRows = [
    { id: 11, activity: 'Nap' as const, start: '2026-04-02 13:00:00', end: '2026-04-02 13:25:00' },
    { id: 12, activity: 'Activity' as const, start: '2026-04-02 18:00:00', end: '2026-04-02 18:30:00' },
  ];
  delivered = new Set<string>();

  constructor(permission: FakeBackgroundStateRow['notification_permission'], baselineAt: string | null) {
    this.backgroundState = {
      paired_device_id: 'strap-1',
      last_run_started_at: null,
      last_run_finished_at: null,
      last_success_at: null,
      last_source: null,
      last_result: null,
      last_error: null,
      last_imported_readings: null,
      notification_permission: permission,
      notification_baseline_at: baselineAt,
      lock_owner: null,
      lock_started_at: null,
    };
  }

  async getFirstAsync<T>() {
    return { ...this.backgroundState } as T;
  }

  async getAllAsync<T>(sql: string, baselineAt: string, deviceId: string) {
    if (sql.includes('FROM sleep_cycles')) {
      return this.sleepRows
        .filter((row) => row.end > baselineAt)
        .filter((row) => !this.delivered.has(`sleep:${deviceId}:${row.sleep_id}`)) as T[];
    }

    return this.activityRows
      .filter((row) => row.end > baselineAt)
      .filter((row) => !this.delivered.has(`${row.activity === 'Nap' ? 'nap' : 'activity'}:${deviceId}:${row.id}`)) as T[];
  }

  async runAsync(_sql: string, deviceId: string, kind: string, entityId: string) {
    this.delivered.add(`${kind}:${deviceId}:${entityId}`);
  }
}

describe('background sync notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips delivery when notifications are not allowed yet', async () => {
    const db = new MockNotificationDb('denied', '2026-04-02 06:00:00');

    await expect(deliverNewBackgroundNotifications(db as never, 'strap-1')).resolves.toBe(0);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('delivers sleep, nap, and activity notifications once after the baseline', async () => {
    const db = new MockNotificationDb('granted', '2026-04-02 06:00:00');

    await expect(deliverNewBackgroundNotifications(db as never, 'strap-1')).resolves.toBe(3);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(3);

    await expect(deliverNewBackgroundNotifications(db as never, 'strap-1')).resolves.toBe(0);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(3);
  });

  it('sends a background sync completion notification when alerts are allowed', async () => {
    const db = new MockNotificationDb('granted', '2026-04-02 06:00:00');

    await expect(
      deliverBackgroundSyncRunNotification(db as never, {
        deviceId: 'strap-1',
        result: 'success',
        finishedAt: '2026-04-02 10:15:00',
        importedReadings: 24,
        error: null,
      }),
    ).resolves.toBe(true);

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'background-sync:strap-1:success:2026-04-02 10:15:00',
      content: {
        title: 'Background sync complete',
        body: 'BtWearable synced 24 new readings in the background.',
        data: {
          route: '/settings',
        },
        sound: false,
      },
      trigger: null,
    });
  });

  it('skips the background sync run notification when alerts are denied', async () => {
    const db = new MockNotificationDb('denied', '2026-04-02 06:00:00');

    await expect(
      deliverBackgroundSyncRunNotification(db as never, {
        deviceId: 'strap-1',
        result: 'error',
        finishedAt: '2026-04-02 10:20:00',
        importedReadings: 0,
        error: 'Unable to connect.',
      }),
    ).resolves.toBe(false);

    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('extracts deep-link routes from notification payloads', () => {
    expect(routeFromNotificationData({ route: '/sleep' })).toBe('/sleep');
    expect(routeFromNotificationData({})).toBeNull();
  });
});
