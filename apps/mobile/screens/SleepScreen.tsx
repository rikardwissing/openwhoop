import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChartReadout } from '@/components/charts/ChartReadout';
import { SleepStageChart } from '@/components/charts/SleepStageChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowRing } from '@/components/ui/GlowRing';
import { MetricCard } from '@/components/ui/MetricCard';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { SleepStageBreakdownChip } from '@/components/ui/SleepStageBreakdownChip';
import { colors, sleepStageColors, typography } from '@/constants/theme';
import { useDerivedRefreshState, useSleepHistory } from '@/hooks/useHealthData';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useWearableSyncActions, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { syncSleepPreparationReminder } from '@/services/notifications/sleepPreparationReminder';
import type { AlarmScheduleKind, AlarmWakeMode, SleepStage, SleepStageSelection } from '@/types/health';
import {
  formatClockRangeFromStartLabel,
  formatCompactDuration,
  formatDuration,
  describeSleepScore,
  formatMetricValue,
  formatNullablePercent,
} from '@/utils/formatters';
import { formatClock, formatClockMinutes, parseSqliteDateTime } from '@/utils/dateTime';
import { getMetricToneColor, getSleepMetricTone } from '@/utils/metricTone';
import {
  ALARM_WEEKDAY_FULL_MASK,
  calculateOptimalBedtimeMinutes,
  isAlarmWeekdaySelected,
  nextAlarmTargetDate,
  resolveNextWearableAlarmDate,
  roundClockMinutes,
} from '@/utils/sleepPlan';

const stageBreakdownOrder: SleepStage[] = ['deep', 'light', 'rem', 'awake'];
const weekdayOptions = [
  { index: 0, label: 'Sun' },
  { index: 1, label: 'Mon' },
  { index: 2, label: 'Tue' },
  { index: 3, label: 'Wed' },
  { index: 4, label: 'Thu' },
  { index: 5, label: 'Fri' },
  { index: 6, label: 'Sat' },
] as const;

function alarmScheduleLabel(kind: AlarmScheduleKind, weekdayMask: number) {
  if (kind === 'one_off') {
    return 'One-off';
  }

  const selectedDays = weekdayOptions.filter((day) => isAlarmWeekdaySelected(weekdayMask, day.index));

  if (selectedDays.length === weekdayOptions.length) {
    return 'Recurring daily';
  }

  if (selectedDays.length === 0) {
    return 'Recurring with no wake days';
  }

  return `Recurring ${selectedDays.map((day) => day.label).join(', ')}`;
}

function alarmWakeModeLabel(mode: AlarmWakeMode) {
  switch (mode) {
    case 'score_or_time':
      return '100% or time';
    case 'score_only':
      return 'Wait until 100%';
    case 'exact_time':
    default:
      return 'Exact time';
  }
}

function formatStageBadgeLabel(stage: SleepStage) {
  return stage === 'rem' ? 'REM' : `${stage[0].toUpperCase()}${stage.slice(1)}`;
}

function AlarmOptionButton({
  active,
  caption,
  disabled,
  label,
  onPress,
}: {
  active: boolean;
  caption?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.alarmOptionButton,
        active ? styles.alarmOptionButtonActive : null,
        disabled ? styles.targetButtonDisabled : null,
        pressed ? styles.targetButtonPressed : null,
      ]}>
      <Text style={[styles.alarmOptionButtonLabel, active ? styles.alarmOptionButtonLabelActive : null]}>
        {label}
      </Text>
      {caption ? <Text style={styles.alarmOptionButtonCaption}>{caption}</Text> : null}
    </Pressable>
  );
}

