import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';
import { useWearableSync } from '@/providers/WearableSyncProvider';
import { isBlockingSyncStatus, type SyncStatus } from '@/types/device';

function titleForStatus(status: SyncStatus) {
  switch (status) {
    case 'connecting':
      return 'Connecting to wearable';
    case 'updating':
      return 'Updating wearable';
    case 'refreshing':
      return 'Refreshing local data';
    case 'syncing':
      return 'Syncing wearable';
    default:
      return 'Working';
  }
}

export function WearableProgressOverlay() {
  const { progress } = useWearableSync();

  if (!isBlockingSyncStatus(progress.status)) {
    return null;
  }

  return (
    <View pointerEvents="auto" style={styles.overlay}>
      <View style={styles.card}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.title}>{titleForStatus(progress.status)}</Text>
        <Text style={styles.message}>{progress.message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    backgroundColor: 'rgba(7, 11, 19, 0.66)',
    justifyContent: 'center',
    paddingHorizontal: 24,
    zIndex: 999,
  },
  card: {
    alignItems: 'center',
    backgroundColor: 'rgba(19, 27, 41, 0.96)',
    borderColor: 'rgba(125, 250, 239, 0.18)',
    borderRadius: 24,
    borderWidth: 1,
    maxWidth: 320,
    minWidth: 260,
    paddingHorizontal: 22,
    paddingVertical: 24,
  },
  title: {
    color: colors.text,
    fontFamily: typography.headingMedium,
    fontSize: 20,
    marginTop: 14,
    textAlign: 'center',
  },
  message: {
    color: colors.muted,
    fontFamily: typography.body,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
    textAlign: 'center',
  },
});
