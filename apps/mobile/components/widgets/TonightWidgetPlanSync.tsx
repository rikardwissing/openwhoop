import { useEffect } from 'react';

import { updateTonightWidgetFromSleepHistory } from '@/services/widgets/tonightWidget';
import type { SleepHistoryData } from '@/types/health';

type TonightWidgetSyncData = Pick<
  SleepHistoryData,
  'completionStatus' | 'headlineLabel' | 'headlineScore' | 'isInProgress' | 'sessions' | 'sleepPlan'
> & {
  batteryPercent?: number | null;
  chargingStatus?: 'charging' | 'not_charging' | null;
};

function widgetSyncKey({
  batteryPercent,
  chargingStatus,
  completionStatus,
  headlineLabel,
  headlineScore,
  isInProgress,
  sessions,
  sleepPlan,
}: TonightWidgetSyncData) {
  const plan = sleepPlan;
  const latestSession = sessions[0];

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
    completionStatus,
    isInProgress,
    latestSession?.id ?? 'none',
    latestSession?.startAt ?? 'null',
    latestSession?.endAt ?? 'null',
    latestSession?.completionStatus ?? 'null',
    latestSession?.isInProgress ?? 'null',
  ].join('|');
}

export function TonightWidgetPlanSync(props: TonightWidgetSyncData) {
  const {
    batteryPercent,
    chargingStatus,
    completionStatus,
    headlineLabel,
    headlineScore,
    isInProgress,
    sessions,
    sleepPlan,
  } = props;
  const syncKey = widgetSyncKey(props);

  useEffect(() => {
    void updateTonightWidgetFromSleepHistory({
      batteryPercent,
      chargingStatus,
      completionStatus,
      headlineLabel,
      headlineScore,
      isInProgress,
      sessions,
      sleepPlan,
    });
  }, [syncKey]);

  return null;
}
