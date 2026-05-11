import { useEffect } from 'react';

import { updateTonightWidgetFromSleepPlan } from '@/services/widgets/tonightWidget';
import type { SleepHistoryData } from '@/types/health';

type TonightWidgetSyncData = Pick<SleepHistoryData, 'sleepPlan' | 'headlineLabel' | 'headlineScore'> & {
  batteryPercent?: number | null;
  chargingStatus?: 'charging' | 'not_charging' | null;
};

function widgetSyncKey({ sleepPlan, headlineLabel, headlineScore, batteryPercent, chargingStatus }: TonightWidgetSyncData) {
  const plan = sleepPlan;

  return [
    plan.alarmEnabled,
    plan.alarmOneOffAt,
    plan.alarmScheduleKind,
    plan.alarmWakeMode,
    plan.alarmWeekdayMask,
    plan.nextAlarmAt,
    plan.napCreditMinutes,
    plan.optimalBedtimeMinutes,
    plan.sleepDebtMinutes,
    plan.sleepNeedMinutes,
    plan.targetWakeMinutes,
    headlineLabel,
    headlineScore ?? 'null',
    batteryPercent ?? 'null',
    chargingStatus ?? 'null',
  ].join('|');
}

export function TonightWidgetPlanSync({ sleepPlan, headlineLabel, headlineScore, batteryPercent, chargingStatus }: TonightWidgetSyncData) {
  const syncKey = widgetSyncKey({ sleepPlan, headlineLabel, headlineScore, batteryPercent, chargingStatus });

  useEffect(() => {
    void updateTonightWidgetFromSleepPlan(sleepPlan, {
      batteryPercent,
      chargingStatus,
      headlineLabel,
      headlineScore,
    });
  }, [syncKey]);

  return null;
}
