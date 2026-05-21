import { useGraphQLHistoryOverview, useGraphQLTodayOverview } from '@/hooks/useGraphQLDashboardOverview';
import { useGraphQLDerivedRefreshState } from '@/hooks/useGraphQLDerivedRefreshState';
import { useGraphQLHeartHistory } from '@/hooks/useGraphQLHeartHistory';
import { useGraphQLSleepHistory } from '@/hooks/useGraphQLSleepHistory';
import { useGraphQLTrendData } from '@/hooks/useGraphQLTrendData';
import { useGraphQLWellnessData } from '@/hooks/useGraphQLWellnessData';
import { useHealthDataVersion } from '@/providers/HealthDataProvider';
import type { HistoryRange } from '@/types/health';

export function useHistoryOverview(dayKey: string) {
  const version = useHealthDataVersion('dashboard');
  return useGraphQLHistoryOverview(dayKey, version);
}

export function useTodayOverview() {
  const version = useHealthDataVersion('dashboard');
  return useGraphQLTodayOverview(version);
}

export function useSleepHistory(range: HistoryRange) {
  const version = useHealthDataVersion('sleep');
  return useGraphQLSleepHistory(range, version);
}

export function useHeartHistory(range: HistoryRange) {
  const version = useHealthDataVersion('heart');
  return useGraphQLHeartHistory(range, version);
}

export function useWellnessData(range: HistoryRange) {
  const version = useHealthDataVersion('wellness');
  return useGraphQLWellnessData(range, version);
}

export function useDerivedRefreshState() {
  return useGraphQLDerivedRefreshState();
}

export function useTrendData(range: HistoryRange) {
  const version = useHealthDataVersion('trends');
  return useGraphQLTrendData(range, version);
}
