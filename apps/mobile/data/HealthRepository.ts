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
import type { AlarmSettingsInput } from '@/utils/sleepPlan';

export type HealthDataScope = 'all' | 'sleep' | 'heart' | 'dashboard' | 'wellness' | 'trends' | 'derived';
export type HealthRefreshScope = Exclude<HealthDataScope, 'all'> | 'all';
export type ManualActivityKind = 'Activity' | 'Walk' | 'Workout' | 'Running' | 'Nap';

export interface ActivityRescanResult {
  removedUnconfirmedActivities: number;
}

export interface ActiveActivity {
  id: string;
  activity: ManualActivityKind;
  start: Date;
  elapsedMinutes: number;
}

export interface ActiveActivityFinishSummary {
  id: string;
  activity: ManualActivityKind;
  start: Date;
  end: Date;
  durationMinutes: number;
  averageHr: number | null;
  maxHr: number | null;
  strain: number | null;
  calories: number | null;
}

export interface HealthRepository {
  getTodayOverview(): Promise<TodayOverview>;
  getHistoryOverview(dayKey: string): Promise<HistoryOverview>;
  getDashboardHeartTimelineWindow(range: HistoryRange): Promise<HeartTimelineWindow>;
  getDashboardHeartTimeline(range: HistoryRange): Promise<HeartCardData>;
  getFocusedHeartDetail(marker: HeartIntradayMarker): Promise<FocusedHeartDetail>;
  getSleepHistory(range: HistoryRange): Promise<SleepHistoryData>;
  getHeartHistory(range: HistoryRange): Promise<HeartHistoryData>;
  getWellnessData(range: HistoryRange): Promise<WellnessData>;
  getTrendData(range: HistoryRange): Promise<TrendData>;
  getDerivedRefreshState(): Promise<DerivedRefreshState>;
  processPendingDerivedRefresh(): Promise<boolean>;
  rescanActivities(): Promise<ActivityRescanResult>;
  getActiveActivity(): Promise<ActiveActivity | null>;
  startActiveActivity(activity: ManualActivityKind, start: Date): Promise<ActiveActivity>;
  finishActiveActivity(end: Date): Promise<ActiveActivityFinishSummary | null>;
  cancelActiveActivity(): Promise<void>;
  createManualActivity(activity: ManualActivityKind, start: Date, end: Date): Promise<string>;
  createManualSleep(start: Date, end: Date): Promise<string>;
  updateActivity(activityId: string, activity: ManualActivityKind, start: Date, end: Date): Promise<void>;
  updateSleep(sleepId: string, start: Date, end: Date): Promise<void>;
  confirmActivity(activityId: string): Promise<void>;
  dismissActivity(activityId: string): Promise<void>;
  relabelActivity(activityId: string, activity: ManualActivityKind): Promise<void>;
  setTargetWakeMinutes(minutes: number): Promise<void>;
  enableAlarm(settings: AlarmSettingsInput): Promise<void>;
  disableAlarm(targetWakeMinutes: number): Promise<void>;
}
