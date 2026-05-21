import { useEffect } from 'react';

import { useAppDatabase } from '@/providers/AppDatabaseProvider';
import { updateTonightWidget } from '@/services/widgets/tonightWidget';
import type { SleepHistoryData } from '@/types/health';

type TonightWidgetSyncData = Pick<
  SleepHistoryData,
  'completionStatus' | 'headlineLabel' | 'headlineScore' | 'isInProgress' | 'sessions' | 'sleepPlan'
> & {
  batteryPercent?: number | null;
  chargingStatus?: 'charging' | 'not_charging' | null;
};

function resolveRelevantSession(sessions: SleepHistoryData['sessions']) {
  const inProgressSession = sessions.find((session) => session.isInProgress) ?? null;

  if (inProgressSession) {
    return inProgressSession;
  }

  return sessions.reduce<SleepHistoryData['sessions'][number] | null>((latest, session) => {
    if (!latest) {
      return session;
    }

    return session.startAt > latest.startAt ? session : latest;
  }, null);
}

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
  const relevantSession = resolveRelevantSession(sessions);

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
    sessions.length,
    relevantSession?.id ?? 'none',
    relevantSession?.startAt ?? 'null',
    relevantSession?.endAt ?? 'null',
    relevantSession?.completionStatus ?? 'null',
    relevantSession?.isInProgress ?? 'null',
  ].join('|');
}

export function TonightWidgetPlanSync(props: TonightWidgetSyncData) {
  const db = useAppDatabase();
  const syncKey = widgetSyncKey(props);

  useEffect(() => {
    void updateTonightWidget(db);
  }, [db, syncKey]);

  return null;
}
