import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { colors, typography } from '@/constants/theme';
import { useHealthRepository } from '@/providers/HealthDataProvider';
import { useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useWearableSyncActions, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import type { SleepPlan } from '@/types/health';
import { formatClock, parseSqliteDateTime } from '@/utils/dateTime';
import { formatDuration } from '@/utils/formatters';
import {
  ALARM_WEEKDAY_FULL_MASK,
  isAlarmWeekdaySelected,
  nextAlarmTargetDate,
  resolveNextWearableAlarmDate,
  resolveTonightSurfaceState,
  type TonightSurfaceState,
} from '@/utils/sleepPlan';

const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function alarmScheduleSummary(plan: SleepPlan) {
  if (plan.alarmScheduleKind === 'one_off') {
    return 'One-off alarm';
  }

  const selectedDays = weekdayLabels.filter((_, index) => isAlarmWeekdaySelected(plan.alarmWeekdayMask, index));

  if (selectedDays.length === weekdayLabels.length) {
    return 'Recurring daily';
  }

  if (selectedDays.length === 0) {
    return 'Recurring with no wake days';
  }

  return `Recurring ${selectedDays.join(', ')}`;
}

function alarmWakeModeSummary(plan: SleepPlan) {
  switch (plan.alarmWakeMode) {
    case 'score_or_time':
      return '100% or time';
    case 'score_and_time':
      return '100% or time, whichever comes last';
    case 'score_only':
      return 'Wait until 100%';
    case 'exact_time':
    default:
      return 'Exact time';
  }
}

export function TonightPlanCard({
  onOpenSleep,
  plan,
  surfaceState,
}: {
  onOpenSleep: () => void;
  plan: SleepPlan;
  surfaceState?: TonightSurfaceState;
}) {
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { deviceState } = useWearableSyncState();
  const { disableAlarm, setAlarm } = useWearableSyncActions();
  const [alarmEnabled, setAlarmEnabled] = useState(plan.alarmEnabled);
  const [savingAlarm, setSavingAlarm] = useState(false);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);
  const alarmSettings = {
    alarmScheduleKind: plan.alarmScheduleKind,
    alarmWakeMode: plan.alarmWakeMode,
    alarmWeekdayMask: plan.alarmWeekdayMask & ALARM_WEEKDAY_FULL_MASK,
    targetWakeMinutes: plan.targetWakeMinutes,
  };
  const nextDisplayedAlarmAt = plan.nextAlarmAt ? parseSqliteDateTime(plan.nextAlarmAt) : null;
  const alarmSummary = `${alarmScheduleSummary(plan)} · ${alarmWakeModeSummary(plan)}`;
  const tonightSurfaceState = surfaceState ?? resolveTonightSurfaceState({ sleepPlan: plan });
  const tonightSurfaceTitle =
    tonightSurfaceState.mode === 'sleep'
      ? 'Sleep in progress'
      : tonightSurfaceState.mode === 'bedtime_passed'
        ? 'Bedtime has started'
        : tonightSurfaceState.mode === 'wind_down'
          ? 'Time to wind down'
          : tonightSurfaceState.windDownStatus.greeting;
  const tonightSurfaceDetail =
    tonightSurfaceState.mode === 'sleep' ? 'Sleep in progress' : tonightSurfaceState.windDownStatus.detail;

  useEffect(() => {
    setAlarmEnabled(plan.alarmEnabled);
  }, [plan.alarmEnabled]);

  const toggleAlarm = async () => {
    if (savingAlarm) {
      return;
    }

    const nextAlarmEnabled = !alarmEnabled;
    setSavingAlarm(true);
    setAlarmEnabled(nextAlarmEnabled);
    setAlarmError(null);
    setReminderNotice(null);

    let savedLocally = false;

    try {
      if (nextAlarmEnabled) {
        await repository.enableAlarm(alarmSettings);
        savedLocally = true;
        const reminderResult = await syncSleepPreparationReminder(
          {
            ...plan,
            alarmEnabled: true,
          },
          {
            requestPermission: true,
          },
        );

        if (!reminderResult.scheduled && reminderResult.reason === 'permission-denied') {
          setReminderNotice(
            'Bedtime reminder notifications are off on this iPhone, so Unstrap could not schedule the wind-down alert.',
          );
        }

        if (deviceState.id) {
          const oneOffAlarmAt =
            plan.alarmScheduleKind === 'one_off'
              ? nextAlarmTargetDate(alarmSettings)
              : plan.alarmOneOffAt
                ? parseSqliteDateTime(plan.alarmOneOffAt)
                : null;
          const alarmAt = resolveNextWearableAlarmDate({
            ...alarmSettings,
            alarmEnabled: true,
            alarmOneOffAt: oneOffAlarmAt,
            inProgressSleepStart: null,
            sleepNeedMinutes: plan.sleepNeedMinutes,
          });

          if (alarmAt) {
            await setAlarm(Math.floor(alarmAt.getTime() / 1000));
          } else {
            await disableAlarm();
          }
        }
      } else {
        await repository.disableAlarm(plan.targetWakeMinutes);
        savedLocally = true;
        await syncSleepPreparationReminder({
          ...plan,
          alarmEnabled: false,
        });

        if (deviceState.id) {
          await disableAlarm();
        }
      }

      refreshHealthData(['dashboard', 'sleep']);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update the alarm.';
      setAlarmEnabled(!nextAlarmEnabled);
      setAlarmError(
        savedLocally && deviceState.id
          ? `Alarm saved locally, but the wearable update failed. ${message}`
          : message,
      );

      if (savedLocally) {
        refreshHealthData(['dashboard', 'sleep']);
      }
    } finally {
      setSavingAlarm(false);
    }
  };

  return (
    <GlassCard accentColor={colors.primary}>
      <SectionHeader title="Tonight" trailing={`Need ${formatDuration(plan.sleepNeedMinutes)}`} />
      <View style={[
        styles.windDownBanner,
        tonightSurfaceState.mode !== 'awake' ? styles.windDownBannerActive : null,
      ]}>
        <Text style={styles.windDownTitle}>{tonightSurfaceTitle}</Text>
        <Text style={styles.windDownDetail}>{tonightSurfaceDetail}</Text>
      </View>
      <View style={styles.metricRow}>
        <View style={styles.metricBlock}>
          <Text style={styles.metricLabel}>Bedtime</Text>
          <Text style={styles.metricValue}>{plan.optimalBedtime}</Text>
        </View>
        <View style={styles.metricBlock}>
          <Text style={styles.metricLabel}>Wake time</Text>
          <Text style={styles.metricValue}>{plan.targetWakeTime}</Text>
        </View>
      </View>

      <Text style={styles.caption}>
        {alarmEnabled
          ? `${alarmSummary}. ${
              nextDisplayedAlarmAt
                ? `Next wearable alarm ${formatClock(nextDisplayedAlarmAt)}.`
                : 'Wearable will arm after sleep is detected and a 100% time can be projected.'
            }`
          : `${alarmSummary}. Open Sleep to edit schedule and wake mode, then enable to push the next computed alarm.`}
      </Text>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={savingAlarm}
          onPress={toggleAlarm}
          style={({ pressed }) => [
            styles.primaryAction,
            alarmEnabled ? styles.primaryActionDanger : null,
            savingAlarm ? styles.actionDisabled : null,
            pressed ? styles.actionPressed : null,
          ]}
          testID="today-tonight-toggle-alarm-button">
          <Text style={styles.primaryActionLabel}>
            {savingAlarm ? 'Saving...' : alarmEnabled ? 'Disable alarm' : 'Enable alarm'}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={onOpenSleep}
          style={({ pressed }) => [styles.secondaryAction, pressed ? styles.actionPressed : null]}
          testID="today-open-tonight-sleep-button">
          <Text style={styles.secondaryActionLabel}>Open Sleep</Text>
        </Pressable>
      </View>

      {reminderNotice ? <Text style={styles.footnote}>{reminderNotice}</Text> : null}
      {alarmError ? <Text style={styles.error}>{alarmError}</Text> : null}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  windDownBanner: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
    marginBottom: 12,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  windDownBannerActive: {
    backgroundColor: 'rgba(255, 210, 107, 0.13)',
    borderColor: 'rgba(255, 210, 107, 0.34)',
  },
  windDownTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
  },
  windDownDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    lineHeight: 18,
  },
  metricRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  metricBlock: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    padding: 14,
  },
  metricLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  metricValue: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 24,
    marginTop: 8,
  },
  metricDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 6,
  },
  caption: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: 'rgba(104, 255, 120, 0.18)',
    borderColor: 'rgba(104, 255, 120, 0.34)',
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
  },
  primaryActionDanger: {
    backgroundColor: 'rgba(255, 125, 112, 0.16)',
    borderColor: 'rgba(255, 125, 112, 0.3)',
  },
  primaryActionLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
  },
  secondaryAction: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 108,
    paddingHorizontal: 14,
  },
  secondaryActionLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
  },
  actionPressed: {
    opacity: 0.84,
  },
  actionDisabled: {
    opacity: 0.6,
  },
  footnote: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  error: {
    color: colors.alert,
    fontFamily: typography.body,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
});