export function SleepScreen() {
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { deviceState } = useWearableSyncState();
  const { setAlarm, disableAlarm } = useWearableSyncActions();
  const state = useSleepHistory('14d');
  const derivedRefresh = useDerivedRefreshState();
  const [stageSelection, setStageSelection] = useState<SleepStageSelection | null>(null);
  const [pinnedStage, setPinnedStage] = useState<SleepStage | null>(null);
  const [targetWakeMinutes, setTargetWakeMinutes] = useState<number | null>(null);
  const [alarmEnabled, setAlarmEnabled] = useState<boolean | null>(null);
  const [alarmScheduleKind, setAlarmScheduleKind] = useState<AlarmScheduleKind>('recurring');
  const [alarmWeekdayMask, setAlarmWeekdayMask] = useState(ALARM_WEEKDAY_FULL_MASK);
  const [alarmWakeMode, setAlarmWakeMode] = useState<AlarmWakeMode>('exact_time');
  const [wakeTargetError, setWakeTargetError] = useState<string | null>(null);
  const [savingAlarm, setSavingAlarm] = useState(false);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const [reminderNotice, setReminderNotice] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const wakeSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeSaveQueueRef = useRef(Promise.resolve());
  const targetWakeMinutesRef = useRef<number | null>(null);
  const alarmEnabledRef = useRef<boolean | null>(null);
  const data = state.data;
  const sessions = data?.sessions ?? [];

  useEffect(() => {
    if (!data) {
      return;
    }

    setTargetWakeMinutes(data.sleepPlan.targetWakeMinutes);
  }, [data]);

  useEffect(() => {
    if (!data) {
      return;
    }

    setAlarmEnabled(data.sleepPlan.alarmEnabled);
    setAlarmScheduleKind(data.sleepPlan.alarmScheduleKind);
    setAlarmWeekdayMask(data.sleepPlan.alarmWeekdayMask);
    setAlarmWakeMode(data.sleepPlan.alarmWakeMode);
  }, [data]);

  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }

    setSelectedSessionId((current) =>
      current && sessions.some((session) => session.id === current) ? current : sessions[0].id,
    );
  }, [sessions]);

  useEffect(() => {
    targetWakeMinutesRef.current = targetWakeMinutes;
  }, [targetWakeMinutes]);

  useEffect(() => {
    alarmEnabledRef.current = alarmEnabled;
  }, [alarmEnabled]);

  useEffect(() => {
    setStageSelection(null);
    setPinnedStage(null);
  }, [selectedSessionId]);

  useEffect(() => () => {
    if (wakeSaveTimeoutRef.current) {
      clearTimeout(wakeSaveTimeoutRef.current);
    }
  }, []);

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="sleep" headerTitle="Sleep">
        <LoadingState label="Loading sleep score and stage history..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell headerIcon="sleep" headerTitle="Sleep">
        <ErrorState message="Unable to load sleep history right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const selectedSessionIndex = sessions.findIndex((session) => session.id === selectedSessionId);
  const resolvedSelectedSessionIndex =
    selectedSessionIndex >= 0 ? selectedSessionIndex : sessions.length > 0 ? 0 : -1;
  const selectedSession =
    resolvedSelectedSessionIndex >= 0 ? sessions[resolvedSelectedSessionIndex] : null;
  const hasOlderSession =
    resolvedSelectedSessionIndex >= 0 && resolvedSelectedSessionIndex < sessions.length - 1;
  const hasNewerSession = resolvedSelectedSessionIndex > 0;
  const latestInProgressSession = sessions.find((session) => session.isInProgress) ?? null;
  const inProgressSleepStart = latestInProgressSession
    ? parseSqliteDateTime(latestInProgressSession.startAt)
    : null;
  const displayedIsInProgress = selectedSession?.isInProgress ?? data.isInProgress;
  const displayedSleepScore = selectedSession ? selectedSession.score : data.headlineScore;
  const displayedSleepLabel = displayedIsInProgress
    ? 'In progress'
    : selectedSession
      ? describeSleepScore(selectedSession.score)
      : data.headlineLabel;
  const displayedBedtime = selectedSession?.bedtime ?? data.bedtime;
  const displayedWakeTime = selectedSession?.wakeTime ?? data.wakeTime;
  const displayedSleepWindowLabel = displayedIsInProgress
    ? `${displayedBedtime} - synced through ${displayedWakeTime}`
    : `${displayedBedtime} to ${displayedWakeTime}`;
  const displayedDurationMinutes = selectedSession?.durationMinutes ?? data.durationMinutes;
  const displayedTimeInBedMinutes = selectedSession?.timeInBedMinutes ?? data.timeInBedMinutes;
  const displayedAwakeMinutes =
    displayedTimeInBedMinutes === null || displayedDurationMinutes === null
      ? null
      : Math.max(0, displayedTimeInBedMinutes - displayedDurationMinutes);
  const selectedStageTotals = selectedSession
    ? selectedSession.stages.reduce<Record<SleepStage, number>>(
        (totals, segment) => {
          totals[segment.stage] += segment.minutes;
          return totals;
        },
        {
          awake: 0,
          rem: 0,
          deep: 0,
          light: 0,
        },
      )
    : null;
  const selectedSessionStageMinutes = selectedStageTotals
    ? stageBreakdownOrder.reduce((sum, stage) => sum + selectedStageTotals[stage], 0)
    : 0;
  const selectedSessionMiddleLabel =
    selectedSession && selectedSessionStageMinutes > 0
      ? formatClockRangeFromStartLabel(
          selectedSession.bedtime,
          selectedSessionStageMinutes / 2,
          selectedSessionStageMinutes / 2,
        ).split('-')[0]
      : '3:00 AM';
  const selectedStageBreakdown = selectedStageTotals
    ? stageBreakdownOrder
        .filter((stage) => selectedStageTotals[stage] > 0)
        .map((stage) => ({
          stage,
          label: formatStageBadgeLabel(stage),
          minutes: selectedStageTotals[stage],
        }))
    : [];
  const activeStage = stageSelection?.segment.stage ?? pinnedStage;
  const resolvedTargetWakeMinutes = targetWakeMinutes ?? data.sleepPlan.targetWakeMinutes;
  const resolvedAlarmEnabled = alarmEnabled ?? data.sleepPlan.alarmEnabled;
  const resolvedAlarmScheduleKind = alarmScheduleKind;
  const resolvedAlarmWeekdayMask = alarmWeekdayMask & ALARM_WEEKDAY_FULL_MASK;
  const resolvedAlarmWakeMode = alarmWakeMode;
  const alarmSettings = {
    alarmScheduleKind: resolvedAlarmScheduleKind,
    alarmWakeMode: resolvedAlarmWakeMode,
    alarmWeekdayMask: resolvedAlarmWeekdayMask,
    targetWakeMinutes: resolvedTargetWakeMinutes,
  };
  const alarmSettingsChanged =
    resolvedTargetWakeMinutes !== data.sleepPlan.targetWakeMinutes ||
    resolvedAlarmScheduleKind !== data.sleepPlan.alarmScheduleKind ||
    resolvedAlarmWeekdayMask !== data.sleepPlan.alarmWeekdayMask ||
    resolvedAlarmWakeMode !== data.sleepPlan.alarmWakeMode;
  const hasRecurringWakeDay = resolvedAlarmScheduleKind !== 'recurring' || resolvedAlarmWeekdayMask !== 0;
  const oneOffAlarmAt =
    resolvedAlarmScheduleKind === 'one_off'
      ? nextAlarmTargetDate(alarmSettings)
      : data.sleepPlan.alarmOneOffAt
        ? parseSqliteDateTime(data.sleepPlan.alarmOneOffAt)
        : null;
  const nextWearableAlarmAt = resolveNextWearableAlarmDate({
    ...alarmSettings,
    alarmEnabled: resolvedAlarmEnabled,
    alarmOneOffAt: oneOffAlarmAt,
    inProgressSleepStart,
    sleepNeedMinutes: data.sleepPlan.sleepNeedMinutes,
  });
  const alarmSummary = `${alarmScheduleLabel(resolvedAlarmScheduleKind, resolvedAlarmWeekdayMask)} · ${alarmWakeModeLabel(resolvedAlarmWakeMode)}`;
  const displayedOptimalBedtimeMinutes = calculateOptimalBedtimeMinutes(
    resolvedTargetWakeMinutes,
    data.sleepPlan.sleepNeedMinutes,
  );
  const sleepPlan = {
    ...data.sleepPlan,
    targetWakeMinutes: resolvedTargetWakeMinutes,
    targetWakeTime: formatClockMinutes(resolvedTargetWakeMinutes),
    optimalBedtimeMinutes: displayedOptimalBedtimeMinutes,
    optimalBedtime: formatClockMinutes(displayedOptimalBedtimeMinutes),
    alarmEnabled: resolvedAlarmEnabled,
    alarmScheduleKind: resolvedAlarmScheduleKind,
    alarmWeekdayMask: resolvedAlarmWeekdayMask,
    alarmWakeMode: resolvedAlarmWakeMode,
    alarmOneOffAt: oneOffAlarmAt ? oneOffAlarmAt.toISOString() : null,
    nextAlarmAt: nextWearableAlarmAt ? nextWearableAlarmAt.toISOString() : null,
  };
  const derivedRefreshMessage =
    derivedRefresh.data?.status === 'pending' || derivedRefresh.data?.status === 'processing'
      ? derivedRefresh.data.isFirstSync
        ? 'Preparing insights from your first sync...'
        : 'Updating sleep insights with your latest sync...'
      : null;

  const selectOlderSession = () => {
    if (!hasOlderSession) {
      return;
    }

    setSelectedSessionId(sessions[resolvedSelectedSessionIndex + 1]?.id ?? null);
  };

  const selectNewerSession = () => {
    if (!hasNewerSession) {
      return;
    }

    setSelectedSessionId(sessions[resolvedSelectedSessionIndex - 1]?.id ?? null);
  };

  const queueWakeTargetCommit = () => {
    if (wakeSaveTimeoutRef.current) {
      clearTimeout(wakeSaveTimeoutRef.current);
    }

    wakeSaveTimeoutRef.current = setTimeout(() => {
      wakeSaveQueueRef.current = wakeSaveQueueRef.current
        .catch(() => {})
        .then(async () => {
          const committedWakeMinutes = targetWakeMinutesRef.current ?? data.sleepPlan.targetWakeMinutes;

          try {
            await repository.setTargetWakeMinutes(committedWakeMinutes);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to update the wake-up target.';
            setWakeTargetError(message);
          }
        });
    }, 260);
  };

  const adjustWakeTarget = async (deltaMinutes: number) => {
    if (savingAlarm) {
      return;
    }

    setWakeTargetError(null);
    const nextWakeMinutes = roundClockMinutes(
      (targetWakeMinutesRef.current ?? data.sleepPlan.targetWakeMinutes) + deltaMinutes,
    );
    targetWakeMinutesRef.current = nextWakeMinutes;
    setTargetWakeMinutes(nextWakeMinutes);
    if (alarmEnabledRef.current ?? data.sleepPlan.alarmEnabled) {
      setAlarmEnabled(false);
      alarmEnabledRef.current = false;
      setAlarmError(null);
      setReminderNotice(null);
      void syncSleepPreparationReminder({
        ...sleepPlan,
        alarmEnabled: false,
      });
    }
    queueWakeTargetCommit();
  };

  const turnAlarmOn = async () => {
    if (savingAlarm) {
      return;
    }

    if (!hasRecurringWakeDay) {
      setAlarmError('Select at least one wake day before enabling a recurring alarm.');
      return;
    }

    setSavingAlarm(true);
    setAlarmError(null);
    setReminderNotice(null);
    setAlarmEnabled(true);
    alarmEnabledRef.current = true;

    if (wakeSaveTimeoutRef.current) {
      clearTimeout(wakeSaveTimeoutRef.current);
      wakeSaveTimeoutRef.current = null;
    }

    let savedLocally = false;

    try {
      await repository.enableAlarm(alarmSettings);
      savedLocally = true;
      const reminderResult = await syncSleepPreparationReminder(
        {
          ...sleepPlan,
          alarmEnabled: true,
        },
        {
          requestPermission: true,
        },
      );

      if (!reminderResult.scheduled && reminderResult.reason === 'permission-denied') {
        setReminderNotice('Bedtime reminder notifications are off on this iPhone, so Unstrap could not schedule the one-hour wind-down alert.');
      }

      if (deviceState.id) {
        const alarmAt = resolveNextWearableAlarmDate({
          ...alarmSettings,
          alarmEnabled: true,
          alarmOneOffAt: oneOffAlarmAt,
          inProgressSleepStart,
          sleepNeedMinutes: sleepPlan.sleepNeedMinutes,
        });

        if (alarmAt) {
          await setAlarm(Math.floor(alarmAt.getTime() / 1000));
        } else {
          await disableAlarm();
        }
      }

      refreshHealthData(['dashboard', 'sleep']);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update the alarm.';
      setAlarmEnabled(false);
      alarmEnabledRef.current = false;
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

  const turnAlarmOff = async () => {
    if (savingAlarm) {
      return;
    }

    setSavingAlarm(true);
    setAlarmError(null);
    setReminderNotice(null);
    setAlarmEnabled(false);
    alarmEnabledRef.current = false;

    if (wakeSaveTimeoutRef.current) {
      clearTimeout(wakeSaveTimeoutRef.current);
      wakeSaveTimeoutRef.current = null;
    }

    let savedLocally = false;

    try {
      await repository.disableAlarm(resolvedTargetWakeMinutes);
      savedLocally = true;
      await syncSleepPreparationReminder({
        ...sleepPlan,
        alarmEnabled: false,
      });

      if (deviceState.id) {
        await disableAlarm();
      }

      refreshHealthData(['dashboard', 'sleep']);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to disable the alarm.';
      setAlarmEnabled(true);
      alarmEnabledRef.current = true;
      setAlarmError(
        savedLocally && deviceState.id
          ? `Alarm was disabled locally, but the wearable update failed. ${message}`
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
    <ScreenShell headerIcon="sleep" headerTitle="Sleep">
      {state.status === 'error' ? (
        <ErrorState message="Showing the last sleep snapshot while refresh catches up." variant="inline" />
      ) : null}
      {derivedRefreshMessage ? (
        <Text style={styles.syncNotice}>{derivedRefreshMessage}</Text>
      ) : null}
      {derivedRefresh.data?.status === 'error' && derivedRefresh.data.lastError ? (
        <ErrorState message={derivedRefresh.data.lastError} variant="inline" />
      ) : null}
      <View>
        <Text style={styles.subtitle}>Rhythm, recovery, and stage balance across the last 14 nights.</Text>
      </View>

      <GlowRing
        caption={selectedSession?.dateLabel ?? 'Sleep Score'}
        label={displayedSleepLabel}
        score={displayedSleepScore}
        size={238}
        tone={getSleepMetricTone(displayedSleepScore)}
      />

      <View style={styles.metricGrid}>
        <MetricCard
          accentColor={colors.violet}
          style={styles.metricCard}
          subtitle={displayedSleepWindowLabel}
          title="Time Asleep"
          value={formatCompactDuration(displayedDurationMinutes)}
        />
        <MetricCard
          accentColor={colors.aqua}
          style={styles.metricCard}
          subtitle={`Awake ${displayedAwakeMinutes === null ? '--' : formatCompactDuration(displayedAwakeMinutes)}`}
          title="Time in Bed"
          value={formatCompactDuration(displayedTimeInBedMinutes)}
        />
      </View>

      <View style={styles.metricGrid}>
        <MetricCard
          accentColor={colors.success}
          style={styles.metricCard}
          subtitle={`Wake consistency ${formatNullablePercent(data.wakeConsistency)}`}
          title="Bedtime Rhythm"
          value={formatNullablePercent(data.bedtimeConsistency)}
        />
        <MetricCard
          accentColor={colors.indigo}
          style={styles.metricCard}
          subtitle={`Bedtime consistency ${formatNullablePercent(data.bedtimeConsistency)}`}
          title="Wake Rhythm"
          value={formatNullablePercent(data.wakeConsistency)}
        />
      </View>

      <GlassCard accentColor={colors.primary}>
        <SectionHeader title="Tonight's Plan" trailing={`Need ${formatDuration(data.sleepPlan.sleepNeedMinutes)}`} />
        <View style={styles.planGrid}>
          <View style={styles.planMetric}>
            <Text style={styles.planLabel}>Optimal bedtime</Text>
            <Text style={styles.planValue}>{sleepPlan.optimalBedtime}</Text>
            <Text style={styles.planDetail}>Wake by {sleepPlan.targetWakeTime}</Text>
          </View>
          <View style={styles.planMetric}>
            <Text style={styles.planLabel}>Sleep debt</Text>
            <Text style={styles.planValue}>{formatDuration(sleepPlan.sleepDebtMinutes)}</Text>
            <Text style={styles.planDetail}>
              {sleepPlan.napCreditMinutes > 0
                ? `Nap credit ${formatDuration(sleepPlan.napCreditMinutes)}`
                : 'No nap credit applied'}
            </Text>
          </View>
        </View>

        <View style={styles.targetEditor}>
          <Text style={styles.planLabel}>Target wake-up</Text>
          <View style={styles.targetControls}>
            <Pressable
              accessibilityRole="button"
              disabled={savingAlarm}
              onPress={() => {
                void adjustWakeTarget(-15);
              }}
              style={({ pressed }) => [
                styles.targetButton,
                savingAlarm ? styles.targetButtonDisabled : null,
                pressed ? styles.targetButtonPressed : null,
              ]}>
              <Text style={styles.targetButtonLabel}>Earlier</Text>
              <Text style={styles.targetButtonCaption}>-15 min</Text>
            </Pressable>

            <View style={styles.targetValuePill}>
              <Text style={styles.targetValue}>{sleepPlan.targetWakeTime}</Text>
              <Text style={styles.targetCaption}>{savingAlarm ? 'Saving...' : '15 minute steps'}</Text>
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={savingAlarm}
              onPress={() => {
                void adjustWakeTarget(15);
              }}
              style={({ pressed }) => [
                styles.targetButton,
                savingAlarm ? styles.targetButtonDisabled : null,
                pressed ? styles.targetButtonPressed : null,
              ]}>
              <Text style={styles.targetButtonLabel}>Later</Text>
              <Text style={styles.targetButtonCaption}>+15 min</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.alarmSection}>
          <View style={styles.alarmHeader}>
            <Text style={styles.planLabel}>Alarm</Text>
            <View
              style={[
                styles.alarmBadge,
                sleepPlan.alarmEnabled ? styles.alarmBadgeEnabled : styles.alarmBadgeDisabled,
              ]}>
              <Text style={styles.alarmBadgeLabel}>
                {sleepPlan.alarmEnabled
                  ? alarmSettingsChanged ? 'Unsaved changes' : 'Enabled'
                  : 'Disabled'}
              </Text>
            </View>
          </View>
          <Text style={styles.alarmCaption}>
            {sleepPlan.alarmEnabled
              ? alarmSettingsChanged
                ? `${alarmSummary}. Press Update alarm to save this schedule and re-arm the wearable.`
                : `${alarmSummary}. ${
                    sleepPlan.nextAlarmAt
                      ? `Wearable alarm is set for ${formatClock(parseSqliteDateTime(sleepPlan.nextAlarmAt))}.`
                      : 'The wearable will be armed after sleep is detected and a 100% time can be projected.'
                  }`
              : `${alarmSummary}. Changes stay local until you press Enable alarm. Enabling also schedules a quiet phone reminder one hour before bed.`}
          </Text>

          <View style={styles.alarmSettingGroup}>
            <Text style={styles.alarmSettingLabel}>Schedule</Text>
            <View style={styles.alarmOptionRow}>
              <AlarmOptionButton
                active={resolvedAlarmScheduleKind === 'one_off'}
                caption="Next wake time"
                disabled={savingAlarm}
                label="One-off"
                onPress={() => {
                  setAlarmScheduleKind('one_off');
                  setAlarmError(null);
                }}
              />
              <AlarmOptionButton
                active={resolvedAlarmScheduleKind === 'recurring'}
                caption="Custom days"
                disabled={savingAlarm}
                label="Recurring"
                onPress={() => {
                  setAlarmScheduleKind('recurring');
                  setAlarmError(null);
                }}
              />
            </View>

            {resolvedAlarmScheduleKind === 'recurring' ? (
              <View style={styles.weekdayChipRow}>
                {weekdayOptions.map((weekday) => {
                  const selected = isAlarmWeekdaySelected(resolvedAlarmWeekdayMask, weekday.index);

                  return (
                    <Pressable
                      accessibilityRole="button"
                      disabled={savingAlarm}
                      key={weekday.index}
                      onPress={() => {
                        setAlarmWeekdayMask((currentMask) => {
                          const nextMask =
                            (currentMask & ALARM_WEEKDAY_FULL_MASK) ^ (1 << weekday.index);
                          return nextMask & ALARM_WEEKDAY_FULL_MASK;
                        });
                        setAlarmError(null);
                      }}
                      style={({ pressed }) => [
                        styles.weekdayChip,
                        selected ? styles.weekdayChipSelected : null,
                        savingAlarm ? styles.targetButtonDisabled : null,
                        pressed ? styles.targetButtonPressed : null,
                      ]}>
                      <Text style={[styles.weekdayChipLabel, selected ? styles.weekdayChipLabelSelected : null]}>
                        {weekday.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>

          <View style={styles.alarmSettingGroup}>
            <Text style={styles.alarmSettingLabel}>Wake mode</Text>
            <View style={styles.alarmOptionColumn}>
              <AlarmOptionButton
                active={resolvedAlarmWakeMode === 'exact_time'}
                caption="Always ring at target wake time"
                disabled={savingAlarm}
                label="Exact time"
                onPress={() => {
                  setAlarmWakeMode('exact_time');
                  setAlarmError(null);
                }}
              />
              <AlarmOptionButton
                active={resolvedAlarmWakeMode === 'score_or_time'}
                caption="Use projected 100% sleep score if it is earlier"
                disabled={savingAlarm}
                label="100% or time, whichever comes first"
                onPress={() => {
                  setAlarmWakeMode('score_or_time');
                  setAlarmError(null);
                }}
              />
              <AlarmOptionButton
                active={resolvedAlarmWakeMode === 'score_only'}
                caption="Do not arm the wearable until sleep is in progress"
                disabled={savingAlarm}
                label="Wait until 100%"
                onPress={() => {
                  setAlarmWakeMode('score_only');
                  setAlarmError(null);
                }}
              />
            </View>
          </View>

          {!hasRecurringWakeDay ? (
            <Text style={styles.planError}>Select at least one wake day before enabling a recurring alarm.</Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={savingAlarm || (!hasRecurringWakeDay && !sleepPlan.alarmEnabled)}
            onPress={() => {
              if (sleepPlan.alarmEnabled) {
                if (alarmSettingsChanged) {
                  void turnAlarmOn();
                } else {
                  void turnAlarmOff();
                }
                return;
              }

              void turnAlarmOn();
            }}
            style={({ pressed }) => [
              styles.alarmToggleButton,
              sleepPlan.alarmEnabled && !alarmSettingsChanged
                ? styles.alarmToggleButtonDanger
                : styles.alarmToggleButtonPrimary,
              savingAlarm ? styles.targetButtonDisabled : null,
              pressed ? styles.targetButtonPressed : null,
            ]}>
            <Text style={styles.alarmToggleLabel}>
              {sleepPlan.alarmEnabled
                ? alarmSettingsChanged ? 'Update alarm' : 'Disable alarm'
                : 'Enable alarm'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.planFootnote}>
          Based on your recent three-night sleep debt and any nap credit since your last overnight sleep.
          {' '}
          Changing your wake-up time, schedule, or wake mode does not update the alarm until you confirm it with Enable alarm.
          {' '}
          {deviceState.id
            ? 'Enable alarm pushes the next computed alarm time to the selected wearable when one exists.'
            : 'Select a wearable before enabling if you want to push it to hardware.'}
        </Text>
        {reminderNotice ? <Text style={styles.planFootnote}>{reminderNotice}</Text> : null}
        {wakeTargetError ? <Text style={styles.planError}>{wakeTargetError}</Text> : null}
        {alarmError ? <Text style={styles.planError}>{alarmError}</Text> : null}
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Sleep Score Trend" trailing="14 day rhythm" />
        <ChartReadout
          accentColor={colors.violet}
          detail={`Latest night ${data.sessions[0]?.dateLabel ?? '--'}`}
          label={data.isInProgress ? 'In progress' : 'Latest sleep score'}
          style={styles.readout}
          value={formatMetricValue(data.headlineScore, 0)}
        />
        <TrendChart
          accentColor={colors.violet}
          barColorForPoint={(point) =>
            point.value === null ? undefined : getMetricToneColor(getSleepMetricTone(point.value))
          }
          mode="bar"
          points={data.scoreTrend}
          selectionValueFormatter={(selection) => formatNullablePercent(selection.point.value)}
          testID="sleep-score-trend-chart"
        />
      </GlassCard>

      <GlassCard accentColor={colors.aqua}>
        <SectionHeader title="Duration Trend" trailing="Hours slept" />
        <ChartReadout
          accentColor={colors.aqua}
          detail={displayedIsInProgress
            ? `Bedtime ${displayedBedtime} · Synced through ${displayedWakeTime}`
            : `Bedtime ${displayedBedtime} · Wake ${displayedWakeTime}`}
          label={`${selectedSession?.dateLabel ?? 'Latest'} duration`}
          style={styles.readout}
          value={formatDuration(displayedDurationMinutes)}
        />
        <TrendChart
          accentColor={colors.aqua}
          mode="bar"
          points={data.durationTrend}
          selectionValueFormatter={(selection) => formatDuration(selection.point.value)}
          testID="sleep-duration-trend-chart"
        />
        <Text style={styles.footnote}>
          {selectedSession ? `${selectedSession.dateLabel} duration` : 'Latest duration'}:{' '}
          {formatDuration(displayedDurationMinutes)}
        </Text>
      </GlassCard>

      <GlassCard accentColor={colors.indigo}>
        <SectionHeader
          title="Night Stages"
          trailing={selectedSession ? `${resolvedSelectedSessionIndex + 1} of ${sessions.length}` : 'Waiting'}
        />
        {selectedSession ? (
          <>
            <View style={styles.sessionNavigator}>
              <Pressable
                accessibilityLabel="Show older sleep day"
                accessibilityRole="button"
                disabled={!hasOlderSession}
                onPress={selectOlderSession}
                style={({ pressed }) => [
                  styles.sessionNavigatorButton,
                  !hasOlderSession ? styles.sessionNavigatorButtonDisabled : null,
                  pressed ? styles.targetButtonPressed : null,
                ]}
                testID="sleep-day-backward-button">
                <Ionicons color={hasOlderSession ? colors.text : colors.muted} name="chevron-back" size={14} />
                <Text style={styles.sessionNavigatorButtonLabel}>Older</Text>
              </Pressable>

              <View style={styles.sessionNavigatorCenter}>
                <Text style={styles.sessionNavigatorDate} testID="sleep-selected-session-label">
                  {selectedSession.dateLabel}
                </Text>
                <Text style={styles.sessionNavigatorMeta}>
                  {selectedSession.isInProgress
                    ? `${selectedSession.bedtime} - synced through ${selectedSession.wakeTime}`
                    : `${selectedSession.bedtime} to ${selectedSession.wakeTime}`}
                </Text>
              </View>

              <Pressable
                accessibilityLabel="Show newer sleep day"
                accessibilityRole="button"
                disabled={!hasNewerSession}
                onPress={selectNewerSession}
                style={({ pressed }) => [
                  styles.sessionNavigatorButton,
                  !hasNewerSession ? styles.sessionNavigatorButtonDisabled : null,
                  pressed ? styles.targetButtonPressed : null,
                ]}
                testID="sleep-day-forward-button">
                <Text style={styles.sessionNavigatorButtonLabel}>Newer</Text>
                <Ionicons color={hasNewerSession ? colors.text : colors.muted} name="chevron-forward" size={14} />
              </Pressable>
            </View>

            <View style={styles.stageOverview}>
              <View>
                <Text style={styles.stageOverviewLabel}>Sleep architecture</Text>
                <Text style={styles.stageOverviewValue}>{formatCompactDuration(selectedSession.durationMinutes)}</Text>
              </View>
              <View style={styles.stageOverviewBadge}>
                <Text style={styles.stageOverviewBadgeLabel}>
                  Efficiency {formatNullablePercent(selectedSession.efficiency)}
                </Text>
              </View>
            </View>

            <SleepStageChart
              accentColor={colors.indigo}
              endLabel={selectedSession.isInProgress ? `Synced ${selectedSession.wakeTime}` : selectedSession.wakeTime}
              highlightedStage={pinnedStage}
              middleLabel={selectedSessionMiddleLabel}
              onSelectionChange={setStageSelection}
              segments={selectedSession.stages}
              startLabel={selectedSession.bedtime}
              testID="sleep-last-night-stage-chart"
            />
            <Text style={styles.stageHint}>Swipe across the bar to inspect each stage slice.</Text>
            {selectedStageBreakdown.length > 0 ? (
              <View style={styles.stageBreakdownGrid}>
                {selectedStageBreakdown.map(({ stage, label, minutes }) => (
                  <SleepStageBreakdownChip
                    accentColor={sleepStageColors[stage]}
                    key={stage}
                    onPress={() => {
                      setPinnedStage((currentStage) => (currentStage === stage ? null : stage));
                    }}
                    selected={activeStage === stage}
                    label={label}
                    value={formatCompactDuration(minutes)}
                  />
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <Text style={styles.emptyText}>{data.missingReason ?? 'Sleep stages will appear after the first full overnight sync.'}</Text>
        )}
      </GlassCard>

      <GlassCard accentColor={colors.success}>
        <SectionHeader title="Recent Nights" trailing="Most recent sessions" />
        {data.sessions.length > 0 ? data.sessions.map((session, index) => (
          <Pressable
            accessibilityRole="button"
            key={session.id}
            onPress={() => {
              setSelectedSessionId(session.id);
            }}
            style={({ pressed }) => [
              styles.sessionRow,
              session.id === selectedSession?.id ? styles.sessionRowSelected : null,
              index < data.sessions.length - 1 ? styles.sessionDivider : null,
              pressed ? styles.targetButtonPressed : null,
            ]}>
            <View>
              <Text style={styles.sessionDate}>{session.dateLabel}</Text>
              <Text style={styles.sessionTime}>
                {session.isInProgress
                  ? `${session.bedtime} - synced through ${session.wakeTime}`
                  : `${session.bedtime} to ${session.wakeTime}`}
              </Text>
            </View>
            <View style={styles.sessionMeta}>
              <Text style={styles.sessionScore}>{formatMetricValue(session.score, 0)}</Text>
              <Ionicons color={colors.success} name="moon" size={16} />
            </View>
          </Pressable>
        )) : (
          <Text style={styles.emptyText}>{data.missingReason ?? 'Recent nights will appear after the first full overnight sync.'}</Text>
        )}
      </GlassCard>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    marginTop: 6,
  },
  syncNotice: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  metricGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  metricCard: {
    flex: 1,
  },
  planGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  planMetric: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    padding: 14,
  },
  planLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  planValue: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 28,
    marginTop: 8,
  },
  planDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 6,
  },
  targetEditor: {
    gap: 10,
    marginTop: 16,
  },
  alarmSection: {
    gap: 10,
    marginTop: 18,
  },
  alarmHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  alarmCaption: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 19,
  },
  alarmSettingGroup: {
    gap: 8,
    marginTop: 4,
  },
  alarmSettingLabel: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  alarmOptionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  alarmOptionColumn: {
    gap: 10,
  },
  alarmOptionButton: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    minHeight: 54,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  alarmOptionButtonActive: {
    backgroundColor: 'rgba(126, 255, 169, 0.14)',
    borderColor: 'rgba(126, 255, 169, 0.36)',
  },
  alarmOptionButtonLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
    lineHeight: 17,
  },
  alarmOptionButtonLabelActive: {
    color: colors.primaryBright,
  },
  alarmOptionButtonCaption: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
  },
  weekdayChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  weekdayChip: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    minWidth: 45,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  weekdayChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  weekdayChipLabel: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  weekdayChipLabelSelected: {
    color: colors.background,
  },
  alarmBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  alarmBadgeEnabled: {
    backgroundColor: 'rgba(126, 255, 169, 0.18)',
    borderColor: 'rgba(126, 255, 169, 0.28)',
    borderWidth: 1,
  },
  alarmBadgeDisabled: {
    backgroundColor: 'rgba(149, 160, 183, 0.12)',
    borderColor: colors.border,
    borderWidth: 1,
  },
  alarmBadgeLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 11,
  },
  targetControls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  targetButton: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderStrong,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  targetButtonPressed: {
    opacity: 0.82,
  },
  targetButtonDisabled: {
    opacity: 0.55,
  },
  targetButtonLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
    textAlign: 'center',
  },
  targetButtonCaption: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  targetValuePill: {
    alignItems: 'center',
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.borderStrong,
    borderRadius: 18,
    borderWidth: 1,
    minWidth: 116,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  targetValue: {
    color: colors.primaryBright,
    fontFamily: typography.headingMedium,
    fontSize: 24,
  },
  targetCaption: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 11,
    marginTop: 4,
  },
  alarmToggleButton: {
    alignItems: 'center',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  alarmToggleButtonPrimary: {
    backgroundColor: colors.primary,
  },
  alarmToggleButtonDanger: {
    backgroundColor: colors.alert,
  },
  alarmToggleLabel: {
    color: colors.background,
    fontFamily: typography.bodyBold,
    fontSize: 14,
  },
  planFootnote: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  planError: {
    color: colors.alert,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 8,
  },
  footnote: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 8,
  },
  readout: {
    marginBottom: 10,
  },
  sessionNavigator: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  sessionNavigatorButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    minWidth: 78,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  sessionNavigatorButtonDisabled: {
    opacity: 0.45,
  },
  sessionNavigatorButtonLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  sessionNavigatorCenter: {
    flex: 1,
  },
  sessionNavigatorDate: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 18,
    textAlign: 'center',
  },
  sessionNavigatorMeta: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 2,
    textAlign: 'center',
  },
  stageOverview: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  stageOverviewLabel: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  stageOverviewValue: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 26,
    marginTop: 6,
  },
  stageOverviewBadge: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.indigo,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  stageOverviewBadgeLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  stageReadout: {
    marginTop: 12,
  },
  stageHint: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 12,
  },
  stageBreakdownGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  sessionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  sessionRowSelected: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.borderStrong,
    borderRadius: 16,
    borderWidth: 1,
  },
  sessionDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  sessionDate: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  sessionTime: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  sessionMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  emptyText: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 14,
    lineHeight: 22,
  },
  sessionScore: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 24,
  },
});
