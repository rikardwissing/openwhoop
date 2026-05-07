import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ManualActivityKind } from '@/data/HealthRepository';
import { TrendChart } from '@/components/charts/TrendChart';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useDerivedRefreshState, useWellnessData } from '@/hooks/useHealthData';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import type { ActivitySummary, MetricSeries } from '@/types/health';
import { formatClock, formatSqliteDateTime } from '@/utils/dateTime';
import { formatMetricNumber, formatMetricValue, formatNullablePercent, formatSignedValue } from '@/utils/formatters';
import { getMetricToneColor, getRecoveryMetricTone } from '@/utils/metricTone';

const MANUAL_ACTIVITY_OPTIONS: ManualActivityKind[] = ['Activity', 'Walk', 'Workout', 'Nap'];
const ACTIVITY_REFRESH_SCOPES = ['dashboard', 'sleep', 'heart', 'wellness', 'trends'] as const;

interface ManualActivityFormState {
  activity: ManualActivityKind;
  startInput: string;
  endInput: string;
}

function formatDateTimeInput(date: Date) {
  return formatSqliteDateTime(date).slice(0, 16);
}

function parseDateTimeInput(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized;
  const parsed = new Date(withSeconds);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildDefaultManualForm(): ManualActivityFormState {
  const end = new Date();
  end.setSeconds(0, 0);
  end.setMinutes(Math.floor(end.getMinutes() / 5) * 5);
  const start = new Date(end.getTime() - 45 * 60000);

  return {
    activity: 'Workout',
    startInput: formatDateTimeInput(start),
    endInput: formatDateTimeInput(end),
  };
}

function activityReviewLabel(activity: ActivitySummary) {
  if (activity.source === 'manual') {
    return 'Manual';
  }

  switch (activity.reviewState) {
    case 'confirmed':
      return 'Confirmed';
    case 'relabelled':
      return 'Relabelled';
    default:
      return 'Needs review';
  }
}

function activityReviewTone(activity: ActivitySummary) {
  if (activity.source === 'manual') {
    return colors.primaryBright;
  }

  switch (activity.reviewState) {
    case 'confirmed':
      return colors.success;
    case 'relabelled':
      return colors.aqua;
    default:
      return colors.alert;
  }
}

function ActivityActionButton({
  accent,
  disabled,
  label,
  onPress,
  testID,
}: {
  accent: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        { borderColor: accent },
        disabled ? styles.actionButtonDisabled : null,
        pressed ? styles.actionButtonPressed : null,
      ]}
      testID={testID}>
      <Text style={[styles.actionButtonLabel, { color: accent }]}>{label}</Text>
    </Pressable>
  );
}

function accentColorFor(series: MetricSeries) {
  switch (series.accent) {
    case 'alert':
      return colors.alert;
    case 'heart':
      return colors.heart;
    case 'violet':
      return colors.violet;
    case 'cyan':
      return colors.cyan;
    default:
      return colors.success;
  }
}

function barColorForMetric(metric: MetricSeries, value: number | null) {
  if (value === null) {
    return undefined;
  }

  if (metric.title === 'Recovery Index') {
    return getMetricToneColor(getRecoveryMetricTone(value));
  }

  return undefined;
}

function formatSelectionValue(metric: MetricSeries, value: number | null, digits: number) {
  if (value === null) {
    return 'No data';
  }

  if (metric.unit === '%') {
    return formatNullablePercent(value);
  }

  return metric.unit ? formatMetricNumber(value, metric.unit, digits) : formatMetricValue(value, digits);
}

function digitsForMetric(metric: MetricSeries) {
  if (metric.unit === '°C' || metric.title === 'Respiratory Rate') {
    return 1;
  }

  return 0;
}

