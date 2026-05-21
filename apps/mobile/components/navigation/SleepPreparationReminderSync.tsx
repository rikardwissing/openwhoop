import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useGraphQLSleepHistory } from '@/hooks/useGraphQLSleepHistory';
import { useAppDatabase } from '@/providers/AppDatabaseProvider';
import { useHealthDataVersion } from '@/providers/HealthDataProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import { updateTonightWidget } from '@/services/widgets/tonightWidget';

export function SleepPreparationReminderSync() {
  const db = useAppDatabase();
  const version = useHealthDataVersion('sleep');
  const [resumeTick, setResumeTick] = useState(0);
  const sleepHistory = useGraphQLSleepHistory('14d', version + resumeTick);

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
    const snapshot = sleepHistory.data;

    if (!snapshot) {
      return undefined;
    }

    const refreshSleepSurfaces = async () => {
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
  }, [db, sleepHistory.data]);

  return null;
}
