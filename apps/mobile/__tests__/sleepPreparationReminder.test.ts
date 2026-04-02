jest.mock('expo-notifications', () => ({
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  scheduleNotificationAsync: jest.fn(async () => 'sleep-preparation-reminder'),
  SchedulableTriggerInputTypes: {
    DATE: 'date',
  },
}));

jest.mock('@/services/notifications/notificationPermissions', () => ({
  syncNotificationPermissionFromSystem: jest.fn(async () => ({
    permission: 'granted',
    baselineAt: null,
  })),
}));

import * as Notifications from 'expo-notifications';

import { syncNotificationPermissionFromSystem } from '@/services/notifications/notificationPermissions';
import {
  SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID,
  syncSleepPreparationReminder,
} from '@/services/notifications/sleepPreparationReminder';
import type { SleepPlanSnapshot } from '@/types/health';

const basePlan: SleepPlanSnapshot = {
  targetWakeMinutes: 7 * 60,
  targetWakeTime: '7:00 AM',
  optimalBedtimeMinutes: 22 * 60 + 30,
  optimalBedtime: '10:30 PM',
  sleepNeedMinutes: 510,
  sleepDebtMinutes: 30,
  napCreditMinutes: 0,
  alarmEnabled: true,
};

describe('sleep preparation reminder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('cancels the existing reminder when the alarm is disabled', async () => {
    await expect(
      syncSleepPreparationReminder({
        ...basePlan,
        alarmEnabled: false,
      }),
    ).resolves.toEqual({
      scheduled: false,
      permission: null,
      reason: 'disabled',
      triggerAt: null,
    });

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID,
    );
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('schedules the next one-hour-before-bed reminder when notifications are allowed', async () => {
    const now = new Date(2026, 3, 2, 15, 0, 0);

    await expect(
      syncSleepPreparationReminder(basePlan, {
        now,
        requestPermission: true,
      }),
    ).resolves.toMatchObject({
      scheduled: true,
      permission: 'granted',
      reason: 'scheduled',
    });

    expect(syncNotificationPermissionFromSystem).toHaveBeenCalledWith(true);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: SLEEP_PREPARATION_REMINDER_NOTIFICATION_ID,
      content: {
        title: 'Prepare for bed',
        body: 'Unstrap says it is time to start winding down. Your optimal bedtime is around 10:30 PM.',
        data: {
          route: '/sleep',
        },
        sound: false,
      },
      trigger: {
        type: 'date',
        date: new Date(2026, 3, 2, 21, 30, 0),
      },
    });
  });

  it('does not schedule the reminder when notifications are denied', async () => {
    (syncNotificationPermissionFromSystem as jest.Mock).mockResolvedValueOnce({
      permission: 'denied',
      baselineAt: null,
    });

    await expect(syncSleepPreparationReminder(basePlan)).resolves.toEqual({
      scheduled: false,
      permission: 'denied',
      reason: 'permission-denied',
      triggerAt: null,
    });

    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
