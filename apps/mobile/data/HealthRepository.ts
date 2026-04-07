import type {
  DerivedRefreshState,
  DashboardSnapshot,
  HeartCardSnapshot,
  HeartHistorySnapshot,
  HistoryRange,
  SleepHistorySnapshot,
  TrendSnapshot,
  WellnessSnapshot,
} from '@/types/health';

export type HealthCacheScope = 'all' | 'sleep' | 'heart' | 'dashboard' | 'wellness' | 'trends' | 'derived';
export type HealthRefreshScope = Exclude<HealthCacheScope, 'all'> | 'all';

export interface HealthRepository {
  primeDashboardSnapshot(): Promise<boolean>;
  refreshDashboardSnapshot(mode: 'full' | 'post_sync_heart_only'): Promise<boolean>;
  getDashboardSnapshot(dayKey?: string): Promise<DashboardSnapshot>;
  getDashboardHeartTimeline(range: HistoryRange): Promise<HeartCardSnapshot>;
  getSleepHistory(range: HistoryRange): Promise<SleepHistorySnapshot>;
  getHeartHistory(range: HistoryRange): Promise<HeartHistorySnapshot>;
  getWellnessSnapshot(range: HistoryRange): Promise<WellnessSnapshot>;
  getTrendSnapshot(range: HistoryRange): Promise<TrendSnapshot>;
  getDerivedRefreshState(): Promise<DerivedRefreshState>;
  processPendingDerivedRefresh(): Promise<boolean>;
  invalidateCaches(scope?: HealthCacheScope | readonly HealthCacheScope[]): void;
  setTargetWakeMinutes(minutes: number): Promise<void>;
  enableAlarm(targetWakeMinutes: number): Promise<void>;
  disableAlarm(targetWakeMinutes: number): Promise<void>;
}
