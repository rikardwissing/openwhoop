import type {
  DashboardSnapshot,
  HeartHistorySnapshot,
  HistoryRange,
  SleepHistorySnapshot,
  WellnessSnapshot,
} from '@/types/health';

export type HealthCacheScope = 'all' | 'sleep' | 'heart' | 'dashboard' | 'wellness';

export interface HealthRepository {
  getDashboardSnapshot(): Promise<DashboardSnapshot>;
  getSleepHistory(range: HistoryRange): Promise<SleepHistorySnapshot>;
  getHeartHistory(range: HistoryRange): Promise<HeartHistorySnapshot>;
  getWellnessSnapshot(range: HistoryRange): Promise<WellnessSnapshot>;
  warmCaches(): Promise<void>;
  invalidateCaches(scope?: HealthCacheScope): void;
  setTargetWakeMinutes(minutes: number): Promise<void>;
  enableAlarm(targetWakeMinutes: number): Promise<void>;
  disableAlarm(targetWakeMinutes: number): Promise<void>;
}
