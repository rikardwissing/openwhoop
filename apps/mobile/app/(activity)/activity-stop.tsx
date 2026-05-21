import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing, typography } from '@/constants/theme';
import type { ActiveActivityFinishSummary } from '@/data/HealthRepository';
import { fetchGraphQLActiveActivity } from '@/hooks/useGraphQLActiveActivity';
import { useAppDatabase } from '@/providers/AppDatabaseProvider';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useWearableSyncActions, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { endActivityLiveActivities } from '@/services/widgets/activityLiveActivity';
import { getManualActivityIconName } from '@/utils/activityIcons';
import { formatClock } from '@/utils/dateTime';
import { formatMetricValue, formatShortDuration } from '@/utils/formatters';

const ACTIVITY_STOP_REFRESH_SCOPES = ['dashboard', 'sleep', 'heart', 'wellness', 'trends'] as const;

export default function ActivityStopScreen() {
  const router = useRouter();
  const db = useAppDatabase();
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { isReady } = useWearableSyncState();
  const { runBackgroundSync } = useWearableSyncActions();
  const [summary, setSummary] = useState<ActiveActivityFinishSummary | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncWarningMessage, setSyncWarningMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const stoppedAt = new Date();
        const activeActivity = await fetchGraphQLActiveActivity(db);
        let syncWarning: string | null = null;

        if (activeActivity) {
          try {
            const syncResult = await runBackgroundSync({
              ignoreCooldown: true,
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
  }, [db, isReady, refreshHealthData, repository, runBackgroundSync]);

  const goToday = useCallback(() => {
    router.replace('/' as never);
  }, [router]);

  if (status === 'loading') {
    return (
      <StopTakeoverFrame>
        <StatusPill color={colors.heart} label="Stopping" />
        <View style={styles.hero}>
          <View style={styles.iconBadge}>
            <ActivityIndicator color={colors.heart} size="large" />
          </View>
          <Text style={styles.title}>Stopping...</Text>
          <Text style={styles.subtitle}>Syncing wearable data before saving your activity</Text>
        </View>
        <View style={styles.actionsSpacer} />
      </StopTakeoverFrame>
    );
  }

  if (status === 'error') {
    return (
      <StopTakeoverFrame>
        <StatusPill color={colors.alert} label="Stop failed" />
        <View style={styles.hero}>
          <View style={[styles.iconBadge, styles.alertIconBadge]}>
            <Ionicons color={colors.alert} name="alert-circle" size={34} />
          </View>
          <Text style={styles.title}>Unable to stop</Text>
          <Text style={styles.subtitle}>{errorMessage ?? 'Unable to stop this activity right now.'}</Text>
        </View>
        <View style={styles.actions}>
          <ActionButton accentColor={colors.success} label="Back to Today" onPress={goToday} />
        </View>
      </StopTakeoverFrame>
    );
  }

  if (!summary) {
    return (
      <StopTakeoverFrame>
        <StatusPill color={colors.muted} label="Nothing active" />
        <View style={styles.hero}>
          <View style={[styles.iconBadge, styles.mutedIconBadge]}>
            <Ionicons color={colors.muted} name="checkmark" size={34} />
          </View>
          <Text style={styles.title}>No activity in progress</Text>
          <Text style={styles.subtitle}>There was nothing active to stop.</Text>
        </View>
        <View style={styles.actions}>
          <ActionButton accentColor={colors.success} label="Back to Today" onPress={goToday} />
        </View>
      </StopTakeoverFrame>
    );
  }

  return (
    <StopTakeoverFrame>
      <StatusPill color={colors.success} label="Activity saved" />
      <View style={styles.hero}>
        <View style={styles.iconBadge}>
          <Ionicons color={colors.heart} name={getManualActivityIconName(summary.activity)} size={34} />
        </View>
        <Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>
          {summary.activity}
        </Text>
        <Text style={styles.subtitle}>
          {formatClock(summary.start)} - {formatClock(summary.end)}
        </Text>
      </View>

      <View style={styles.resultContent}>
        <View style={styles.metrics}>
          <Metric label="Duration" value={formatShortDuration(summary.durationMinutes)} valueColor={colors.success} />
          <Metric label="Avg HR" value={summary.averageHr === null ? '--' : `${Math.round(summary.averageHr)} bpm`} valueColor={colors.heart} />
          <Metric label="Max HR" value={summary.maxHr === null ? '--' : `${Math.round(summary.maxHr)} bpm`} valueColor={colors.alert} />
          <Metric label="Strain" value={formatMetricValue(summary.strain, 1)} valueColor={colors.aqua} />
          <Metric label="Calories" value={summary.calories === null ? '--' : `${Math.round(summary.calories)} kcal`} valueColor={colors.cyan} />
        </View>

        {syncWarningMessage ? (
          <Text style={styles.warning}>Activity saved, but wearable sync did not complete: {syncWarningMessage}</Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        <ActionButton accentColor={colors.success} label="Back to Today" onPress={goToday} />
      </View>
    </StopTakeoverFrame>
  );
}

function StopTakeoverFrame({ children }: { children: ReactNode }) {
  return (
    <View style={styles.overlay}>
      <LinearGradient
        colors={[colors.backgroundTop, colors.background, colors.backgroundBottom]}
        pointerEvents="none"
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={styles.safeArea}>
        <View style={styles.content}>{children}</View>
      </SafeAreaView>
    </View>
  );
}

function StatusPill({ color, label }: { color: string; label: string }) {
  return (
    <View style={[styles.statusPill, { backgroundColor: `${color}16`, borderColor: `${color}40` }]}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text style={[styles.statusText, { color }]}>{label}</Text>
    </View>
  );
}

function Metric({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.metricValue, valueColor ? { color: valueColor } : null]}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  accentColor,
  label,
  onPress,
}: {
  accentColor: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        {
          backgroundColor: `${accentColor}1f`,
          borderColor: `${accentColor}55`,
        },
        pressed ? styles.actionButtonPressed : null,
      ]}>
      <Text style={[styles.actionButtonText, { color: accentColor }]}>{label}</Text>
      <Ionicons color={accentColor} name="arrow-forward" size={16} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.background,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.screenPadding,
    paddingVertical: 22,
  },
  statusPill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusDot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  statusText: {
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
  },
  hero: {
    alignItems: 'center',
    gap: 12,
  },
  iconBadge: {
    alignItems: 'center',
    backgroundColor: `${colors.heart}16`,
    borderColor: `${colors.heart}45`,
    borderRadius: 999,
    borderWidth: 1,
    height: 84,
    justifyContent: 'center',
    width: 84,
  },
  alertIconBadge: {
    backgroundColor: `${colors.alert}16`,
    borderColor: `${colors.alert}45`,
  },
  mutedIconBadge: {
    backgroundColor: `${colors.muted}16`,
    borderColor: `${colors.muted}45`,
  },
  title: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 54,
    lineHeight: 62,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  resultContent: {
    gap: 12,
  },
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metric: {
    backgroundColor: 'rgba(255, 255, 255, 0.045)',
    borderColor: 'rgba(255, 255, 255, 0.09)',
    borderRadius: 8,
    borderWidth: 1,
    flexGrow: 1,
    flexBasis: '30%',
    minHeight: 92,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  metricLabel: {
    color: colors.muted,
    fontFamily: typography.bodySemiBold,
    fontSize: 11,
  },
  metricValue: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 28,
    lineHeight: 36,
    marginTop: 8,
  },
  warning: {
    color: colors.alert,
    fontFamily: typography.bodySemiBold,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionsSpacer: {
    minHeight: 54,
  },
  actionButton: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 14,
  },
  actionButtonPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.99 }],
  },
  actionButtonText: {
    fontFamily: typography.bodyBold,
    fontSize: 15,
  },
});
