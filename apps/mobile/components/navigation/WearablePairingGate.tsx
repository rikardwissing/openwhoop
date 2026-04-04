import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';

import { useWearableSyncProgress, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { isBlockingSyncStatus } from '@/types/device';

export function WearablePairingGate() {
  const router = useRouter();
  const segments = useSegments();
  const { isReady, deviceState } = useWearableSyncState();
  const { progress } = useWearableSyncProgress();
  const onPairWearableRoute = segments[0] === 'pair-wearable';
  const pairingBusy = progress.status === 'scanning' || isBlockingSyncStatus(progress.status);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (!deviceState.id) {
      if (!onPairWearableRoute) {
        router.replace('/pair-wearable');
      }
      return;
    }

    if (onPairWearableRoute && !pairingBusy) {
      router.replace('/');
    }
  }, [deviceState.id, isReady, onPairWearableRoute, pairingBusy, router]);

  return null;
}
