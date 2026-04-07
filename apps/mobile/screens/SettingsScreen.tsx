import { useEffect, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  listRecentPerformanceDiagnosticRuns,
  runFullPerformanceSweep,
  type PerformanceDiagnosticRun,
  type PerformanceDiagnosticStep,
} from '@/services/performanceDiagnostics';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { brandMark } from '@/constants/assets';
import { brand } from '@/constants/brand';
import { colors, typography } from '@/constants/theme';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import { useOptionalAppDatabase, useOptionalAppDatabaseControls } from '@/providers/AppDatabaseProvider';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import {
  useWearableLiveEvents,
  useWearableSyncActions,
  useWearableSyncProgress,
  useWearableSyncState,
} from '@/providers/WearableSyncProvider';
import { exportAndShareDatabaseSnapshot } from '@/services/databaseExport';
import { disableBackgroundSync } from '@/services/background/backgroundSyncTask';
import {
  describeBatteryStatus,
  describeChargingState,
  describeWearState,
  isBlockingSyncStatus,
  type BackgroundTaskApiStatus,
} from '@/types/device';

function batteryAccent(batteryPercent: number | null) {
  if (batteryPercent === null) {
    return colors.borderStrong;
  }

  if (batteryPercent < 20) {
    return colors.alert;
  }

  if (batteryPercent < 40) {
    return colors.violet;
  }

  if (batteryPercent < 80) {
    return colors.cyan;
  }

  return colors.success;
}

function chargingAccent(chargingStatus: 'charging' | 'not_charging' | null) {
  if (chargingStatus === 'charging') {
    return colors.success;
  }

  if (chargingStatus === 'not_charging') {
    return colors.borderStrong;
  }

  return colors.borderStrong;
}

function wearAccent(bodyStatus: 'on-body' | 'off-body' | null) {
  if (bodyStatus === 'on-body') {
    return colors.cyan;
  }

  if (bodyStatus === 'off-body') {
    return colors.violet;
  }

  return colors.borderStrong;
}

function ActionButton({
  label,
  onPress,
  disabled,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'danger';
}) {
  const accent =
    tone === 'danger'
      ? colors.alert
      : tone === 'secondary'
        ? 'rgba(124, 139, 176, 0.18)'
        : colors.primary;

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: accent,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
      ]}>
      <Text style={[styles.buttonLabel, tone === 'secondary' ? styles.buttonLabelSecondary : null]}>{label}</Text>
    </Pressable>
  );
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeNotificationPermission(permission: 'unknown' | 'granted' | 'provisional' | 'denied') {
  switch (permission) {
    case 'granted':
      return 'Allowed';
    case 'provisional':
      return 'Provisional';
    case 'denied':
      return 'Denied';
    default:
      return 'Unknown';
  }
}

