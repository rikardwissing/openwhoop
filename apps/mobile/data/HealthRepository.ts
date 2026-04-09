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
export type ManualActivityKind = 'Activity' | 'Walk' | 'Workout' | 'Nap';

export interface ActivityRescanResult {
  removedUnconfirmedActivities: number;
}

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
  rescanActivities(): Promise<ActivityRescanResult>;
  createManualActivity(activity: ManualActivityKind, start: Date, end: Date): Promise<string>;
  updateActivity(activityId: string, activity: ManualActivityKind, start: Date, end: Date): Promise<void>;
  confirmActivity(activityId: string): Promise<void>;
  dismissActivity(activityId: string): Promise<void>;
  relabelActivity(activityId: string, activity: ManualActivityKind): Promise<void>;
  invalidateCaches(scope?: HealthCacheScope | readonly HealthCacheScope[]): void;
  setTargetWakeMinutes(minutes: number): Promise<void>;
  enableAlarm(targetWakeMinutes: number): Promise<void>;
  disableAlarm(targetWakeMinutes: number): Promise<void>;
}
