import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DashboardHeroMetricCard } from '@/components/dashboard/DashboardHeroMetricCard';
import {
  ActivitySnapshotCard,
  HeartSnapshotCard,
  InsightsCard,
  SleepSnapshotCard,
} from '@/components/dashboard/DashboardSnapshotCards';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { colors, typography } from '@/constants/theme';
import { useDashboardSnapshot } from '@/hooks/useHealthData';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import { getRecoveryMetricTone, getSleepMetricTone, getStrainMetricTone } from '@/utils/metricTone';
import { dateKey } from '@/utils/dateTime';

function HistoryHeaderAccessory({
  canGoBack,
  canGoForward,
  currentLabel,
  onOpenPicker,
  onPressBack,
  onPressForward,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  currentLabel: string;
  onOpenPicker: () => void;
  onPressBack: () => void;
  onPressForward: () => void;
}) {
  return (
    <View style={styles.headerAccessory}>
      <Pressable
        accessibilityRole="button"
        disabled={!canGoBack}
        onPress={onPressBack}
        style={({ pressed }) => [
          styles.navButton,
          !canGoBack ? styles.navButtonDisabled : null,
          pressed ? styles.navButtonPressed : null,
        ]}
        testID="history-day-backward-button">
        <Ionicons color={canGoBack ? colors.text : colors.muted} name="chevron-back" size={14} />
        <Text style={styles.navButtonText}>Older</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        onPress={onOpenPicker}
        style={({ pressed }) => [styles.dateButton, pressed ? styles.navButtonPressed : null]}
        testID="history-day-picker-button">
        <Ionicons color={colors.primaryBright} name="calendar-outline" size={16} />
        <Text numberOfLines={1} style={styles.dateButtonText} testID="history-selected-day-label">
          {currentLabel}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        disabled={!canGoForward}
        onPress={onPressForward}
        style={({ pressed }) => [
          styles.navButton,
          !canGoForward ? styles.navButtonDisabled : null,
          pressed ? styles.navButtonPressed : null,
        ]}
        testID="history-day-forward-button">
        <Text style={styles.navButtonText}>Newer</Text>
        <Ionicons color={canGoForward ? colors.text : colors.muted} name="chevron-forward" size={14} />
      </Pressable>
    </View>
  );
}

