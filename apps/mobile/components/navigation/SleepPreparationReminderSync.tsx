import { useEffect } from 'react';

import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import { updateTonightWidgetFromSleepHistory } from '@/services/widgets/tonightWidget';

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

        return Promise.all([
          syncSleepPreparationReminder(snapshot.sleepPlan, {
            requestPermission: false,
          }),
          updateTonightWidgetFromSleepHistory(snapshot),
        ]);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [repository, version]);

  return null;
}
