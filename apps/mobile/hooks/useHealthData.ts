import { startTransition, useEffect, useState } from 'react';

import type {
  DerivedRefreshState,
  HeartHistoryData,
  HistoryOverview,
  HistoryRange,
  SleepHistoryData,
  TodayOverview,
  TrendData,
  WellnessData,
} from '@/types/health';
import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

function useAsyncValue<T>(
  factory: () => Promise<T>,
  deps: Array<unknown>,
) {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: null, error: null });

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

        setState((current) => ({ status: 'error', data: current.data, error }));
      });

    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

export function useHistoryOverview(dayKey: string) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('dashboard');
  return useAsyncValue<HistoryOverview>(
    () => repository.getHistoryOverview(dayKey),
    [repository, dayKey, version],
  );
}

export function useTodayOverview() {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('dashboard');
  return useAsyncValue<TodayOverview>(
    () => repository.getTodayOverview(),
    [repository, version],
  );
}

export function useSleepHistory(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('sleep');
  return useAsyncValue<SleepHistoryData>(
    () => repository.getSleepHistory(range),
    [repository, range, version],
  );
}

export function useHeartHistory(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('heart');
  return useAsyncValue<HeartHistoryData>(
    () => repository.getHeartHistory(range),
    [repository, range, version],
  );
}

export function useWellnessData(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('wellness');
  return useAsyncValue<WellnessData>(
    () => repository.getWellnessData(range),
    [repository, range, version],
  );
}

export function useDerivedRefreshState() {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('derived');
  return useAsyncValue<DerivedRefreshState>(
    () => repository.getDerivedRefreshState(),
    [repository, version],
  );
}

export function useTrendData(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('trends');
  return useAsyncValue<TrendData>(
    () => repository.getTrendData(range),
    [repository, range, version],
  );
}
