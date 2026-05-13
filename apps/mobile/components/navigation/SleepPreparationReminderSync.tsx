import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import { updateTonightWidgetFromSleepHistory } from '@/services/widgets/tonightWidget';

export function SleepPreparationReminderSync() {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('sleep');
  const { deviceState } = useWearableSyncState();
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
          updateTonightWidgetFromSleepHistory({
            ...snapshot,
            batteryPercent: deviceState.batteryPercent,
            chargingStatus: deviceState.chargingStatus,
          }),
        ]);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [deviceState.batteryPercent, deviceState.chargingStatus, repository, resumeTick, version]);

  return null;
}