function WellnessMetricCard({ metric }: { metric: MetricSeries }) {
  const accentColor = accentColorFor(metric);
  const digits = digitsForMetric(metric);

  return (
    <GlassCard accentColor={accentColor} style={styles.metricCard}>
      <View style={styles.metricCardIntro}>
        <SectionHeader title={metric.title} titleNumberOfLines={1} trailing={metric.unit ? `${metric.unit} trend` : 'Trend'} />
        <View style={styles.metricTopRow}>
          <View style={styles.metricNumberWrap}>
            <Text adjustsFontSizeToFit minimumFontScale={0.82} numberOfLines={1} style={styles.metricNumber}>
              {formatMetricValue(metric.latest, digits)}
              {metric.unit ? <Text style={styles.metricUnit}> {metric.unit}</Text> : null}
            </Text>
          </View>
          {metric.delta !== null ? (
            <StatChip
              accent={accentColor}
              label="Delta"
              style={styles.metricStatChip}
              value={`${formatSignedValue(metric.delta, digits)}${metric.unit}`}
            />
          ) : null}
        </View>
        <Text numberOfLines={2} style={styles.metricDetail}>
          {metric.detail}
        </Text>
        {metric.hasPartialData ? (
          <View style={styles.partialRow}>
            <StatChip accent={colors.alert} label="Signal" value="Limited samples" />
          </View>
        ) : null}
      </View>
      <TrendChart
        accentColor={accentColor}
        barColorForPoint={(point) => barColorForMetric(metric, point.value)}
        height={126}
        mode="bar"
        points={metric.series}
        selectionValueFormatter={(selection) => formatSelectionValue(metric, selection.point.value, digits)}
        testID={`wellness-${metric.title.toLowerCase().replace(/\s+/g, '-')}-chart`}
      />
    </GlassCard>
  );
}

