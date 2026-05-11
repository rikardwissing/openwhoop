import { useEffect } from 'react';

import { updateTonightWidgetFromSleepPlan } from '@/services/widgets/tonightWidget';
import type { SleepHistoryData } from '@/types/health';

type TonightWidgetSyncData = Pick<SleepHistoryData, 'sleepPlan' | 'headlineLabel' | 'headlineScore'>;

function widgetSyncKey({ sleepPlan, headlineLabel, headlineScore }: TonightWidgetSyncData) {
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
  ].join('|');
}

export function TonightWidgetPlanSync({ sleepPlan, headlineLabel, headlineScore }: TonightWidgetSyncData) {
  const syncKey = widgetSyncKey({ sleepPlan, headlineLabel, headlineScore });

  useEffect(() => {
    void updateTonightWidgetFromSleepPlan(sleepPlan, {
      headlineLabel,
      headlineScore,
    });
  }, [syncKey]);

  return null;
}
