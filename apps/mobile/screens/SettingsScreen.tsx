import { Image, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { StatChip } from '@/components/ui/StatChip';
import { appIcon } from '@/constants/assets';
import { colors, typography } from '@/constants/theme';
import { useWearableSync } from '@/providers/WearableSyncProvider';
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

export function SettingsScreen() {
  const { deviceState, progress, scanResults, scan, selectDevice, forgetDevice, syncSelected } = useWearableSync();
  const deviceBusy = isBlockingSyncStatus(progress.status);
  const batteryChipAccent = batteryAccent(deviceState.batteryPercent);
  const chargingChipAccent = chargingAccent(deviceState.chargingStatus);
  const wearChipAccent = wearAccent(deviceState.bodyStatus);

  return (
    <ScreenShell>
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
              {deviceState.id ?? 'Scan for nearby devices, select one, then run a manual sync.'}
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
              label={progress.status === 'scanning' ? 'Scanning...' : 'Scan nearby'}
              onPress={() => {
                void scan();
              }}
              disabled={progress.status === 'scanning' || deviceBusy}
              tone="secondary"
            />
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
              label="Forget wearable"
              onPress={() => {
                void forgetDevice();
              }}
              disabled={!deviceState.id}
              tone="danger"
            />
          </View>
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Scan Results" trailing={`${scanResults.length} found`} />
        {scanResults.length > 0 ? (
          scanResults.map((device, index) => (
            <View key={device.id} style={[styles.deviceRow, index < scanResults.length - 1 ? styles.divider : null]}>
              <View style={styles.deviceText}>
                <Text style={styles.settingTitle}>{device.name}</Text>
                <Text style={styles.settingSubtitle}>
                  {device.id} · RSSI {device.rssi ?? '--'}
                </Text>
              </View>
              <ActionButton
                label={deviceState.id === device.id ? 'Selected' : 'Use'}
                onPress={() => {
                  void selectDevice(device);
                }}
                disabled={deviceState.id === device.id}
                tone="secondary"
              />
            </View>
          ))
        ) : (
          <Text style={styles.roadmapText}>No scanned devices yet. Use the scan button above on a physical iPhone development build.</Text>
        )}
      </GlassCard>

      <GlassCard accentColor={colors.aqua}>
        <SectionHeader title="Local Sync Status" trailing={progress.status} />
        <Text style={styles.roadmapText}>{progress.message}</Text>
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
