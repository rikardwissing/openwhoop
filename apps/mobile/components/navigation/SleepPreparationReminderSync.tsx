import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import { updateTonightWidgetFromSleepHistory } from '@/services/widgets/tonightWidget';
import { resolveSleepPlanWindow } from '@/utils/sleepPlan';

const MAX_PHASE_TIMER_MS = 2_147_483_647;

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
    let phaseTimer: ReturnType<typeof setTimeout> | null = null;

    const clearPhaseTimer = () => {
      if (phaseTimer === null) {
        return;
      }

      clearTimeout(phaseTimer);
      phaseTimer = null;
    };

    const scheduleNextPhaseRefresh = (sleepPlan: Awaited<ReturnType<typeof repository.getSleepHistory>>['sleepPlan']) => {
      clearPhaseTimer();

      const now = new Date();
      const { prepStartDate, bedtimeDate, wakeDate } = resolveSleepPlanWindow(sleepPlan, now);
      const nextPhaseDate = [prepStartDate, bedtimeDate, wakeDate].find((date) => date.getTime() > now.getTime());

      if (!nextPhaseDate) {
        return;
      }

      const delayMs = Math.min(MAX_PHASE_TIMER_MS, Math.max(1_000, nextPhaseDate.getTime() - now.getTime() + 1_000));

      phaseTimer = setTimeout(() => {
        phaseTimer = null;

        if (cancelled) {
          return;
        }

        setResumeTick((value) => value + 1);
      }, delayMs);
    };

    const refreshSleepSurfaces = async () => {
      const snapshot = await repository.getSleepHistory('14d');

      if (cancelled) {
        return;
      }

      await Promise.all([
        syncSleepPreparationReminder(snapshot.sleepPlan, {
          requestPermission: false,
        }),
        updateTonightWidgetFromSleepHistory({
          ...snapshot,
          batteryPercent: deviceState.batteryPercent,
          chargingStatus: deviceState.chargingStatus,
        }),
      ]);

      scheduleNextPhaseRefresh(snapshot.sleepPlan);
    };

    void refreshSleepSurfaces().catch(() => {});

    return () => {
      cancelled = true;
      clearPhaseTimer();
    };
  }, [deviceState.batteryPercent, deviceState.chargingStatus, repository, resumeTick, version]);

  return null;
}
