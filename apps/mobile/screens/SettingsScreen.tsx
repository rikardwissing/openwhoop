import { useState } from 'react';
import { Image, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { appIcon } from '@/constants/assets';
import { colors, typography } from '@/constants/theme';
import { useWearableRefreshControl } from '@/hooks/useWearableRefreshControl';
import { useOptionalAppDatabase } from '@/providers/AppDatabaseProvider';
import { useWearableSync } from '@/providers/WearableSyncProvider';
import { exportAndShareDatabaseSnapshot } from '@/services/databaseExport';
import { describeBatteryStatus, describeChargingState, describeWearState, isBlockingSyncStatus } from '@/types/device';

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

export function SettingsScreen() {
  const router = useRouter();
  const db = useOptionalAppDatabase();
  const { backgroundSyncState, deviceState, liveEvents, progress, forgetDevice, syncSelected, restartDevice } = useWearableSync();
  const { onRefresh, refreshing } = useWearableRefreshControl();
  const [exportState, setExportState] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message: string;
  }>({
    status: 'idle',
    message: 'Create a portable btwearable.db snapshot and share it straight from the phone.',
  });
  const deviceBusy = isBlockingSyncStatus(progress.status);
  const batteryChipAccent = batteryAccent(deviceState.batteryPercent);
  const chargingChipAccent = chargingAccent(deviceState.chargingStatus);
  const wearChipAccent = wearAccent(deviceState.bodyStatus);
  const exportDisabled = deviceBusy || exportState.status === 'running' || !db;

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
      message: 'Preparing a fresh btwearable.db snapshot...',
    });

    try {
      const result = await exportAndShareDatabaseSnapshot(db);
      setExportState({
        status: 'success',
        message: `Prepared ${result.fileName} (${formatBytes(result.sizeBytes)}). Save or send that file back here and I can inspect the raw data directly.`,
      });
    } catch (error) {
      setExportState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unable to export the local database.',
      });
    }
  }

  return (
    <ScreenShell onRefresh={onRefresh} refreshing={refreshing}>
      <View>
        <SectionHeader title="Settings" trailing="Manual sync" />
        <Text style={styles.subtitle}>Local-only device sync and the offline data store that powers every tab.</Text>
      </View>

      <GlassCard accentColor={colors.primary}>
        <View style={styles.profileRow}>
          <Image source={appIcon} style={styles.profileIcon} />
          <View style={styles.profileText}>
            <Text style={styles.profileTitle}>BtWearable</Text>
            <Text style={styles.profileSubtitle}>SQLite + BLE development build</Text>
          </View>
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.cyan}>
        <SectionHeader title="Appearance" trailing="Locked for v1" />
        <View style={styles.settingRow}>
          <View>
            <Text style={styles.settingTitle}>Dark theme</Text>
            <Text style={styles.settingSubtitle}>This build stays in the neon dark mode you approved.</Text>
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

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Background Sync" trailing={deviceState.id ? 'Auto after pairing' : 'Inactive'} />
        <View style={styles.settingColumn}>
          <View style={styles.chipWrap}>
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
              label="Last run"
              value={backgroundSyncState.lastRunFinishedAt ?? 'Not yet'}
            />
            <StatChip
              accent={
                backgroundSyncState.lastResult === 'error'
                  ? colors.alert
                  : backgroundSyncState.lastResult === 'success'
                    ? colors.success
                    : colors.borderStrong
              }
              label="Last result"
              value={describeBackgroundResult(backgroundSyncState.lastResult)}
            />
          </View>

          <Text style={styles.roadmapText}>
            Background sync is best effort on iPhone while the app stays in the background or suspended. If you force-quit the app from the app switcher, iOS stops relaunching it for this work until you open it again.
          </Text>
          <Text style={styles.roadmapText}>
            Keep the official wearable app closed while BtWearable owns the strap. Two apps syncing the same device can race each other and create gaps.
          </Text>
          {backgroundSyncState.lastError ? <Text style={styles.errorText}>{backgroundSyncState.lastError}</Text> : null}
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.primary}>
        <SectionHeader title="Export for Analysis" trailing="SQLite snapshot" />
        <View style={styles.settingColumn}>
          <View>
            <Text style={styles.settingTitle}>Raw database export</Text>
            <Text style={styles.settingSubtitle}>
              Generates a shareable copy of btwearable.db so you can send the exact phone data back for analysis.
            </Text>
          </View>

          <View style={styles.buttonRow}>
            <ActionButton
              label={exportState.status === 'running' ? 'Exporting...' : 'Export Database'}
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
  profileIcon: {
    height: 56,
    width: 56,
  },
  profileText: {
    flex: 1,
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
