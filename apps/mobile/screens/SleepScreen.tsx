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
import { colors, typography } from '@/constants/theme';
import { useSleepHistory } from '@/hooks/useHealthData';
import { useHealthRepository } from '@/providers/HealthDataProvider';
import { useWearableSync } from '@/providers/WearableSyncProvider';
import type { SleepStageSelection, TrendSelection } from '@/types/health';
import {
  formatClockRangeFromStartLabel,
  formatCompactDuration,
  formatDuration,
  formatMetricValue,
  formatNullablePercent,
  formatSleepStageLabel,
} from '@/utils/formatters';
import { formatClockMinutes } from '@/utils/dateTime';
import { calculateOptimalBedtimeMinutes, nextUpcomingClockDate, roundClockMinutes } from '@/utils/sleepPlan';

export function SleepScreen() {
  const repository = useHealthRepository();
  const { deviceState, setAlarm, disableAlarm } = useWearableSync();
  const state = useSleepHistory('14d');
  const [scoreSelection, setScoreSelection] = useState<TrendSelection | null>(null);
  const [durationSelection, setDurationSelection] = useState<TrendSelection | null>(null);
  const [stageSelection, setStageSelection] = useState<SleepStageSelection | null>(null);
  const [targetWakeMinutes, setTargetWakeMinutes] = useState<number | null>(null);
  const [alarmEnabled, setAlarmEnabled] = useState<boolean | null>(null);
  const [wakeTargetError, setWakeTargetError] = useState<string | null>(null);
  const [savingAlarm, setSavingAlarm] = useState(false);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const wakeSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeSaveQueueRef = useRef(Promise.resolve());
  const targetWakeMinutesRef = useRef<number | null>(null);
  const alarmEnabledRef = useRef<boolean | null>(null);
  const data = state.data;

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
  }, [data]);

  useEffect(() => {
    targetWakeMinutesRef.current = targetWakeMinutes;
  }, [targetWakeMinutes]);

  useEffect(() => {
    alarmEnabledRef.current = alarmEnabled;
  }, [alarmEnabled]);

  useEffect(() => () => {
    if (wakeSaveTimeoutRef.current) {
      clearTimeout(wakeSaveTimeoutRef.current);
    }
  }, []);

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell>
        <LoadingState label="Loading sleep score and stage history..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell>
        <ErrorState message="Unable to load sleep history right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const latestSession = data.sessions[0] ?? null;
  const resolvedTargetWakeMinutes = targetWakeMinutes ?? data.sleepPlan.targetWakeMinutes;
  const resolvedAlarmEnabled = alarmEnabled ?? data.sleepPlan.alarmEnabled;
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
    }
    queueWakeTargetCommit();
  };

  const turnAlarmOn = async () => {
    if (savingAlarm) {
      return;
    }

    setSavingAlarm(true);
    setAlarmError(null);
    setAlarmEnabled(true);
    alarmEnabledRef.current = true;

    if (wakeSaveTimeoutRef.current) {
      clearTimeout(wakeSaveTimeoutRef.current);
      wakeSaveTimeoutRef.current = null;
    }

    let savedLocally = false;

    try {
      await repository.enableAlarm(resolvedTargetWakeMinutes);
      savedLocally = true;

      if (deviceState.id) {
        await setAlarm(Math.floor(nextUpcomingClockDate(resolvedTargetWakeMinutes).getTime() / 1000));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update the alarm.';
      setAlarmEnabled(false);
      alarmEnabledRef.current = false;
      setAlarmError(
        savedLocally && deviceState.id
          ? `Alarm saved locally, but the wearable update failed. ${message}`
          : message,
      );
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

      if (deviceState.id) {
        await disableAlarm();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to disable the alarm.';
      setAlarmEnabled(true);
      alarmEnabledRef.current = true;
      setAlarmError(
        savedLocally && deviceState.id
          ? `Alarm was disabled locally, but the wearable update failed. ${message}`
          : message,
      );
    } finally {
      setSavingAlarm(false);
    }
  };

  return (
    <ScreenShell>
      {state.status === 'error' ? (
        <ErrorState message="Showing the last sleep snapshot while refresh catches up." variant="inline" />
      ) : null}
      <View>
        <SectionHeader title="Sleep" trailing="Last 14 nights" />
        <Text style={styles.subtitle}>Rhythm, recovery, and stage balance.</Text>
      </View>

      <GlowRing caption="Sleep Score" label={data.headlineLabel} score={data.headlineScore} size={238} />

      <View style={styles.metricGrid}>
        <MetricCard
          accentColor={colors.violet}
          style={styles.metricCard}
          subtitle={`${data.bedtime} to ${data.wakeTime}`}
          title="Time Asleep"
          value={formatCompactDuration(data.durationMinutes)}
        />
        <MetricCard
          accentColor={colors.aqua}
          style={styles.metricCard}
          subtitle={`Wake consistency ${formatNullablePercent(data.wakeConsistency)}`}
          title="Bedtime Rhythm"
          value={formatNullablePercent(data.bedtimeConsistency)}
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
                {sleepPlan.alarmEnabled ? 'Enabled' : 'Disabled'}
              </Text>
            </View>
          </View>
          <Text style={styles.alarmCaption}>
            {sleepPlan.alarmEnabled
              ? 'Enabled for your current target wake-up time.'
              : 'Wake-up changes stay local until you press Enable alarm.'}
          </Text>

          <Pressable
            accessibilityRole="button"
            disabled={savingAlarm}
            onPress={() => {
              if (sleepPlan.alarmEnabled) {
                void turnAlarmOff();
                return;
              }

              void turnAlarmOn();
            }}
            style={({ pressed }) => [
              styles.alarmToggleButton,
              sleepPlan.alarmEnabled ? styles.alarmToggleButtonDanger : styles.alarmToggleButtonPrimary,
              savingAlarm ? styles.targetButtonDisabled : null,
              pressed ? styles.targetButtonPressed : null,
            ]}>
            <Text style={styles.alarmToggleLabel}>
              {sleepPlan.alarmEnabled ? 'Disable alarm' : 'Enable alarm'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.planFootnote}>
          Based on your recent three-night sleep debt and any nap credit since your last overnight sleep.
          {' '}
          Changing your wake-up time does not update the alarm until you confirm it with Enable alarm.
          {' '}
          {deviceState.id
            ? 'Enable alarm pushes the current target wake-up time to the selected wearable.'
            : 'Select a wearable before enabling if you want to push it to hardware.'}
        </Text>
        {wakeTargetError ? <Text style={styles.planError}>{wakeTargetError}</Text> : null}
        {alarmError ? <Text style={styles.planError}>{alarmError}</Text> : null}
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Sleep Score Trend" trailing="14 day rhythm" />
        <ChartReadout
          accentColor={colors.violet}
          detail={
            scoreSelection
              ? scoreSelection.point.value === null
                ? 'No sleep score recorded for this day'
                : 'Selected nightly score'
              : `Latest night ${data.sessions[0]?.dateLabel ?? '--'}`
          }
          label={scoreSelection?.point.label ?? 'Latest sleep score'}
          style={styles.readout}
          value={
            scoreSelection
              ? formatMetricValue(scoreSelection.point.value, 0)
              : formatMetricValue(data.headlineScore, 0)
          }
        />
        <TrendChart
          accentColor={colors.violet}
          onSelectionChange={setScoreSelection}
          points={data.scoreTrend}
          testID="sleep-score-trend-chart"
        />
      </GlassCard>

      <GlassCard accentColor={colors.aqua}>
        <SectionHeader title="Duration Trend" trailing="Hours slept" />
        <ChartReadout
          accentColor={colors.aqua}
          detail={
            durationSelection
              ? durationSelection.point.value === null
                ? 'No overnight duration recorded for this day'
                : 'Selected time asleep'
              : `Bedtime ${data.bedtime} · Wake ${data.wakeTime}`
          }
          label={durationSelection?.point.label ?? 'Latest duration'}
          style={styles.readout}
          value={
            durationSelection
              ? formatDuration(durationSelection.point.value)
              : formatDuration(data.durationMinutes)
          }
        />
        <TrendChart
          accentColor={colors.aqua}
          onSelectionChange={setDurationSelection}
          points={data.durationTrend}
          testID="sleep-duration-trend-chart"
        />
        {!durationSelection ? <Text style={styles.footnote}>Latest duration: {formatDuration(data.durationMinutes)}</Text> : null}
      </GlassCard>

      <GlassCard accentColor={colors.indigo}>
        <SectionHeader title="Last Night Stages" trailing={latestSession?.dateLabel ?? 'Waiting'} />
        {latestSession ? (
          <>
            <SleepStageChart
              accentColor={colors.indigo}
              endLabel={latestSession.wakeTime}
              middleLabel="3:00 AM"
              onSelectionChange={setStageSelection}
              segments={latestSession.stages}
              startLabel={latestSession.bedtime}
              testID="sleep-last-night-stage-chart"
            />
            {stageSelection ? (
              <ChartReadout
                accentColor={colors.indigo}
                detail={`${stageSelection.segment.minutes}m · ${formatClockRangeFromStartLabel(
                  latestSession.bedtime,
                  stageSelection.startMinute,
                  stageSelection.endMinute,
                )}`}
                label={formatSleepStageLabel(stageSelection.segment.stage)}
                size="compact"
                style={styles.stageReadout}
                value={`${stageSelection.segment.minutes}m`}
              />
            ) : (
              <View style={styles.sessionStats}>
                <Text style={styles.sessionStat}>Efficiency {formatNullablePercent(latestSession.efficiency)}</Text>
                <Text style={styles.sessionStat}>REM {latestSession.remMinutes}m</Text>
                <Text style={styles.sessionStat}>Deep {latestSession.deepMinutes}m</Text>
              </View>
            )}
          </>
        ) : (
          <Text style={styles.emptyText}>{data.missingReason ?? 'Sleep stages will appear after the first full overnight sync.'}</Text>
        )}
      </GlassCard>

      <GlassCard accentColor={colors.success}>
        <SectionHeader title="Recent Nights" trailing="Most recent sessions" />
        {data.sessions.length > 0 ? data.sessions.map((session, index) => (
          <View key={session.id} style={[styles.sessionRow, index < data.sessions.length - 1 ? styles.sessionDivider : null]}>
            <View>
              <Text style={styles.sessionDate}>{session.dateLabel}</Text>
              <Text style={styles.sessionTime}>
                {session.bedtime} to {session.wakeTime}
              </Text>
            </View>
            <View style={styles.sessionMeta}>
              <Text style={styles.sessionScore}>{formatMetricValue(session.score, 0)}</Text>
              <Ionicons color={colors.success} name="moon" size={16} />
            </View>
          </View>
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
  sessionStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  sessionStat: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  stageReadout: {
    marginTop: 8,
  },
  sessionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
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
