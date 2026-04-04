import { useCallback } from 'react';

import { useWearableSyncActions, useWearableSyncProgress, useWearableSyncState } from '@/providers/WearableSyncProvider';
import { isBlockingSyncStatus } from '@/types/device';

export function useWearableRefreshControl() {
  const { deviceState } = useWearableSyncState();
  const { progress } = useWearableSyncProgress();
  const { syncSelected } = useWearableSyncActions();
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
