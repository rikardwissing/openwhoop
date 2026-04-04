import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { brandMark } from '@/constants/assets';
import { brand } from '@/constants/brand';
import { colors, typography } from '@/constants/theme';
import { useWearableScanResults, useWearableSyncActions, useWearableSyncProgress, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { isBlockingSyncStatus, type WearableScanResult } from '@/types/device';

function ActionButton({
  label,
  onPress,
  disabled,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'secondary';
}) {
  const accent = tone === 'secondary' ? 'rgba(124, 139, 176, 0.18)' : colors.primary;

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

export function PairWearableScreen() {
  const { deviceState } = useWearableSyncState();
  const { progress } = useWearableSyncProgress();
  const { scanResults } = useWearableScanResults();
  const { scan, pairDevice } = useWearableSyncActions();
  const startedScanRef = useRef(false);
  const [selectingDeviceId, setSelectingDeviceId] = useState<string | null>(null);
  const deviceBusy = progress.status === 'scanning' || isBlockingSyncStatus(progress.status) || selectingDeviceId !== null;

  useEffect(() => {
    if (startedScanRef.current) {
      return;
    }

    startedScanRef.current = true;
    void scan();
  }, [scan]);

  async function handleSelectDevice(device: WearableScanResult) {
    if (deviceBusy) {
      return;
    }

    setSelectingDeviceId(device.id);
    try {
      await pairDevice(device);
    } finally {
      setSelectingDeviceId(null);
    }
  }

  const statusMessage =
    progress.status === 'idle' || progress.status === 'complete'
      ? scanResults.length > 0
        ? 'Choose the wearable you want this phone to unlock and sync locally.'
        : 'No wearable found yet. Keep the strap awake and scan again.'
      : progress.message;

  return (
    <ScreenShell headerIcon="pair" headerSettingsDisabled={!deviceState.id} headerTitle="Pair Wearable">
      <View>
        <Text style={styles.subtitle}>
          Pair the strap you want this phone to own. After the first successful sync, Unstrap keeps your wearable insights local and can refresh in the background on iPhone.
        </Text>
      </View>

      <GlassCard accentColor={colors.primary}>
        <View style={styles.heroRow}>
          <View style={styles.heroBadge}>
            <Image resizeMode="contain" source={brandMark} style={styles.heroLogo} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroEyebrow}>{brand.pairingEyebrow}</Text>
            <Text style={styles.heroTitle}>{brand.pairingTitle}</Text>
            <Text style={[styles.heroBody, progress.status === 'error' ? styles.errorText : null]}>
              {progress.status === 'error' ? progress.message : statusMessage}
            </Text>
          </View>
        </View>

        <View style={styles.buttonRow}>
          <ActionButton
            label={progress.status === 'scanning' ? 'Scanning...' : 'Scan again'}
            onPress={() => {
              void scan();
            }}
            disabled={deviceBusy}
            tone="secondary"
          />
        </View>
      </GlassCard>

      <GlassCard accentColor={colors.cyan}>
        <SectionHeader title="Nearby Wearables" trailing={`${scanResults.length} found`} />
        {scanResults.length > 0 ? (
          scanResults.map((device, index) => (
            <View key={device.id} style={[styles.deviceRow, index < scanResults.length - 1 ? styles.deviceDivider : null]}>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text style={styles.deviceMeta}>
                  {device.id} · RSSI {device.rssi ?? '--'}
                </Text>
              </View>
              <ActionButton
                label={selectingDeviceId === device.id ? 'Pairing...' : 'Pair'}
                onPress={() => {
                  void handleSelectDevice(device);
                }}
                disabled={deviceBusy}
              />
            </View>
          ))
        ) : (
          <Text style={styles.emptyState}>
            {progress.status === 'scanning'
              ? 'Scanning for nearby wearables now...'
              : 'No live scan results yet. Make sure the wearable is awake and close to the phone.'}
          </Text>
        )}
      </GlassCard>

      <GlassCard accentColor={colors.violet}>
        <SectionHeader title="Background Sync Notes" trailing="iPhone v1" />
        <Text style={styles.emptyState}>
          Keep the official wearable app closed while Unstrap is paired to this strap. If both apps sync the same device, they can compete for the same history and create gaps in your unlocked data.
        </Text>
      </GlassCard>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 6,
  },
  heroRow: {
    flexDirection: 'row',
    gap: 14,
  },
  heroBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(8, 18, 25, 0.94)',
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  heroLogo: {
    height: 44,
    width: 44,
  },
  heroCopy: {
    flex: 1,
    gap: 4,
  },
  heroEyebrow: {
    color: colors.primaryBright,
    fontFamily: typography.bodyBold,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 19,
  },
  heroBody: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 14,
    lineHeight: 22,
  },
  errorText: {
    color: colors.alert,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
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
  deviceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  deviceDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  deviceCopy: {
    flex: 1,
  },
  deviceName: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 15,
  },
  deviceMeta: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 12,
    marginTop: 4,
  },
  emptyState: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 15,
    lineHeight: 24,
  },
});
