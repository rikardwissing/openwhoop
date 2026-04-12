import type {
  DerivedRefreshState,
  FocusedHeartDetail,
  HeartCardData,
  HeartHistoryData,
  HeartIntradayMarker,
  HeartTimelineWindow,
  HistoryOverview,
  HistoryRange,
  SleepHistoryData,
  TodayOverview,
  TrendData,
  WellnessData,
} from '@/types/health';

export type HealthCacheScope = 'all' | 'sleep' | 'heart' | 'dashboard' | 'wellness' | 'trends' | 'derived';
export type HealthRefreshScope = Exclude<HealthCacheScope, 'all'> | 'all';
export type ManualActivityKind = 'Activity' | 'Walk' | 'Workout' | 'Nap';

export interface ActivityRescanResult {
  removedUnconfirmedActivities: number;
}

export interface DashboardHeartTimelineOptions {
  bucketMinutes?: number;
}

export interface HealthRepository {
  getTodayOverview(): Promise<TodayOverview>;
  getHistoryOverview(dayKey: string): Promise<HistoryOverview>;
  getDashboardHeartTimelineWindow(range: HistoryRange): Promise<HeartTimelineWindow>;
  getDashboardHeartTimeline(range: HistoryRange, options?: DashboardHeartTimelineOptions): Promise<HeartCardData>;
  getFocusedHeartDetail(marker: HeartIntradayMarker): Promise<FocusedHeartDetail>;
  getSleepHistory(range: HistoryRange): Promise<SleepHistoryData>;
  getHeartHistory(range: HistoryRange): Promise<HeartHistoryData>;
  getWellnessData(range: HistoryRange): Promise<WellnessData>;
  getTrendData(range: HistoryRange): Promise<TrendData>;
  getDerivedRefreshState(): Promise<DerivedRefreshState>;
  processPendingDerivedRefresh(): Promise<boolean>;
  rescanActivities(): Promise<ActivityRescanResult>;
  createManualActivity(activity: ManualActivityKind, start: Date, end: Date): Promise<string>;
  createManualSleep(start: Date, end: Date): Promise<string>;
  updateActivity(activityId: string, activity: ManualActivityKind, start: Date, end: Date): Promise<void>;
  updateSleep(sleepId: string, start: Date, end: Date): Promise<void>;
  confirmActivity(activityId: string): Promise<void>;
  dismissActivity(activityId: string): Promise<void>;
  relabelActivity(activityId: string, activity: ManualActivityKind): Promise<void>;
  invalidateCaches(scope?: HealthCacheScope | readonly HealthCacheScope[]): void;
  setTargetWakeMinutes(minutes: number): Promise<void>;
  enableAlarm(targetWakeMinutes: number): Promise<void>;
  disableAlarm(targetWakeMinutes: number): Promise<void>;
}
