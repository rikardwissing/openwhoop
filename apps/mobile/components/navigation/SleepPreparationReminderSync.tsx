import { useEffect } from 'react';

import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';

export function SleepPreparationReminderSync() {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('sleep');

  useEffect(() => {
    let cancelled = false;

    void repository
      .getSleepHistory('14d')
      .then((snapshot) => {
        if (cancelled) {
          return;
        }

        return syncSleepPreparationReminder(snapshot.sleepPlan, {
          requestPermission: false,
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [repository, version]);

  return null;
}
