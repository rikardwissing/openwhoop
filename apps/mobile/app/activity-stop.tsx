import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { ErrorState, LoadingState } from '@/components/ui/ScreenState';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { colors, typography } from '@/constants/theme';
import type { ActiveActivityFinishSummary } from '@/data/HealthRepository';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useWearableSyncActions } from '@/providers/WearableSyncProvider';
import { endActivityLiveActivities } from '@/services/widgets/activityLiveActivity';
import { formatClock } from '@/utils/dateTime';
import { formatMetricValue, formatShortDuration } from '@/utils/formatters';

const ACTIVITY_STOP_REFRESH_SCOPES = ['dashboard', 'sleep', 'heart', 'wellness', 'trends'] as const;

export default function ActivityStopScreen() {
  const router = useRouter();
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { runBackgroundSync } = useWearableSyncActions();
  const [summary, setSummary] = useState<ActiveActivityFinishSummary | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncWarningMessage, setSyncWarningMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const stoppedAt = new Date();
        const activeActivity = await repository.getActiveActivity();
        let syncWarning: string | null = null;

        if (activeActivity) {
          try {
            const syncResult = await runBackgroundSync({
              showOverlay: false,
              triggerLabel: 'activity stop',
            });

            if (syncResult.status === 'failed') {
              syncWarning = syncResult.message;
            }
          } catch (error) {
            syncWarning = error instanceof Error ? error.message : 'Unable to sync wearable data before stopping.';
          }
        }

        const result = await repository.finishActiveActivity(stoppedAt);
        await endActivityLiveActivities();
        refreshHealthData(ACTIVITY_STOP_REFRESH_SCOPES);

        if (cancelled) {
          return;
        }

        setSyncWarningMessage(syncWarning);
        setSummary(result);
        setStatus(result ? 'ready' : 'empty');
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to stop this activity right now.');
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshHealthData, repository, runBackgroundSync]);

  const goToday = useCallback(() => {
    router.replace('/' as never);
  }, [router]);

  if (status === 'loading') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Activity">
        <LoadingState label="Syncing and stopping activity..." variant="inline" />
      </ScreenShell>
    );
  }

  if (status === 'error') {
    return (
      <ScreenShell headerIcon="today" headerTitle="Activity">
        <ErrorState message={errorMessage ?? 'Unable to stop this activity right now.'} variant="inline" />
        <PrimaryButton label="Back to Today" onPress={goToday} />
      </ScreenShell>
    );
  }

  if (!summary) {
    return (
      <ScreenShell headerIcon="today" headerTitle="Activity">
        <GlassCard accentColor={colors.muted}>
          <View style={styles.headerRow}>
            <View style={styles.iconBadge}>
              <Ionicons color={colors.muted} name="checkmark" size={18} />
            </View>
            <View style={styles.titleBlock}>
              <Text style={styles.title}>No activity in progress</Text>
              <Text style={styles.subtitle}>There was nothing active to stop.</Text>
            </View>
          </View>
        </GlassCard>
        <PrimaryButton label="Back to Today" onPress={goToday} />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell headerIcon="today" headerTitle="Activity">
      <GlassCard accentColor={colors.heart}>
        <View style={styles.headerRow}>
          <View style={styles.iconBadge}>
            <Ionicons color={colors.heart} name="walk" size={18} />
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.eyebrow}>Activity saved</Text>
            <Text style={styles.title}>{summary.activity}</Text>
            <Text style={styles.subtitle}>
              {formatClock(summary.start)} - {formatClock(summary.end)}
            </Text>
          </View>
        </View>

        <View style={styles.chipRow}>
          <StatChip
            accent={colors.success}
            label="Duration"
            value={formatShortDuration(summary.durationMinutes)}
          />
          <StatChip
            accent={colors.heart}
            label="Avg HR"
            value={summary.averageHr === null ? '--' : `${Math.round(summary.averageHr)} bpm`}
          />
          <StatChip
            accent={colors.alert}
            label="Max HR"
            value={summary.maxHr === null ? '--' : `${Math.round(summary.maxHr)} bpm`}
          />
          <StatChip
            accent={colors.aqua}
            label="Strain"
            value={formatMetricValue(summary.strain, 1)}
          />
          <StatChip
            accent={colors.cyan}
            label="Calories"
            value={summary.calories === null ? '--' : `${Math.round(summary.calories)} kcal`}
          />
        </View>
      </GlassCard>

      {syncWarningMessage ? (
        <ErrorState message={`Activity saved, but wearable sync did not complete: ${syncWarningMessage}`} variant="inline" />
      ) : null}

      <PrimaryButton label="Back to Today" onPress={goToday} />
    </ScreenShell>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primaryButton, pressed ? styles.primaryButtonPressed : null]}>
      <Text style={styles.primaryButtonText}>{label}</Text>
      <Ionicons color={colors.background} name="arrow-forward" size={16} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  iconBadge: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: colors.success,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    marginBottom: 2,
  },
  title: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 24,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 14,
    marginTop: 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.success,
    borderRadius: 18,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonPressed: {
    opacity: 0.82,
  },
  primaryButtonText: {
    color: colors.background,
    fontFamily: typography.bodyBold,
    fontSize: 14,
  },
});
