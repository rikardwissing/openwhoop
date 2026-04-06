import { startTransition, useEffect, useState } from 'react';

import type {
  DashboardSnapshot,
  DerivedRefreshState,
  HeartHistorySnapshot,
  HistoryRange,
  SleepHistorySnapshot,
  TrendSnapshot,
  WellnessSnapshot,
} from '@/types/health';
import { useHealthDataVersion, useHealthRepository } from '@/providers/HealthDataProvider';
import type { HealthRepository } from '@/data/HealthRepository';

type AsyncState<T> =
  | { status: 'loading'; data: T | null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: Error };

const repositoryCache = new WeakMap<HealthRepository, Map<string, unknown>>();

function readCachedValue<T>(repository: HealthRepository, cacheKey: string) {
  return (repositoryCache.get(repository)?.get(cacheKey) as T | undefined) ?? null;
}

function writeCachedValue<T>(repository: HealthRepository, cacheKey: string, value: T) {
  const existing = repositoryCache.get(repository);

  if (existing) {
    existing.set(cacheKey, value);
    return;
  }

  repositoryCache.set(repository, new Map([[cacheKey, value]]));
}

function useAsyncValue<T>(
  repository: HealthRepository,
  cacheKey: string,
  factory: () => Promise<T>,
  deps: Array<unknown>,
) {
  const [state, setState] = useState<AsyncState<T>>(() => {
    const cached = readCachedValue<T>(repository, cacheKey);
    return cached === null
      ? { status: 'loading', data: null, error: null }
      : { status: 'ready', data: cached, error: null };
  });

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({
      status: 'loading',
      data: current.data ?? readCachedValue<T>(repository, cacheKey),
      error: null,
    }));

    factory()
      .then((data) => {
        if (cancelled) {
          return;
        }

        writeCachedValue(repository, cacheKey, data);
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

export function useDashboardSnapshot(dayKey?: string) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('dashboard');
  return useAsyncValue<DashboardSnapshot>(
    repository,
    `dashboard:${dayKey ?? 'latest'}`,
    () => repository.getDashboardSnapshot(dayKey),
    [repository, dayKey, version],
  );
}

export function useSleepHistory(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('sleep');
  return useAsyncValue<SleepHistorySnapshot>(
    repository,
    `sleep:${range}`,
    () => repository.getSleepHistory(range),
    [repository, range, version],
  );
}

export function useHeartHistory(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('heart');
  return useAsyncValue<HeartHistorySnapshot>(
    repository,
    `heart:${range}`,
    () => repository.getHeartHistory(range),
    [repository, range, version],
  );
}

export function useWellnessSnapshot(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('wellness');
  return useAsyncValue<WellnessSnapshot>(
    repository,
    `wellness:${range}`,
    () => repository.getWellnessSnapshot(range),
    [repository, range, version],
  );
}

export function useDerivedRefreshState() {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('derived');
  return useAsyncValue<DerivedRefreshState>(
    repository,
    'derived:state',
    () => repository.getDerivedRefreshState(),
    [repository, version],
  );
}

export function useTrendSnapshot(range: HistoryRange) {
  const repository = useHealthRepository();
  const version = useHealthDataVersion('trends');
  return useAsyncValue<TrendSnapshot>(
    repository,
    `trends:${range}`,
    () => repository.getTrendSnapshot(range),
    [repository, range, version],
  );
}
