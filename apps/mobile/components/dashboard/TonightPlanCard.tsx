import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { colors, typography } from '@/constants/theme';
import { useHealthRepository } from '@/providers/HealthDataProvider';
import { useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useWearableSyncActions, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import type { SleepPlanSnapshot } from '@/types/health';
import { formatDuration } from '@/utils/formatters';
import { nextUpcomingClockDate } from '@/utils/sleepPlan';

export function TonightPlanCard({
  onOpenSleep,
  plan,
}: {
  onOpenSleep: () => void;
  plan: SleepPlanSnapshot;
}) {
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { deviceState } = useWearableSyncState();
  const { disableAlarm, setAlarm } = useWearableSyncActions();
  const [alarmEnabled, setAlarmEnabled] = useState(plan.alarmEnabled);
  const [savingAlarm, setSavingAlarm] = useState(false);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);

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
        await repository.enableAlarm(plan.targetWakeMinutes);
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
          await setAlarm(Math.floor(nextUpcomingClockDate(plan.targetWakeMinutes).getTime() / 1000));
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
          ? 'Alarm is active for your current wake target, with a quiet phone reminder before bed.'
          : 'Enable the alarm to push your current wake target to the wearable and schedule the phone reminder.'}
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