export function WellnessScreen() {
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const state = useWellnessData('14d');
  const derivedRefresh = useDerivedRefreshState();
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [manualVisible, setManualVisible] = useState(false);
  const [manualForm, setManualForm] = useState<ManualActivityFormState>(() => buildDefaultManualForm());
  const [manualError, setManualError] = useState<string | null>(null);
  const [relabelTarget, setRelabelTarget] = useState<ActivitySummary | null>(null);
  const [relabelError, setRelabelError] = useState<string | null>(null);
  const data = state.data;
  const [activityList, setActivityList] = useState<ActivitySummary[]>([]);

  const isMutating = pendingActionKey !== null;

  useEffect(() => {
    setActivityList(data?.activities ?? []);
  }, [data?.activities]);

  async function refreshAfterActivityMutation() {
    refreshHealthData(ACTIVITY_REFRESH_SCOPES);
  }

  async function handleConfirm(activityId: string) {
    setActivityError(null);
    setPendingActionKey(`confirm:${activityId}`);

    try {
      await repository.confirmActivity(activityId);
      setActivityList((current) =>
        current.map((activity) =>
          activity.id === activityId ? { ...activity, reviewState: 'confirmed' } : activity,
        ),
      );
      await refreshAfterActivityMutation();
    } catch (error) {
      setActivityError(error instanceof Error ? error.message : 'Unable to confirm the activity right now.');
    } finally {
      setPendingActionKey(null);
    }
  }

  async function handleDismiss(activityId: string) {
    setActivityError(null);
    setPendingActionKey(`dismiss:${activityId}`);

    try {
      await repository.dismissActivity(activityId);
      setActivityList((current) => current.filter((activity) => activity.id !== activityId));
      await refreshAfterActivityMutation();
    } catch (error) {
      setActivityError(error instanceof Error ? error.message : 'Unable to dismiss the activity right now.');
    } finally {
      setPendingActionKey(null);
    }
  }

  function openManualModal() {
    setManualForm(buildDefaultManualForm());
    setManualError(null);
    setManualVisible(true);
  }

  function openRelabelModal(activity: ActivitySummary) {
    setRelabelError(null);
    setRelabelTarget(activity);
  }

  async function handleSaveManualActivity() {
    setManualError(null);

    const start = parseDateTimeInput(manualForm.startInput);
    const end = parseDateTimeInput(manualForm.endInput);

    if (!start || !end) {
      setManualError('Use local timestamps in YYYY-MM-DD HH:mm format.');
      return;
    }

    if (end.getTime() <= start.getTime()) {
      setManualError('End time must be after start time.');
      return;
    }

    setPendingActionKey('manual:save');

    try {
      const manualId = await repository.createManualActivity(manualForm.activity, start, end);
      setActivityList((current) => [
        ...current,
        {
          id: manualId,
          title: manualForm.activity,
          timeLabel: formatClock(start),
          durationMinutes: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)),
          strain: null,
          calories: null,
          source: 'manual',
          reviewState: 'confirmed',
        },
      ]);
      await refreshAfterActivityMutation();
      setManualVisible(false);
      setManualForm(buildDefaultManualForm());
    } catch (error) {
      setManualError(error instanceof Error ? error.message : 'Unable to save the manual activity right now.');
    } finally {
      setPendingActionKey(null);
    }
  }

  async function handleRelabelActivity(activity: ManualActivityKind) {
    if (!relabelTarget) {
      return;
    }

    setRelabelError(null);
    setPendingActionKey(`relabel:${relabelTarget.id}`);

    try {
      await repository.relabelActivity(relabelTarget.id, activity);
      setActivityList((current) =>
        current.map((entry) =>
          entry.id === relabelTarget.id
            ? {
                ...entry,
                title: activity,
                reviewState: entry.source === 'manual' ? 'confirmed' : 'relabelled',
              }
            : entry,
        ),
      );
      await refreshAfterActivityMutation();
      setRelabelTarget(null);
    } catch (error) {
      setRelabelError(error instanceof Error ? error.message : 'Unable to relabel the activity right now.');
    } finally {
      setPendingActionKey(null);
    }
  }

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="wellness" headerTitle="Wellness">
        <LoadingState label="Loading wellness metrics..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell headerIcon="wellness" headerTitle="Wellness">
        <ErrorState message="Unable to load the wellness board right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const derivedRefreshMessage =
    derivedRefresh.data?.status === 'pending' || derivedRefresh.data?.status === 'processing'
      ? derivedRefresh.data.isFirstSync
        ? 'Preparing insights from your first sync...'
        : 'Updating wellness insights with your latest sync...'
      : null;

  return (
    <ScreenShell headerIcon="wellness" headerTitle="Wellness">
      {state.status === 'error' ? (
        <ErrorState message="Showing the last wellness snapshot while refresh catches up." variant="inline" />
      ) : null}
      {derivedRefreshMessage ? (
        <Text style={styles.syncNotice}>{derivedRefreshMessage}</Text>
      ) : null}
      {derivedRefresh.data?.status === 'error' && derivedRefresh.data.lastError ? (
        <ErrorState message={derivedRefresh.data.lastError} variant="inline" />
      ) : null}
      <View>
        <Text style={styles.subtitle}>Stress, oxygen, respiratory rate, temperature, recovery, and recent activity trends.</Text>
      </View>

      <WellnessMetricCard metric={data.stress} />
      <WellnessMetricCard metric={data.spo2} />
      <WellnessMetricCard metric={data.respiratoryRate} />
      <WellnessMetricCard metric={data.skinTemperature} />
      <WellnessMetricCard metric={data.recoveryIndex} />

      <GlassCard accentColor={colors.success}>
        <SectionHeader
          title="Recent Activity"
          trailing={
            <Pressable
              accessibilityRole="button"
              disabled={isMutating}
              onPress={openManualModal}
              style={({ pressed }) => [
                styles.headerAction,
                isMutating ? styles.actionButtonDisabled : null,
                pressed ? styles.actionButtonPressed : null,
              ]}
              testID="wellness-add-manual-button">
              <Text style={styles.headerActionLabel}>Add manual</Text>
            </Pressable>
          }
        />
        <Text style={styles.activityHelperCopy}>
          Confirm real detections, relabel mistakes, or dismiss false positives before they steer future activity logic.
        </Text>
        {activityError ? <Text style={styles.activityError}>{activityError}</Text> : null}
        {activityList.map((activity, index) => (
          <View key={activity.id} style={[styles.activityRow, index < activityList.length - 1 ? styles.activityDivider : null]}>
            <View style={styles.activityRowHeader}>
              <View style={styles.activityDetails}>
                <Text style={styles.activityTitle}>{activity.title}</Text>
                <Text style={styles.activityMeta}>
                  {activity.timeLabel} · {activity.durationMinutes} min
                </Text>
              </View>

              <View style={styles.activityValues}>
                <View
                  style={[styles.reviewChip, { borderColor: activityReviewTone(activity) }]}
                  testID={`wellness-activity-status-${activity.id}`}>
                  <Text
                    style={[styles.reviewChipLabel, { color: activityReviewTone(activity) }]}
                    testID={`wellness-activity-status-label-${activity.id}`}>
                    {activityReviewLabel(activity)}
                  </Text>
                </View>
                <Text style={styles.activityStrain}>{activity.strain === null ? '-- strain' : `${activity.strain.toFixed(1)} strain`}</Text>
                <Text style={styles.activityCalories}>{activity.calories === null ? '-- kcal' : `${activity.calories} kcal`}</Text>
              </View>
            </View>

            <View style={styles.actionRow}>
              {activity.source !== 'manual' && activity.reviewState !== 'confirmed' ? (
                <ActivityActionButton
                  accent={colors.success}
                  disabled={isMutating}
                  label={pendingActionKey === `confirm:${activity.id}` ? 'Saving...' : 'Confirm'}
                  onPress={() => {
                    void handleConfirm(activity.id);
                  }}
                  testID={`wellness-activity-confirm-${activity.id}`}
                />
              ) : null}

              <ActivityActionButton
                accent={colors.aqua}
                disabled={isMutating}
                label={pendingActionKey === `relabel:${activity.id}` ? 'Saving...' : 'Relabel'}
                onPress={() => openRelabelModal(activity)}
                testID={`wellness-activity-relabel-${activity.id}`}
              />

              <ActivityActionButton
                accent={colors.alert}
                disabled={isMutating}
                label={pendingActionKey === `dismiss:${activity.id}` ? 'Saving...' : 'Dismiss'}
                onPress={() => {
                  void handleDismiss(activity.id);
                }}
                testID={`wellness-activity-dismiss-${activity.id}`}
              />
            </View>
          </View>
        ))}
        {activityList.length === 0 ? <Text style={styles.emptyState}>No activities yet. Add a manual session to seed review data.</Text> : null}
      </GlassCard>

      <Modal
        animationType="fade"
        onRequestClose={() => {
          if (!isMutating) {
            setManualVisible(false);
          }
        }}
        transparent
        visible={manualVisible}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="wellness-manual-modal">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add manual activity</Text>
              <Pressable
                accessibilityRole="button"
                disabled={isMutating}
                onPress={() => setManualVisible(false)}
                style={({ pressed }) => [styles.modalClose, pressed ? styles.actionButtonPressed : null]}
                testID="wellness-manual-close-button">
                <Text style={styles.modalCloseLabel}>Close</Text>
              </Pressable>
            </View>

            <Text style={styles.modalCopy}>Use local timestamps in YYYY-MM-DD HH:mm format.</Text>

            <Text style={styles.fieldLabel}>Type</Text>
            <View style={styles.optionRow}>
              {MANUAL_ACTIVITY_OPTIONS.map((option) => {
                const selected = option === manualForm.activity;
                return (
                  <Pressable
                    accessibilityRole="button"
                    key={option}
                    onPress={() => setManualForm((current) => ({ ...current, activity: option }))}
                    style={({ pressed }) => [
                      styles.optionButton,
                      selected ? styles.optionButtonSelected : null,
                      pressed ? styles.actionButtonPressed : null,
                    ]}
                    testID={`wellness-manual-type-${option.toLowerCase()}`}>
                    <Text style={[styles.optionButtonLabel, selected ? styles.optionButtonLabelSelected : null]}>{option}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>Start</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              onChangeText={(value) => setManualForm((current) => ({ ...current, startInput: value }))}
              placeholder="2026-04-23 08:10"
              placeholderTextColor={colors.subtle}
              style={styles.textInput}
              testID="wellness-manual-start-input"
              value={manualForm.startInput}
            />

            <Text style={styles.fieldLabel}>End</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              onChangeText={(value) => setManualForm((current) => ({ ...current, endInput: value }))}
              placeholder="2026-04-23 08:55"
              placeholderTextColor={colors.subtle}
              style={styles.textInput}
              testID="wellness-manual-end-input"
              value={manualForm.endInput}
            />

            {manualError ? (
              <Text style={styles.modalError} testID="wellness-manual-error">
                {manualError}
              </Text>
            ) : null}

            <View style={styles.modalActionRow}>
              <ActivityActionButton
                accent={colors.muted}
                disabled={isMutating}
                label="Cancel"
                onPress={() => setManualVisible(false)}
                testID="wellness-manual-cancel-button"
              />
              <ActivityActionButton
                accent={colors.primaryBright}
                disabled={isMutating}
                label={pendingActionKey === 'manual:save' ? 'Saving...' : 'Save activity'}
                onPress={() => {
                  void handleSaveManualActivity();
                }}
                testID="wellness-manual-save-button"
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => {
          if (!isMutating) {
            setRelabelTarget(null);
          }
        }}
        transparent
        visible={Boolean(relabelTarget)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="wellness-relabel-modal">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Relabel activity</Text>
              <Pressable
                accessibilityRole="button"
                disabled={isMutating}
                onPress={() => setRelabelTarget(null)}
                style={({ pressed }) => [styles.modalClose, pressed ? styles.actionButtonPressed : null]}
                testID="wellness-relabel-close-button">
                <Text style={styles.modalCloseLabel}>Close</Text>
              </Pressable>
            </View>

            {relabelTarget ? (
              <Text style={styles.modalCopy}>
                {relabelTarget.title} · {relabelTarget.timeLabel} · {relabelTarget.durationMinutes} min
              </Text>
            ) : null}

            <View style={styles.optionColumn}>
              {MANUAL_ACTIVITY_OPTIONS.map((option) => (
                <Pressable
                  accessibilityRole="button"
                  disabled={isMutating}
                  key={option}
                  onPress={() => {
                    void handleRelabelActivity(option);
                  }}
                  style={({ pressed }) => [styles.relabelOption, pressed ? styles.actionButtonPressed : null]}
                  testID={`wellness-relabel-option-${option.toLowerCase()}`}>
                  <Text style={styles.relabelOptionLabel}>{option}</Text>
                </Pressable>
              ))}
            </View>

            {relabelError ? (
              <Text style={styles.modalError} testID="wellness-relabel-error">
                {relabelError}
              </Text>
            ) : null}
          </View>
        </View>
      </Modal>
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
  metricCard: {
    marginBottom: 0,
  },
  metricCardIntro: {
    marginBottom: 8,
    minHeight: 116,
  },
  metricTopRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 8,
    minHeight: 50,
  },
  metricNumberWrap: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  metricStatChip: {
    maxWidth: '44%',
  },
  metricNumber: {
    color: colors.text,
    flexShrink: 1,
    fontFamily: typography.heading,
    fontSize: 40,
    lineHeight: 46,
  },
  metricUnit: {
    color: colors.subtle,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  metricDetail: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
    minHeight: 36,
  },
  partialRow: {
    marginTop: 6,
  },
  headerAction: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerActionLabel: {
    color: colors.primaryBright,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  activityHelperCopy: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
  },
  activityError: {
    color: colors.alert,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    marginTop: 10,
  },
  activityRow: {
    paddingTop: 14,
    paddingVertical: 12,
  },
  activityDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  activityRowHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  activityDetails: {
    flex: 1,
    paddingRight: 12,
  },
  activityTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  activityMeta: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  activityValues: {
    alignItems: 'flex-end',
    gap: 4,
  },
  reviewChip: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 2,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  reviewChipLabel: {
    fontFamily: typography.bodySemiBold,
    fontSize: 11,
  },
  activityStrain: {
    color: colors.success,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
  },
  activityCalories: {
    color: colors.subtle,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  actionButton: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionButtonDisabled: {
    opacity: 0.55,
  },
  actionButtonPressed: {
    opacity: 0.8,
  },
  actionButtonLabel: {
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  emptyState: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
    paddingTop: 14,
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(1, 5, 11, 0.72)',
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.border,
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    width: '100%',
  },
  modalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalTitle: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 22,
  },
  modalClose: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  modalCloseLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  modalCopy: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
  },
  fieldLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 13,
    marginTop: 14,
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontFamily: typography.body,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionColumn: {
    gap: 8,
    marginTop: 14,
  },
  optionButton: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionButtonSelected: {
    borderColor: colors.primaryBright,
    backgroundColor: colors.surface,
  },
  optionButtonLabel: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  optionButtonLabelSelected: {
    color: colors.primaryBright,
  },
  relabelOption: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  relabelOptionLabel: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
  },
  modalError: {
    color: colors.alert,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  modalActionRow: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 18,
  },
});