function describeBackgroundResult(result: 'success' | 'skipped' | 'error' | null) {
  switch (result) {
    case 'success':
      return 'Success';
    case 'skipped':
      return 'Skipped';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

function describeBackgroundRunState(
  lastRunStartedAt: string | null,
  lastRunFinishedAt: string | null,
  lastResult: 'success' | 'skipped' | 'error' | null,
) {
  if (lastRunStartedAt && (!lastRunFinishedAt || lastRunStartedAt > lastRunFinishedAt) && lastResult === null) {
    return 'Running';
  }

  return describeBackgroundResult(lastResult);
}

function describeBackgroundApiStatus(status: BackgroundTaskApiStatus) {
  switch (status) {
    case 'available':
      return 'Available';
    case 'restricted':
      return 'Restricted';
    default:
      return 'Unknown';
  }
}

function describePerformanceRunStatus(status: PerformanceDiagnosticRun['status']) {
  switch (status) {
    case 'success':
      return 'Success';
    case 'partial':
      return 'Partial';
    default:
      return 'Error';
  }
}

function performanceRunAccent(status: PerformanceDiagnosticRun['status']) {
  switch (status) {
    case 'success':
      return colors.success;
    case 'partial':
      return colors.violet;
    default:
      return colors.alert;
  }
}

function formatElapsedMs(value: number | null | undefined) {
  return value === null || value === undefined ? '--' : `${value} ms`;
}

function findDiagnosticStep(run: PerformanceDiagnosticRun, key: string) {
  return run.steps.find((step) => step.key === key) ?? null;
}

function formatDiagnosticStepOutcome(step: PerformanceDiagnosticStep) {
  if (step.status === 'success') {
    return formatElapsedMs(step.elapsedMs);
  }

  if (step.status === 'not_applicable') {
    return 'Not applicable';
  }

  const error = step.details.error;
  return typeof error === 'string' && error.length > 0 ? error : 'Error';
}

function summarizeDiagnosticRun(run: PerformanceDiagnosticRun) {
  const dashboardCold = findDiagnosticStep(run, 'dashboard.read.cold');
  const derivedFull = findDiagnosticStep(run, 'derived.full.rebuild');
  const aggregateRebuild = findDiagnosticStep(run, 'aggregates.rebuild');

  return `${run.startedAt}: ${describePerformanceRunStatus(run.status)} in ${formatElapsedMs(run.totalElapsedMs)}. Derived full ${derivedFull ? formatDiagnosticStepOutcome(derivedFull) : '--'}. Dashboard cold ${dashboardCold ? formatDiagnosticStepOutcome(dashboardCold) : '--'}. Aggregates ${aggregateRebuild ? formatDiagnosticStepOutcome(aggregateRebuild) : '--'}.`;
}

export function SettingsScreen() {
  const router = useRouter();
  const db = useOptionalAppDatabase();
  const databaseControls = useOptionalAppDatabaseControls();
  const repository = useHealthRepository();
  const refreshHealthData = useRefreshHealthData();
  const { backgroundSyncDiagnostics, backgroundSyncState, deviceState } = useWearableSyncState();
  const { liveEvents } = useWearableLiveEvents();
  const { progress } = useWearableSyncProgress();
  const { forgetDevice, syncSelected, triggerBackgroundSyncTest, restartDevice } = useWearableSyncActions();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const [exportState, setExportState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Create a portable local data snapshot and share it straight from the phone.',
  });
  const [performanceSweepState, setPerformanceSweepState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Run one local sweep that records warm and cache-cold screen reads, aggregate rebuilds, and snapshot rebuilds.',
  });
  const [performanceRuns, setPerformanceRuns] = useState<PerformanceDiagnosticRun[]>([]);
  const [performanceHistoryState, setPerformanceHistoryState] = useState<{
    status: 'idle' | 'loading' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'No performance sweep has been recorded on this phone yet.',
  });
  const [clearDataState, setClearDataState] = useState<{
    status: 'idle' | 'running' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Remove local wearable history, pairing state, diagnostics, and seeded data from this phone.',
  });
  const deviceBusy = isBlockingSyncStatus(progress.status);
  const batteryChipAccent = batteryAccent(deviceState.batteryPercent);
  const chargingChipAccent = chargingAccent(deviceState.chargingStatus);
  const wearChipAccent = wearAccent(deviceState.bodyStatus);
  const exportDisabled = deviceBusy || exportState.status === 'running' || !db;
  const clearDataDisabled =
    progress.status === 'scanning' ||
    deviceBusy ||
    clearDataState.status === 'running' ||
    !databaseControls;
  const performanceSweepDisabled =
    progress.status === 'scanning' || deviceBusy || performanceSweepState.status === 'running' || !db;
  const backgroundRunState = describeBackgroundRunState(
    backgroundSyncState.lastRunStartedAt,
    backgroundSyncState.lastRunFinishedAt,
    backgroundSyncState.lastResult,
  );
  const latestPerformanceRun = performanceRuns[0] ?? null;

  useEffect(() => {
    let cancelled = false;

    if (!db) {
      setPerformanceRuns([]);
      setPerformanceHistoryState({
        status: 'idle',
        message: 'Performance diagnostics needs the local SQLite provider in this build.',
      });
      return;
    }

    setPerformanceHistoryState((current) => ({
      status: 'loading',
      message: current.message,
    }));

    void listRecentPerformanceDiagnosticRuns(db, 5)
      .then((runs) => {
        if (cancelled) {
          return;
        }

        setPerformanceRuns(runs);
        setPerformanceHistoryState({
          status: 'idle',
          message:
            runs.length === 0
              ? 'No performance sweep has been recorded on this phone yet.'
              : 'Recent sweeps are stored locally on this phone for comparison.',
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setPerformanceHistoryState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load performance sweep history.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [db]);

  async function refreshPerformanceRuns() {
    if (!db) {
      setPerformanceRuns([]);
      return [];
    }

    const runs = await listRecentPerformanceDiagnosticRuns(db, 5);
    setPerformanceRuns(runs);
    setPerformanceHistoryState({
      status: 'idle',
      message:
        runs.length === 0
          ? 'No performance sweep has been recorded on this phone yet.'
          : 'Recent sweeps are stored locally on this phone for comparison.',
    });
    return runs;
  }

  async function handleExportDatabase() {
    if (!db) {
      setExportState({
        status: 'error',
        message: 'The local database is not available in this build.',
      });
      return;
    }

    setExportState({
      status: 'running',
      message: 'Preparing a fresh local data snapshot...',
    });

    try {
      const result = await exportAndShareDatabaseSnapshot(db);
      setExportState({
        status: 'success',
        message: `Prepared a local data snapshot (${formatBytes(result.sizeBytes)}). Share it from this phone if you want help inspecting the raw sync history.`,
      });
    } catch (error) {
      setExportState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to export the local database.',
      });
    }
  }

  async function handleRunFullPerformanceSweep() {
    if (!db) {
      setPerformanceSweepState({
        status: 'error',
        message: 'Performance diagnostics needs the local SQLite provider in this build.',
      });
      return;
    }

    setPerformanceSweepState({
      status: 'running',
      message: 'Running the full local performance sweep...',
    });

    try {
      const run = await runFullPerformanceSweep({
        db,
        repository,
        backgroundSyncState,
      });
      await refreshPerformanceRuns();
      refreshHealthData(['dashboard', 'sleep', 'heart', 'wellness', 'trends']);

      const derivedFull = findDiagnosticStep(run, 'derived.full.rebuild');
      const dashboardCold = findDiagnosticStep(run, 'dashboard.read.cold');
      const aggregateRebuild = findDiagnosticStep(run, 'aggregates.rebuild');
      setPerformanceSweepState({
        status: 'success',
        message: `${describePerformanceRunStatus(run.status)} sweep recorded in ${formatElapsedMs(run.totalElapsedMs)}. Derived full ${derivedFull ? formatDiagnosticStepOutcome(derivedFull) : '--'}. Dashboard cold ${dashboardCold ? formatDiagnosticStepOutcome(dashboardCold) : '--'}. Aggregates ${aggregateRebuild ? formatDiagnosticStepOutcome(aggregateRebuild) : '--'}.`,
      });
    } catch (error) {
      await refreshPerformanceRuns().catch(() => []);
      setPerformanceSweepState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to run the full performance sweep.',
      });
    }
  }

  async function confirmClearAllData() {
    if (!databaseControls) {
      setClearDataState({
        status: 'error',
        message: 'Local data reset is unavailable in this build.',
      });
      return;
    }

    setClearDataState({
      status: 'running',
      message: 'Removing all local data from this phone...',
    });

    try {
      if (deviceState.id) {
        await forgetDevice();
      } else {
        await disableBackgroundSync();
      }
      await databaseControls.clearAllLocalData();
      router.replace('/');
    } catch (error) {
      setClearDataState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to remove local data from this phone.',
      });
    }
  }

  function handleClearAllData() {
    Alert.alert(
      'Remove all data?',
      'This clears local wearable history, paired-device state, diagnostics, and any loaded seeded data from this phone. This cannot be undone.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void confirmClearAllData();
          },
        },
      ],
    );
  }

  return (
    <ScreenShell
      headerIcon="settings"
      headerSettingsActive
      headerTitle="Settings"
      onRefresh={onRefresh}
      refreshing={refreshing}>
      <View>
        <Text style={styles.subtitle}>Open wearable insights with local-only sync and the offline data store that powers every tab.</Text>
      </View>

      <GlassCard accentColor={colors.primary}>
        <View style={styles.profileRow}>
          <View style={styles.profileMarkWrap}>
            <Image resizeMode="contain" source={brandMark} style={styles.profileIcon} />
          </View>
          <View style={styles.profileText}>
            <Text style={styles.profileEyebrow}>{brand.promise}</Text>
            <Text style={styles.profileTitle}>{brand.appName}</Text>
            <Text style={styles.profileSubtitle}>{brand.tagline}</Text>
          </View>
        </View>
        <Text style={styles.profileManifesto}>{brand.manifesto}</Text>
      </GlassCard>

      <GlassCard accentColor={colors.cyan}>
        <SectionHeader title="Appearance" trailing="Locked for v1" />
        <View style={styles.settingRow}>
          <View>
            <Text style={styles.settingTitle}>Dark theme</Text>
            <Text style={styles.settingSubtitle}>This build stays in Unstrap's neon dark mode.</Text>
          </View>
          <Switch disabled trackColor={{ false: colors.border, true: colors.primary }} value />
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.success}>
        <SectionHeader title="Selected Wearable" trailing={deviceState.id ? 'Ready' : 'None'} />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>{deviceState.name ?? 'No wearable selected yet'}</Text>
            <Text style={styles.settingSubtitle}>
              {deviceState.id ?? 'Pairing opens automatically when no wearable is selected on this phone.'}
            </Text>
          </View>

          <View style={styles.chipWrap}>
            <StatChip
              accent={batteryChipAccent}
              label="Battery"
              value={deviceState.batteryPercent === null ? '--' : `${deviceState.batteryPercent}%`}
            />
            <StatChip
              accent={batteryChipAccent}
              label="Status"
              value={describeBatteryStatus(deviceState.batteryPercent)}
            />
            <StatChip
              accent={chargingChipAccent}
              label="Charge"
              value={describeChargingState(deviceState.chargingStatus)}
            />
            <StatChip
              accent={wearChipAccent}
              label="Wear"
              value={describeWearState(deviceState.bodyStatus)}
            />
            <StatChip accent={colors.borderStrong} label="Last sync" value={deviceState.lastSyncedAt ?? 'Not yet'} />
            <StatChip accent={colors.borderStrong} label="Firmware" value={deviceState.firmware ?? '--'} />
          </View>

          {deviceState.syncError ? <Text style={styles.errorText}>{deviceState.syncError}</Text> : null}

          <View style={styles.buttonRow}>
            {!deviceState.id ? (
              <ActionButton
                label="Open pairing"
                onPress={() => {
                  router.replace('/');
                }}
                tone="secondary"
              />
            ) : null}
            <ActionButton
              label={deviceBusy ? 'Syncing...' : 'Sync now'}
              onPress={() => {
                void syncSelected();
              }}
              disabled={!deviceState.id || progress.status === 'scanning' || deviceBusy}
            />
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label="Live events"
              onPress={() => {
                router.push('/live-events');
              }}
              tone="secondary"
            />
            <ActionButton
              label="Restart wearable"
              onPress={() => {
                void restartDevice();
              }}
              disabled={!deviceState.id || progress.status === 'scanning' || deviceBusy}
              tone="secondary"
            />
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label="Forget wearable"
              onPress={() => {
                void forgetDevice();
              }}
              disabled={!deviceState.id}
              tone="danger"
            />
          </View>

          <Text style={styles.settingSubtitle}>
            Session log stores the latest {liveEvents.length} meaningful wearable events seen since this app session started.
          </Text>
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.aqua}>
        <SectionHeader title="Local Sync Status" trailing={progress.status} />
        <Text style={styles.roadmapText}>{progress.message}</Text>
      </GlassCard>

      <GlassCard accentColor={colors.success}>
        <SectionHeader
          title="Performance Diagnostics"
          trailing={db ? (latestPerformanceRun ? describePerformanceRunStatus(latestPerformanceRun.status) : 'Ready') : 'Unavailable'}
        />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>Run full performance sweep</Text>
            <Text style={styles.settingSubtitle}>
              Measure a full derived rebuild, warm and cache-cold screen reads, aggregate rebuilds, and dashboard snapshot rebuilds in one pass. The latest recorded sync summary is attached when available.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={performanceSweepState.status === 'running' ? 'Running Perf Sweep...' : 'Run Full Perf Sweep'}
              onPress={() => {
                void handleRunFullPerformanceSweep();
              }}
              disabled={performanceSweepDisabled}
              tone="secondary"
            />
          </View>

          <Text
            style={[
              styles.roadmapText,
              performanceSweepState.status === 'error' ? styles.errorText : null,
            ]}>
            {db ? performanceSweepState.message : 'Performance diagnostics needs the local SQLite provider in this build.'}
          </Text>

          {latestPerformanceRun ? (
            <>
              <View>
                <Text style={styles.settingTitle}>Latest sweep</Text>
                <Text style={styles.settingSubtitle}>{latestPerformanceRun.startedAt}</Text>
              </View>

              <View style={styles.chipWrap}>
                <StatChip
                  accent={performanceRunAccent(latestPerformanceRun.status)}
                  label="Status"
                  value={describePerformanceRunStatus(latestPerformanceRun.status)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Total"
                  value={formatElapsedMs(latestPerformanceRun.totalElapsedMs)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Heart rows"
                  value={`${latestPerformanceRun.heartRowCount}`}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Derived full"
                  value={formatDiagnosticStepOutcome(
                    findDiagnosticStep(latestPerformanceRun, 'derived.full.rebuild') ?? {
                      key: 'missing',
                      label: 'Missing',
                      status: 'not_applicable',
                      elapsedMs: null,
                      details: {},
                    },
                  )}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Dashboard cold"
                  value={formatDiagnosticStepOutcome(
                    findDiagnosticStep(latestPerformanceRun, 'dashboard.read.cold') ?? {
                      key: 'missing',
                      label: 'Missing',
                      status: 'not_applicable',
                      elapsedMs: null,
                      details: {},
                    },
                  )}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Aggregates"
                  value={formatDiagnosticStepOutcome(
                    findDiagnosticStep(latestPerformanceRun, 'aggregates.rebuild') ?? {
                      key: 'missing',
                      label: 'Missing',
                      status: 'not_applicable',
                      elapsedMs: null,
                      details: {},
                    },
                  )}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Last sync"
                  value={latestPerformanceRun.lastSyncResult ? describeBackgroundRunState(latestPerformanceRun.lastSyncStartedAt, latestPerformanceRun.lastSyncFinishedAt, latestPerformanceRun.lastSyncResult) : 'Unknown'}
                />
              </View>

              {latestPerformanceRun.steps.map((step) => (
                <Text
                  key={`${latestPerformanceRun.id}-${step.key}`}
                  style={[
                    styles.roadmapText,
                    step.status === 'error' ? styles.errorText : null,
                  ]}>
                  {step.label}: {formatDiagnosticStepOutcome(step)}
                </Text>
              ))}
            </>
          ) : null}

          <View>
            <Text style={styles.settingTitle}>Recent sweeps</Text>
            <Text style={styles.settingSubtitle}>{performanceHistoryState.message}</Text>
          </View>

          {performanceRuns.length === 0 ? (
            <Text
              style={[
                styles.roadmapText,
                performanceHistoryState.status === 'error' ? styles.errorText : null,
              ]}>
              {performanceHistoryState.message}
            </Text>
          ) : (
            performanceRuns.map((run) => (
              <Text key={run.id} style={styles.roadmapText}>
                {summarizeDiagnosticRun(run)}
              </Text>
            ))
          )}
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Background Sync" trailing={deviceState.id ? 'Auto after pairing' : 'Inactive'} />
        <View style={styles.settingColumn}>
          <View style={styles.chipWrap}>
            <StatChip
              accent={backgroundSyncDiagnostics.apiStatus === 'available' ? colors.success : colors.borderStrong}
              label="API"
              value={describeBackgroundApiStatus(backgroundSyncDiagnostics.apiStatus)}
            />
            <StatChip
              accent={backgroundSyncDiagnostics.isTaskRegistered ? colors.success : colors.borderStrong}
              label="Registered"
              value={backgroundSyncDiagnostics.isTaskRegistered ? 'Yes' : 'No'}
            />
            <StatChip
              accent={colors.borderStrong}
              label="Min interval"
              value={`${backgroundSyncDiagnostics.minimumIntervalMinutes}m`}
            />
            <StatChip
              accent={deviceState.id ? colors.success : colors.borderStrong}
              label="Status"
              value={deviceState.id ? 'Enabled' : 'No wearable'}
            />
            <StatChip
              accent={colors.borderStrong}
              label="Alerts"
              value={describeNotificationPermission(backgroundSyncState.notificationPermission)}
            />
            <StatChip
              accent={colors.borderStrong}
              label="Last started"
              value={backgroundSyncState.lastRunStartedAt ?? 'Not yet'}
            />
            <StatChip
              accent={colors.borderStrong}
              label="Last finished"
              value={backgroundSyncState.lastRunFinishedAt ?? 'Not yet'}
            />
            <StatChip
              accent={
                backgroundRunState === 'Error'
                  ? colors.alert
                  : backgroundRunState === 'Success'
                    ? colors.success
                    : colors.borderStrong
              }
              label="Last result"
              value={backgroundRunState}
            />
          </View>

          <Text style={styles.roadmapText}>
            Background sync is best effort on iPhone while the app stays in the background or suspended. iOS chooses the actual run time, and short intervals are often delayed substantially.
          </Text>
          <Text style={styles.roadmapText}>
            If you force-quit the app from the app switcher, iOS stops relaunching it for this work until you open it again.
          </Text>
          <Text style={styles.roadmapText}>
            Keep the official wearable app closed while Unstrap owns the strap. Two apps syncing the same device can race each other and create gaps.
          </Text>
          {__DEV__ ? (
            <>
              <View style={styles.buttonRow}>
                <ActionButton
                  label="Trigger test run"
                  onPress={() => {
                    void triggerBackgroundSyncTest();
                  }}
                  disabled={!deviceState.id || progress.status === 'scanning' || deviceBusy}
                  tone="secondary"
                />
              </View>
              <Text style={styles.settingSubtitle}>
                Debug only. This uses Expo's test hook to run the background worker immediately on a physical development build.
              </Text>
            </>
          ) : null}
          {backgroundSyncState.lastError ? <Text style={styles.errorText}>{backgroundSyncState.lastError}</Text> : null}
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.primary}>
        <SectionHeader title="Export for Analysis" trailing="SQLite snapshot" />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>Unlocked data snapshot</Text>
            <Text style={styles.settingSubtitle}>
              Generate a shareable SQLite snapshot if you want help inspecting what this phone has already synced.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={exportState.status === 'running' ? 'Exporting...' : 'Export Snapshot'}
              onPress={() => {
                void handleExportDatabase();
              }}
              disabled={exportDisabled}
            />
          </View>

          <Text
            style={[
              styles.roadmapText,
              exportState.status === 'error' ? styles.errorText : null,
            ]}>
            {db ? exportState.message : 'Database export is only available when the app is running with the local SQLite provider.'}
          </Text>
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.alert}>
        <SectionHeader title="Local Data" trailing="Destructive" />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>Remove all data from this phone</Text>
            <Text style={styles.settingSubtitle}>
              Clear all local wearable history, pairing state, diagnostics, and seeded data. The app will return to pairing after the wipe.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={clearDataState.status === 'running' ? 'Removing...' : 'Remove all data'}
              onPress={handleClearAllData}
              disabled={clearDataDisabled}
              tone="danger"
            />
          </View>

          <Text
            style={[
              styles.roadmapText,
              clearDataState.status === 'error' ? styles.errorText : null,
            ]}>
            {clearDataState.message}
          </Text>
        </View>
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
  profileRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  profileMarkWrap: {
    alignItems: 'center',
    backgroundColor: 'rgba(10, 21, 28, 0.92)',
    borderColor: colors.border,
    borderRadius: 24,
    borderWidth: 1,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  profileIcon: {
    height: 56,
    width: 56,
  },
  profileText: {
    flex: 1,
  },
  profileEyebrow: {
    color: colors.primaryBright,
    fontFamily: typography.bodyBold,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  profileTitle: {
    color: colors.text,
    fontFamily: typography.heading,
    fontSize: 24,
  },
  profileSubtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 13,
    marginTop: 4,
  },
  profileManifesto: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 14,
    lineHeight: 22,
    marginTop: 16,
  },
  settingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  settingColumn: {
    gap: 14,
  },
  settingTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  settingSubtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    alignItems: 'center',
    borderRadius: 14,
    minWidth: 124,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  buttonLabel: {
    color: colors.background,
    fontFamily: typography.bodyBold,
    fontSize: 13,
  },
  buttonLabelSecondary: {
    color: colors.text,
  },
  errorText: {
    color: colors.alert,
    fontFamily: typography.body,
    fontSize: 13,
    lineHeight: 20,
  },
  roadmapText: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 24,
  },
  deviceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  deviceText: {
    flex: 1,
  },
  divider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
});
