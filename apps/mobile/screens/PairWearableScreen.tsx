import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ScreenShell } from '@/components/layout/ScreenShell';
import { SectionHeader } from '@/components/layout/SectionHeader';
import { GlassCard } from '@/components/ui/GlassCard';
import { colors, typography } from '@/constants/theme';
import { useWearableSync } from '@/providers/WearableSyncProvider';
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
  const { progress, scanResults, scan, pairDevice } = useWearableSync();
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
        ? 'Choose the wearable you want this phone to use.'
        : 'No wearable found yet. Keep the strap awake and scan again.'
      : progress.message;

  return (
    <ScreenShell>
      <View>
        <SectionHeader title="Pair Wearable" trailing={progress.status === 'scanning' ? 'Scanning' : 'Required'} />
        <Text style={styles.subtitle}>
          Pick the strap you want to pair with this phone before using the app.
        </Text>
      </View>

      <GlassCard accentColor={colors.primary}>
        <View style={styles.heroRow}>
          <View style={styles.heroBadge}>
            <Ionicons color={colors.primary} name="bluetooth" size={24} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>Searching for your wearable</Text>
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
    backgroundColor: 'rgba(90, 200, 255, 0.14)',
    borderRadius: 18,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  heroCopy: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    color: colors.text,
    fontFamily: typography.bodySemiBold,
    fontSize: 17,
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
