import { useCallback } from 'react';

import { useWearableSync } from '@/providers/WearableSyncProvider';
import { isBlockingSyncStatus } from '@/types/device';

export function useWearableRefreshControl() {
  const { deviceState, progress, syncSelected } = useWearableSync();
  const refreshing = progress.status === 'scanning' || isBlockingSyncStatus(progress.status);
  const canRefresh = Boolean(deviceState.id);

  const onRefresh = useCallback(() => {
    if (!canRefresh || refreshing) {
      return;
    }

    void syncSelected({ showOverlay: false });
  }, [canRefresh, refreshing, syncSelected]);

  return {
    canRefresh,
    onRefresh: canRefresh ? onRefresh : undefined,
    refreshing,
  };
}