export function HistoryScreen() {
  const router = useRouter();
  const [selectedDayKey, setSelectedDayKey] = useState<string | undefined>(() => dateKey(new Date()));
  const [pickerVisible, setPickerVisible] = useState(false);
  const state = useDashboardSnapshot(selectedDayKey);
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const data = state.data;

  const availableDays = useMemo(
    () => [...(data?.day.availableDays ?? [])].reverse(),
    [data?.day.availableDays],
  );

  if (!data && state.status === 'loading') {
    return (
      <ScreenShell headerIcon="history" headerTitle="History" onRefresh={onRefresh} refreshing={refreshing}>
        <LoadingState label="Loading your day history..." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data && state.status === 'error') {
    return (
      <ScreenShell headerIcon="history" headerTitle="History" onRefresh={onRefresh} refreshing={refreshing}>
        <ErrorState message="Unable to load historical snapshots right now." variant="inline" />
      </ScreenShell>
    );
  }

  if (!data) {
    return null;
  }

  const openSleep = () => router.push('/sleep');
  const openWellness = () => router.push('/wellness');

  return (
    <>
      <ScreenShell
        headerAccessory={
          <HistoryHeaderAccessory
            canGoBack={Boolean(data.day.olderDayKey)}
            canGoForward={Boolean(data.day.newerDayKey)}
            currentLabel={data.dateLabel}
            onOpenPicker={() => setPickerVisible(true)}
            onPressBack={() => setSelectedDayKey(data.day.olderDayKey ?? undefined)}
            onPressForward={() => setSelectedDayKey(data.day.newerDayKey ?? undefined)}
          />
        }
        headerIcon="history"
        headerTitle="History"
        onRefresh={onRefresh}
        refreshing={refreshing}>
        {state.status === 'error' ? (
          <ErrorState message="Showing the last historical snapshot while refresh catches up." variant="inline" />
        ) : null}

        <View>
          <Text style={styles.screenTitle}>{data.dateLabel}</Text>
          <Text style={styles.screenSubtitle}>
            Day-based snapshot of recovery, sleep, load, and context for the selected date.
          </Text>
        </View>

        <View style={styles.heroRow}>
          <DashboardHeroMetricCard
            caption="Recovery"
            label={data.recovery.label}
            onPress={openWellness}
            score={data.recovery.score}
            testID="history-open-recovery-hero"
            tone={getRecoveryMetricTone(data.recovery.score)}
          />
          <DashboardHeroMetricCard
            caption="Sleep"
            label={data.sleepCard.score === null ? 'Waiting' : 'Recorded'}
            onPress={openSleep}
            score={data.sleepCard.score}
            testID="history-open-sleep-hero"
            tone={getSleepMetricTone(data.sleepCard.score)}
          />
          <DashboardHeroMetricCard
            caption="Strain"
            displayDigits={1}
            displaySuffix=""
            label={data.strainCard.label}
            onPress={openWellness}
            progressMax={21}
            score={data.strainCard.score}
            testID="history-open-strain-hero"
            tone={getStrainMetricTone(data.strainCard.score)}
          />
        </View>

        <HeartSnapshotCard
          chartTestID="history-heart-chart"
          snapshot={data.heartCard}
          trailingLabel={data.day.shortLabel}
          viewportKey={data.day.dayKey}
        />

        <SleepSnapshotCard
          chartTestID="history-sleep-stage-chart"
          onOpen={openSleep}
          openTestID="history-open-sleep-button"
          snapshot={data.sleepCard}
          trailingLabel={data.day.shortLabel}
        />

        <ActivitySnapshotCard
          activities={data.activitySummary}
          chartTestID="history-strain-chart"
          onOpen={openWellness}
          openTestID="history-open-activity-button"
          strainCard={data.strainCard}
          trailingLabel={data.day.shortLabel}
        />

        <InsightsCard insights={data.insights} trailingLabel={data.day.shortLabel} />
      </ScreenShell>

      <Modal
        animationType="fade"
        onRequestClose={() => setPickerVisible(false)}
        transparent
        visible={pickerVisible}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Jump to a day</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPickerVisible(false)}
                style={({ pressed }) => [styles.modalClose, pressed ? styles.navButtonPressed : null]}>
                <Ionicons color={colors.text} name="close" size={18} />
              </Pressable>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {availableDays.map((day) => {
                const selected = day.dayKey === data.day.dayKey;
                return (
                  <Pressable
                    accessibilityRole="button"
                    key={day.dayKey}
                    onPress={() => {
                      setSelectedDayKey(day.dayKey);
                      setPickerVisible(false);
                    }}
                    style={({ pressed }) => [
                      styles.dayOption,
                      selected ? styles.dayOptionSelected : null,
                      pressed ? styles.navButtonPressed : null,
                    ]}
                    testID={`history-day-option-${day.dayKey}`}>
                    <Text style={[styles.dayOptionTitle, selected ? styles.dayOptionTitleSelected : null]}>
                      {day.longLabel}
                    </Text>
                    <Text style={styles.dayOptionMeta}>{day.shortLabel}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  headerAccessory: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  navButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    minHeight: 40,
    paddingHorizontal: 10,
  },
  navButtonDisabled: {
    opacity: 0.48,
  },
  navButtonPressed: {
    opacity: 0.82,
  },
  navButtonText: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  dateButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(8, 18, 25, 0.9)',
    borderColor: 'rgba(104, 255, 120, 0.28)',
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 12,
  },
  dateButtonText: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    textAlign: 'center',
  },
  screenTitle: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 30,
    marginTop: 4,
  },
  screenSubtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 6,
  },
  heroRow: {
    flexDirection: 'row',
    gap: 10,
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    maxHeight: '70%',
    padding: 18,
    width: '100%',
  },
  modalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 24,
  },
  modalClose: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  dayOption: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
  },
  dayOptionSelected: {
    backgroundColor: 'rgba(104, 255, 120, 0.08)',
    borderRadius: 14,
    paddingHorizontal: 12,
  },
  dayOptionTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
  },
  dayOptionTitleSelected: {
    color: colors.primaryBright,
  },
  dayOptionMeta: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
});
