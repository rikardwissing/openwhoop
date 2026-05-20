import { useEffect, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  listRecentPerformanceDiagnosticRuns,
  runFullPerformanceSweep,
  type PerformanceDiagnosticRun,
  type PerformanceDiagnosticStep,
} from '@/services/performanceDiagnostics';
import { writeLocalMetricsToAppleHealth } from '@/services/appleHealthExport';
import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { brandMark } from '@/constants/assets';
import { brand } from '@/constants/brand';
import { colors, typography } from '@/constants/theme';
import { inspectDatabaseMaintenance, runDatabaseMaintenance } from '@/db/maintenance';
import { useOptionalAppDatabase, useOptionalAppDatabaseControls } from '@/providers/AppDatabaseProvider';
import { useHealthRepository, useRefreshHealthData } from '@/providers/HealthDataProvider';
import {
  useWearableLiveEvents,
  useWearableSyncActions,
  useWearableSyncProgress,
  useWearableSyncState,
} from '@/providers/WearableSyncProvider';
import { exportAndShareDatabaseSnapshot } from '@/services/databaseExport';
import {
  BACKGROUND_DEVICE_SYNC_INTERVAL_MINUTES,
  BACKGROUND_DEVICE_SYNC_TIME_BUDGET_MS,
  isBackgroundDeviceSyncTaskRegisteredAsync,
  registerBackgroundDeviceSyncTaskAsync,
} from '@/services/background/backgroundDeviceSyncTask';
import {
  describeBatteryStatus,
  describeChargingState,
  describeWearState,
  isBlockingSyncStatus,
  type SyncImportPerformanceSummary,
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

function describeSyncResult(result: 'success' | 'skipped' | 'error' | null) {
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

function describeSyncImportBottleneck(bottleneck: SyncImportPerformanceSummary['suspectedBottleneck']) {
  switch (bottleneck) {
    case 'ble':
      return 'BLE';
    case 'db':
      return 'DB';
    case 'mixed':
      return 'Mixed';
    default:
      return 'Unknown';
  }
}

function syncImportStatusAccent(status: SyncImportPerformanceSummary['status']) {
  switch (status) {
    case 'success':
      return colors.success;
    case 'error':
      return colors.alert;
    default:
      return colors.borderStrong;
  }
}

function syncImportBottleneckAccent(bottleneck: SyncImportPerformanceSummary['suspectedBottleneck']) {
  switch (bottleneck) {
    case 'ble':
      return colors.cyan;
    case 'db':
      return colors.violet;
    case 'mixed':
      return colors.primary;
    default:
      return colors.borderStrong;
  }
}

function formatCompactDurationMs(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return '--';
  }

  if (value >= 60_000) {
    return `${(value / 60_000).toFixed(1)} min`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)} s`;
  }

  return `${Math.round(value)} ms`;
}

function formatInteger(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return '--';
  }

  return value.toLocaleString();
}

function formatRowsPerSecond(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return '--';
  }

  return `${value.toLocaleString()}/s`;
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
  const { backgroundSyncState, deviceState } = useWearableSyncState();
  const { liveEvents } = useWearableLiveEvents();
  const { progress } = useWearableSyncProgress();
  const { forgetDevice, runBackgroundSync, restartDevice } = useWearableSyncActions();
  const [exportState, setExportState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Create a portable local data snapshot and share it straight from the phone.',
  });
  const [appleHealthExportState, setAppleHealthExportState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error' | 'unavailable' | 'permission_denied';
    message: string;
  }>({
    status: 'idle',
    message: 'Grant Apple Health write access and export queued local metrics. Future syncs keep Health updated automatically.',
  });
  const [performanceSweepState, setPerformanceSweepState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Run one local sweep that records repeated screen reads, aggregate rebuilds, and snapshot rebuilds.',
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
  const [maintenanceState, setMaintenanceState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Run manual cleanup to drop the legacy IMU column if needed and vacuum free SQLite pages.',
  });
  const [activityRescanState, setActivityRescanState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Delete pending detected activities and rerun local activity detection across the history already on this phone.',
  });
  const [backgroundDeviceSyncRegistrationState, setBackgroundDeviceSyncRegistrationState] = useState<{
    message: string;
    status: 'checking' | 'registered' | 'not_registered' | 'error';
  }>({
    status: 'checking',
    message: 'Checking device sync task registration...',
  });
  const [backgroundDeviceSyncRunState, setBackgroundDeviceSyncRunState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Run the bounded background sync path immediately for the selected wearable.',
  });
  const deviceBusy = isBlockingSyncStatus(progress.status);
  const maintenanceBusy = maintenanceState.status === 'running';
  const activityRescanBusy = activityRescanState.status === 'running';
  const backgroundDeviceSyncBusy = backgroundDeviceSyncRunState.status === 'running';
  const batteryChipAccent = batteryAccent(deviceState.batteryPercent);
  const chargingChipAccent = chargingAccent(deviceState.chargingStatus);
  const wearChipAccent = wearAccent(deviceState.bodyStatus);
  const exportDisabled = deviceBusy || maintenanceBusy || activityRescanBusy || exportState.status === 'running' || !db;
  const clearDataDisabled =
    progress.status === 'scanning' ||
    deviceBusy ||
    maintenanceBusy ||
    activityRescanBusy ||
    clearDataState.status === 'running' ||
    !databaseControls;
  const performanceSweepDisabled =
    progress.status === 'scanning' || deviceBusy || maintenanceBusy || activityRescanBusy || performanceSweepState.status === 'running' || !db;
  const maintenanceDisabled =
    progress.status === 'scanning' || deviceBusy || exportState.status === 'running' || performanceSweepState.status === 'running' || clearDataState.status === 'running' || maintenanceBusy || activityRescanBusy || !db;
  const activityRescanDisabled =
    progress.status === 'scanning' ||
    deviceBusy ||
    exportState.status === 'running' ||
    performanceSweepState.status === 'running' ||
    clearDataState.status === 'running' ||
    maintenanceBusy ||
    activityRescanBusy;
  const backgroundDeviceSyncDisabled =
    !deviceState.id ||
    progress.status === 'scanning' ||
    deviceBusy ||
    exportState.status === 'running' ||
    performanceSweepState.status === 'running' ||
    clearDataState.status === 'running' ||
    maintenanceBusy ||
    activityRescanBusy ||
    backgroundDeviceSyncBusy;
  const latestSyncImportSummary = backgroundSyncState.lastSyncImportSummary;
  const latestPerformanceRun = performanceRuns[0] ?? null;
  const appleHealthExportDisabled =
    !db ||
    progress.status === 'scanning' ||
    deviceBusy ||
    maintenanceBusy ||
    activityRescanBusy ||
    exportState.status === 'running' ||
    performanceSweepState.status === 'running' ||
    clearDataState.status === 'running' ||
    appleHealthExportState.status === 'running';
  async function refreshBackgroundDeviceSyncRegistrationState() {
    setBackgroundDeviceSyncRegistrationState({
      status: 'checking',
      message: 'Checking device sync task registration...',
    });

    try {
      if (deviceState.id) {
        await registerBackgroundDeviceSyncTaskAsync({
          requestNotificationPermission: true,
        });
      }

      const isRegistered = await isBackgroundDeviceSyncTaskRegisteredAsync();
      const syncWindowMinutes = Math.round(BACKGROUND_DEVICE_SYNC_TIME_BUDGET_MS / 60_000);

      setBackgroundDeviceSyncRegistrationState({
        status: isRegistered ? 'registered' : 'not_registered',
        message: isRegistered
          ? `Registered with Expo BackgroundTask, minimum interval ${BACKGROUND_DEVICE_SYNC_INTERVAL_MINUTES} minutes, ${syncWindowMinutes} minute safe sync window.`
          : deviceState.id
            ? 'Not registered yet. Keep the app open briefly so Expo can accept the background task registration.'
            : 'Not registered yet. Pair a wearable to register device background sync automatically.',
      });
    } catch (error) {
      setBackgroundDeviceSyncRegistrationState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to check device sync task registration.',
      });
    }
  }

  useEffect(() => {
    void refreshBackgroundDeviceSyncRegistrationState();
  }, [deviceState.id]);

  async function handleRunBackgroundDeviceSyncNow() {
    setBackgroundDeviceSyncRunState({
      status: 'running',
      message: 'Running bounded background sync now...',
    });

    try {
      const result = await runBackgroundSync({ showOverlay: false });
      const notificationMessage = result.notificationPermissionGranted
        ? 'Local notifications are enabled for this run.'
        : 'Notification permission is not granted, so no local sync or detection notification was sent.';
      const detectionNotificationCount =
        result.detectionNotifications.activityReadyCount +
        result.detectionNotifications.sleepReadyCount +
        result.detectionNotifications.sleepStartedCount;
      const detectionMessage =
        detectionNotificationCount > 0
          ? `Sent ${detectionNotificationCount} detection ${detectionNotificationCount === 1 ? 'notification' : 'notifications'}.`
          : result.processedDerivedRefresh
            ? 'Checked derived sleep and activity detection.'
            : '';

      if (result.importedReadings > 0 || result.processedDerivedRefresh) {
        refreshHealthData(['dashboard', 'sleep', 'heart', 'wellness', 'trends', 'derived']);
      }

      setBackgroundDeviceSyncRunState({
        status: result.status === 'failed' ? 'error' : 'success',
        message: `${result.message} ${notificationMessage}${detectionMessage ? ` ${detectionMessage}` : ''}`,
      });
    } catch (error) {
      setBackgroundDeviceSyncRunState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to run background sync now.',
      });
    } finally {
      await refreshBackgroundDeviceSyncRegistrationState();
    }
  }

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

  async function handleExportAppleHealth() {
    if (!db) {
      setAppleHealthExportState({
        status: 'error',
        message: 'Apple Health export needs the local SQLite provider in this build.',
      });
      return;
    }

    setAppleHealthExportState({
      status: 'running',
      message: 'Requesting Apple Health access and writing local metrics...',
    });

    try {
      const result = await writeLocalMetricsToAppleHealth(db);
      setAppleHealthExportState({
        status: result.status === 'success' ? 'success' : result.status,
        message: result.message,
      });
    } catch (error) {
      setAppleHealthExportState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to write local metrics to Apple Health.',
      });
    }
  }

  async function handleRunDatabaseMaintenance() {
    if (!db) {
      setMaintenanceState({
        status: 'error',
        message: 'Local database maintenance needs the local SQLite provider in this build.',
      });
      return;
    }

    setMaintenanceState({
      status: 'running',
      message: 'Inspecting the local database for cleanup work...',
    });

    try {
      const inspection = await inspectDatabaseMaintenance(db);

      if (!inspection.needsMaintenance) {
        setMaintenanceState({
          status: 'success',
          message: `No local database cleanup is needed right now. Current file size is ${formatBytes(inspection.sizeBytes)}.`,
        });
        return;
      }

      setMaintenanceState({
        status: 'running',
        message: 'Running local database maintenance...',
      });

      const result = await runDatabaseMaintenance(db);
      const actions: string[] = [];

      if (result.rewroteHeartRateSchema) {
        actions.push('rewrote the heart-rate storage schema');
      }

      if (result.vacuumed) {
        actions.push(
          result.reclaimedBytes > 0
            ? `reclaimed ${formatBytes(result.reclaimedBytes)}`
            : 'vacuumed free pages',
        );
      }

      setMaintenanceState({
        status: 'success',
        message:
          actions.length > 0
            ? `Local database maintenance complete: ${actions.join(' and ')}. Current file size is ${formatBytes(result.sizeBytesAfter)}.`
            : `Local database maintenance finished. Current file size is ${formatBytes(result.sizeBytesAfter)}.`,
      });
    } catch (error) {
      setMaintenanceState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to run local database maintenance.',
      });
    }
  }

  async function handleRescanActivities() {
    setActivityRescanState({
      status: 'running',
      message: 'Removing unconfirmed detected activities and rescanning the local activity history...',
    });

    try {
      const result = await repository.rescanActivities();
      refreshHealthData(['dashboard', 'sleep', 'heart', 'wellness', 'trends', 'derived']);
      const noun = result.removedUnconfirmedActivities === 1 ? 'activity' : 'activities';

      setActivityRescanState({
        status: 'success',
        message:
          result.removedUnconfirmedActivities > 0
            ? `Removed ${result.removedUnconfirmedActivities} unconfirmed detected ${noun} and rescanned local activity history.`
            : 'No unconfirmed detected activities were found. Rescanned local activity history anyway.',
      });
    } catch (error) {
      setActivityRescanState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to rescan local activity history.',
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
      headerTitle="Settings">
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

          {!deviceState.id ? (
            <View style={styles.buttonRow}>
              <ActionButton
                label="Open pairing"
                onPress={() => {
                  router.replace('/');
                }}
                tone="secondary"
              />
            </View>
          ) : null}

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

      <GlassCard accentColor={colors.cyan}>
        <SectionHeader
          title="Apple Health"
          trailing={
            appleHealthExportState.status === 'success'
              ? 'Synced'
              : appleHealthExportState.status === 'running'
                ? 'Writing'
                : 'Optional'
          }
        />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>Write local metrics</Text>
            <Text style={styles.settingSubtitle}>
              After permission is granted, foreground and background syncs export supported local wearable metrics without reading Apple Health data back into Unstrap.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={appleHealthExportState.status === 'running' ? 'Writing Health...' : 'Write to Apple Health'}
              onPress={() => {
                void handleExportAppleHealth();
              }}
              disabled={appleHealthExportDisabled}
              tone="secondary"
            />
          </View>

          <Text
            style={[
              styles.roadmapText,
              appleHealthExportState.status === 'error' ||
              appleHealthExportState.status === 'unavailable' ||
              appleHealthExportState.status === 'permission_denied'
                ? styles.errorText
                : null,
              appleHealthExportState.status === 'success' ? styles.successText : null,
            ]}>
            {db ? appleHealthExportState.message : 'Apple Health export is only available when local SQLite data is active.'}
          </Text>
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader
          title="Background Sync"
          trailing={
            backgroundDeviceSyncRegistrationState.status === 'registered'
              ? 'Registered'
              : 'Expo'
          }
        />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>Device sync task</Text>
            <Text style={styles.settingSubtitle}>
              Syncs the selected wearable within a bounded background window and sends local start, completion, and failure notifications.
            </Text>
            <Text
              style={[
                styles.settingSubtitle,
                backgroundDeviceSyncRegistrationState.status === 'registered' ? styles.successText : null,
                backgroundDeviceSyncRegistrationState.status === 'error' ? styles.errorText : null,
              ]}>
              Status: {backgroundDeviceSyncRegistrationState.message}
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={backgroundDeviceSyncBusy ? 'Running Sync...' : 'Run Background Sync'}
              onPress={() => {
                void handleRunBackgroundDeviceSyncNow();
              }}
              disabled={backgroundDeviceSyncDisabled}
              tone="secondary"
            />
          </View>

          <Text
            style={[
              styles.roadmapText,
              backgroundDeviceSyncRunState.status === 'error' ? styles.errorText : null,
            ]}>
            {backgroundDeviceSyncRunState.message}
          </Text>
        </View>
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
              Measure a full derived rebuild, repeated today/history reads, and aggregate rebuilds in one pass.
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
            <Text style={styles.settingTitle}>Latest Import Profile</Text>
            <Text style={styles.settingSubtitle}>
              Stores the last timing snapshot recorded on this phone from the most recent wearable import.
            </Text>
          </View>

          {latestSyncImportSummary ? (
            <>
              <View style={styles.chipWrap}>
                <StatChip
                  accent={syncImportStatusAccent(latestSyncImportSummary.status)}
                  label="Outcome"
                  value={describeSyncResult(latestSyncImportSummary.status)}
                />
                <StatChip
                  accent={syncImportBottleneckAccent(latestSyncImportSummary.suspectedBottleneck)}
                  label="Bottleneck"
                  value={describeSyncImportBottleneck(latestSyncImportSummary.suspectedBottleneck)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Total"
                  value={formatCompactDurationMs(latestSyncImportSummary.totalMs)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Receive"
                  value={formatCompactDurationMs(latestSyncImportSummary.historyReceiveMs)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="DB flush"
                  value={formatCompactDurationMs(latestSyncImportSummary.dbFlushMsTotal)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="ACK wait"
                  value={formatCompactDurationMs(latestSyncImportSummary.ackWaitMsTotal)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Received"
                  value={formatInteger(latestSyncImportSummary.importedRows)}
                />
                <StatChip
                  accent={colors.borderStrong}
                  label="Persisted"
                  value={formatInteger(latestSyncImportSummary.persistedRows)}
                />
              </View>

              <Text style={styles.roadmapText}>
                {`Recorded ${latestSyncImportSummary.capturedAt}. Connect ${formatCompactDurationMs(latestSyncImportSummary.connectMs)}. Persisted ${formatInteger(latestSyncImportSummary.persistedRows)} eligible rows across ${formatInteger(latestSyncImportSummary.flushCount)} flushes with a max pending buffer of ${formatInteger(latestSyncImportSummary.maxPendingRows)} rows.`}
              </Text>
              <Text style={styles.roadmapText}>
                {`Receive throughput ${formatRowsPerSecond(latestSyncImportSummary.rowsPerSecReceive)}. DB throughput ${formatRowsPerSecond(latestSyncImportSummary.rowsPerSecPersist)}.`}
              </Text>
              {latestSyncImportSummary.error ? (
                <Text style={styles.errorText}>{latestSyncImportSummary.error}</Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.roadmapText}>No import profile has been recorded on this phone yet.</Text>
          )}

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

      <GlassCard accentColor={colors.primary}>
        <SectionHeader title="Database Maintenance" trailing="Manual" />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>Rescan local activity detection</Text>
            <Text style={styles.settingSubtitle}>
              Deletes unconfirmed detected activities first, then reruns activity detection against the history already stored on this phone. Manual and reviewed activities stay in place.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={activityRescanState.status === 'running' ? 'Rescanning Activities...' : 'Rescan Activities'}
              onPress={() => {
                void handleRescanActivities();
              }}
              disabled={activityRescanDisabled}
              tone="secondary"
            />
          </View>

          <Text
            style={[
              styles.roadmapText,
              activityRescanState.status === 'error' ? styles.errorText : null,
            ]}>
            {activityRescanState.message}
          </Text>

          <View>
            <Text style={styles.settingTitle}>Compact and repair local database</Text>
            <Text style={styles.settingSubtitle}>
              Runs the legacy IMU cleanup if it is still needed and vacuums free SQLite pages so the on-device database can shrink.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={maintenanceState.status === 'running' ? 'Running Maintenance...' : 'Run Database Maintenance'}
              onPress={() => {
                void handleRunDatabaseMaintenance();
              }}
              disabled={maintenanceDisabled}
              tone="secondary"
            />
          </View>

          <Text
            style={[
              styles.roadmapText,
              maintenanceState.status === 'error' ? styles.errorText : null,
            ]}>
            {db ? maintenanceState.message : 'Local database maintenance is only available when the app is running with the local SQLite provider.'}
          </Text>
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
  successText: {
    color: colors.success,
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
