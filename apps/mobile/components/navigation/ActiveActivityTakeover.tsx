import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing, typography } from '@/constants/theme';
import type { ActiveActivity } from '@/data/HealthRepository';
import { useGraphQLActiveActivity } from '@/hooks/useGraphQLActiveActivity';
import { useHealthDataVersion, useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import { useWearableSyncState } from '@/providers/WearableSyncProvider';
import { endActivityLiveActivities, startOrUpdateActivityLiveActivity } from '@/services/widgets/activityLiveActivity';
import { getManualActivityIconName } from '@/utils/activityIcons';
import { hasFreshLiveHeartRate } from '@/types/device';
import { formatClock } from '@/utils/dateTime';
import { formatShortDuration } from '@/utils/formatters';

const ACTIVE_ACTIVITY_REFRESH_SCOPES = ['dashboard', 'sleep', 'heart', 'wellness', 'trends'] as const;

export function ActiveActivityTakeover() {
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const heartVersion = useHealthDataVersion('heart');
  const { deviceState } = useWearableSyncState();
  const router = useRouter();
  const pathname = usePathname();
  const [localActiveVersion, setLocalActiveVersion] = useState(0);
  const [activeActivity, setActiveActivity] = useState<ActiveActivity | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pendingAction, setPendingAction] = useState<'stop' | 'cancel' | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const requestedExitRef = useRef(false);
  const activeActivityState = useGraphQLActiveActivity(heartVersion + localActiveVersion);
  const isStoppingRoute = pathname === '/activity-stop';

  useEffect(() => {
    if (activeActivityState.status !== 'ready' || activeActivityState.data || pathname !== '/activity-in-progress') {
      if (pathname !== '/activity-in-progress') {
        requestedExitRef.current = false;
      }
      return;
    }

    if (requestedExitRef.current) {
      return;
    }

    requestedExitRef.current = true;
    router.replace('/' as never);
  }, [activeActivityState.data, activeActivityState.status, pathname, router]);

  useEffect(() => {
    if (activeActivityState.status === 'ready') {
      setActiveActivity(activeActivityState.data);
      setActivityError(null);
      setPendingAction(null);
      return;
    }

    if (activeActivityState.status === 'error') {
      setActivityError(activeActivityState.error.message || 'Unable to load the active activity.');
    }
  }, [activeActivityState.data, activeActivityState.error, activeActivityState.status]);

  useEffect(() => {
    if (!activeActivity) {
      return undefined;
    }

    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [activeActivity]);

  const showLiveHeartRate = hasFreshLiveHeartRate(deviceState);
  const liveHeartRate = showLiveHeartRate ? deviceState.liveHeartRate : null;

  useEffect(() => {
    if (!activeActivity || isStoppingRoute) {
      return;
    }

    void startOrUpdateActivityLiveActivity(activeActivity, {
      liveHeartRate,
    }).then((result) => {
      if (!result.ok) {
        setActivityError(result.message);
        return;
      }

      setActivityError(null);
    });
  }, [activeActivity, isStoppingRoute, liveHeartRate]);

  const elapsedMinutes = useMemo(() => {
    if (!activeActivity) {
      return 0;
    }

    return Math.max(0, Math.round((nowMs - activeActivity.start.getTime()) / 60_000));
  }, [activeActivity, nowMs]);

  const handleStop = useCallback(() => {
    if (!activeActivity || pendingAction) {
      return;
    }

    setPendingAction('stop');
    router.push('/activity-stop?source=app-takeover' as never);
  }, [activeActivity, pendingAction, router]);

  const handleCancel = useCallback(async () => {
    if (!activeActivity || pendingAction) {
      return;
    }

    setPendingAction('cancel');
    setActivityError(null);

    try {
      await repository.cancelActiveActivity();
      await endActivityLiveActivities();
      setActiveActivity(null);
      setLocalActiveVersion((current) => current + 1);
      refreshHealthData(ACTIVE_ACTIVITY_REFRESH_SCOPES);
      router.replace('/' as never);
    } catch (error) {
      setActivityError(error instanceof Error ? error.message : 'Unable to cancel this activity right now.');
      setPendingAction(null);
    }
  }, [activeActivity, pendingAction, refreshHealthData, repository, router]);

  if (!activeActivity || isStoppingRoute) {
    return null;
  }

  const latestHeartRateLabel = liveHeartRate === null ? '--' : `${liveHeartRate} bpm`;

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
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.livePill}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>In progress</Text>
            </View>
          </View>

          <View style={styles.hero}>
            <View style={styles.iconBadge}>
              <Ionicons color={colors.heart} name={getManualActivityIconName(activeActivity.activity)} size={34} />
            </View>
            <Text numberOfLines={1} adjustsFontSizeToFit style={styles.title}>
              {activeActivity.activity}
            </Text>
            <Text style={styles.subtitle}>Started {formatClock(activeActivity.start)}</Text>
          </View>

          <View style={styles.metrics}>
            <Metric label="Elapsed" value={formatShortDuration(elapsedMinutes)} />
            <Metric label="Latest HR" value={latestHeartRateLabel} valueColor={colors.heart} />
            <Metric label="Start" value="Now" />
          </View>

          {activityError ? <Text style={styles.error}>{activityError}</Text> : null}

          <View style={styles.actions}>
            <ActionButton
              accentColor={colors.alert}
              disabled={pendingAction !== null}
              label={pendingAction === 'stop' ? 'Stopping...' : 'Stop'}
              loading={pendingAction === 'stop'}
              onPress={handleStop}
            />
            <ActionButton
              accentColor={colors.muted}
              disabled={pendingAction !== null}
              label={pendingAction === 'cancel' ? 'Cancelling...' : 'Cancel'}
              loading={pendingAction === 'cancel'}
              onPress={() => {
                void handleCancel();
              }}
            />
          </View>
        </View>
      </SafeAreaView>
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
  disabled,
  label,
  loading = false,
  onPress,
}: {
  accentColor: string;
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        {
          backgroundColor: `${accentColor}1f`,
          borderColor: `${accentColor}55`,
        },
        pressed && !disabled ? styles.actionButtonPressed : null,
        disabled ? styles.actionButtonDisabled : null,
      ]}>
      {loading ? <ActivityIndicator color={accentColor} size="small" /> : null}
      <Text style={[styles.actionButtonText, { color: accentColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background,
    elevation: 40,
    zIndex: 40,
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
  header: {
    alignItems: 'flex-start',
  },
  livePill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: `${colors.heart}16`,
    borderColor: `${colors.heart}40`,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  liveDot: {
    backgroundColor: colors.heart,
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  liveText: {
    color: colors.heart,
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
    textAlign: 'center',
  },
  metrics: {
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    backgroundColor: 'rgba(255, 255, 255, 0.045)',
    borderColor: 'rgba(255, 255, 255, 0.09)',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
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
  error: {
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
  actionButtonDisabled: {
    opacity: 0.62,
  },
  actionButtonText: {
    fontFamily: typography.bodyBold,
    fontSize: 15,
  },
});
