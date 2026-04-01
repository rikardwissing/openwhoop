import { startTransition, useEffect, useState } from 'react';

import type { DashboardSnapshot, HeartHistorySnapshot, HistoryRange, SleepHistorySnapshot, WellnessSnapshot } from '@/types/health';
import { useHealthRepository } from '@/providers/HealthDataProvider';

type AsyncState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: Error };

function useAsyncValue<T>(factory: () => Promise<T>, deps: Array<unknown>) {
  const [state, setState] = useState<AsyncState<T>>({
    status: 'loading',
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, error: null });

    factory()
      .then((data) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setState({ status: 'ready', data, error: null });
        });
      })
      .catch((error: Error) => {
        if (cancelled) {
          return;
        }

        setState({ status: 'error', data: null, error });
      });

    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

export function useDashboardSnapshot() {
  const repository = useHealthRepository();
  return useAsyncValue<DashboardSnapshot>(() => repository.getDashboardSnapshot(), [repository]);
}

export function useSleepHistory(range: HistoryRange) {
  const repository = useHealthRepository();
  return useAsyncValue<SleepHistorySnapshot>(() => repository.getSleepHistory(range), [repository, range]);
}

export function useHeartHistory(range: HistoryRange) {
  const repository = useHealthRepository();
  return useAsyncValue<HeartHistorySnapshot>(() => repository.getHeartHistory(range), [repository, range]);
}

export function useWellnessSnapshot(range: HistoryRange) {
  const repository = useHealthRepository();
  return useAsyncValue<WellnessSnapshot>(() => repository.getWellnessSnapshot(range), [repository, range]);
}
