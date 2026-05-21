import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useAppDatabase } from '@/providers/AppDatabaseProvider';
import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import { updateTonightWidget } from '@/services/widgets/tonightWidget';

export function SleepPreparationReminderSync() {
  const db = useAppDatabase();
  const repository = useHealthRepository();
  const version = useHealthDataVersion('sleep');
  const [resumeTick, setResumeTick] = useState(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        setResumeTick((value) => value + 1);
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshSleepSurfaces = async () => {
      const snapshot = await repository.getSleepHistory('14d');

      if (cancelled) {
        return;
      }

      await Promise.all([
        syncSleepPreparationReminder(snapshot.sleepPlan, {
          requestPermission: false,
        }),
        updateTonightWidget(db),
      ]);
    };

    void refreshSleepSurfaces().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [db, repository, resumeTick, version]);

  return null;
}
