export type HistoryRange = '24h' | '7d' | '14d' | '30d';
export type AccentTone = 'green' | 'cyan' | 'alert' | 'heart' | 'violet';
export type MetricTone = 'good' | 'caution' | 'alert' | 'neutral';
export type SleepStage = 'awake' | 'rem' | 'deep' | 'light';
export type ActivitySource = 'detected' | 'manual';
export type ActivityReviewState = 'none' | 'confirmed' | 'relabelled' | 'dismissed';
export type PartialDataReason = string;
export type DerivedRefreshStatus = 'idle' | 'pending' | 'processing' | 'error';

export interface TrendPoint {
  label: string;
  value: number | null;
}

export interface TrendSelection {
  index: number;
  point: TrendPoint;
}

export interface SleepStageSegment {
  stage: SleepStage;
  minutes: number;
}

export interface SleepStageSelection {
  index: number;
  segment: SleepStageSegment;
  startMinute: number;
  endMinute: number;
}

export interface EstimatedValueMeta {
  isEstimated?: boolean;
  missingReason?: PartialDataReason | null;
}

export interface RecoveryBreakdown {
  sleepScore: number | null;
  hrvComponent: number | null;
  rhrComponent: number | null;
  stressComponent: number | null;
  tempComponent: number | null;
}

export interface RecoverySnapshot extends EstimatedValueMeta {
  score: number | null;
  label: string;
  caption: string;
  breakdown?: RecoveryBreakdown | null;
}

export interface SummaryStat extends EstimatedValueMeta {
  label: string;
  value: string;
  accent: AccentTone;
}

export interface HeartCardSnapshot extends EstimatedValueMeta {
  restingHr: number | null;
  averageHr: number | null;
  maxHr: number | null;
  series: TrendPoint[];
  markers: HeartIntradayMarker[];
}

export interface SleepCardSnapshot extends EstimatedValueMeta {
  score: number | null;
  durationMinutes: number | null;
  timeInBedMinutes: number | null;
  stages: SleepStageSegment[];
  startLabel: string;
  middleLabel: string;
  endLabel: string;
}

export interface StrainCardSnapshot extends EstimatedValueMeta {
  score: number | null;
  label: string;
  series: TrendPoint[];
}

export interface DashboardDayOption {
  dayKey: string;
  shortLabel: string;
  longLabel: string;
}

export interface DashboardDayState {
  dayKey: string;
  shortLabel: string;
  longLabel: string;
  isToday: boolean;
  olderDayKey: string | null;
  olderDayLabel: string | null;
  newerDayKey: string | null;
  newerDayLabel: string | null;
  availableDays: DashboardDayOption[];
}

export interface DashboardInsight {
  id: string;
  title: string;
  detail: string;
  accent: AccentTone;
}

export interface DashboardSnapshot {
  layoutVersion?: number;
  greeting: string;
  dateLabel: string;
  day: DashboardDayState;
  recovery: RecoverySnapshot;
  tonightPlan: SleepPlanSnapshot;
  summaryStats: SummaryStat[];
  heartCard: HeartCardSnapshot;
  sleepCard: SleepCardSnapshot;
  strainCard: StrainCardSnapshot;
  hrvCard: MetricSeries;
  stressCard: MetricSeries;
  spo2Card: MetricSeries;
  skinTemperatureCard: MetricSeries;
  activitySummary: ActivitySummary[];
  insights: DashboardInsight[];
  lastSyncLabel?: string | null;
}

export interface SleepSession extends EstimatedValueMeta {
  id: string;
  dateLabel: string;
  score: number | null;
  bedtime: string;
  wakeTime: string;
  durationMinutes: number;
  timeInBedMinutes: number;
  efficiency: number | null;
  remMinutes: number;
  deepMinutes: number;
  consistency: number | null;
  stages: SleepStageSegment[];
  minBpm?: number | null;
  maxBpm?: number | null;
  avgHrv?: number | null;
}

export interface SleepPlanSnapshot {
  targetWakeMinutes: number;
  targetWakeTime: string;
  optimalBedtimeMinutes: number;
  optimalBedtime: string;
  sleepNeedMinutes: number;
  sleepDebtMinutes: number;
  napCreditMinutes: number;
  alarmEnabled: boolean;
}

export interface SleepHistorySnapshot extends EstimatedValueMeta {
  headlineScore: number | null;
  headlineLabel: string;
  bedtime: string;
  wakeTime: string;
  durationMinutes: number | null;
  timeInBedMinutes: number | null;
  bedtimeConsistency: number | null;
  wakeConsistency: number | null;
  scoreTrend: TrendPoint[];
  durationTrend: TrendPoint[];
  sessions: SleepSession[];
  sleepPlan: SleepPlanSnapshot;
}

export interface HeartHistorySnapshot extends EstimatedValueMeta {
  restingHr: number | null;
  averageHr: number | null;
  maxHr: number | null;
  intraday: TrendPoint[];
  intradayMarkers: HeartIntradayMarker[];
  weeklyResting: TrendPoint[];
  recoveryShift: number | null;
}

export interface MetricSeries extends EstimatedValueMeta {
  title: string;
  latest: number | null;
  average: number | null;
  delta: number | null;
  unit: string;
  detail: string;
  accent: AccentTone;
  series: TrendPoint[];
  hasPartialData?: boolean;
}

export interface ActivitySummary extends EstimatedValueMeta {
  id: string;
  title: string;
  timeLabel: string;
  durationMinutes: number;
  strain: number | null;
  calories: number | null;
  confidence?: number | null;
  source?: ActivitySource;
  reviewState?: ActivityReviewState;
  strainLabel?: string;
  caloriesLabel?: string;
}

export type HeartIntradayMarkerKind = 'sleep' | 'nap' | 'activity';

export interface HeartIntradayMarkerDetails {
  durationMinutes: number | null;
  score?: number | null;
  asleepMinutes?: number | null;
  timeInBedMinutes?: number | null;
  remMinutes?: number | null;
  deepMinutes?: number | null;
  stages?: SleepStageSegment[];
}

export interface HeartIntradayMarker {
  id: string;
  kind: HeartIntradayMarkerKind;
  label: string;
  timeLabel: string;
  startFraction: number;
  endFraction: number;
  details?: HeartIntradayMarkerDetails;
}

export interface WellnessSnapshot extends EstimatedValueMeta {
  stress: MetricSeries;
  spo2: MetricSeries;
  skinTemperature: MetricSeries;
  recoveryIndex: MetricSeries;
  activities: ActivitySummary[];
}

export type TrendMetricId =
  | 'recovery'
  | 'hrv'
  | 'restingHr'
  | 'sleepScore'
  | 'sleepDuration'
  | 'sleepConsistency'
  | 'stress'
  | 'skinTemperatureDeviation';

export interface TrendMetricSnapshot extends MetricSeries {
  id: TrendMetricId;
}

export interface TrendSnapshot extends EstimatedValueMeta {
  range: HistoryRange;
  latestLabel: string;
  primaryMetrics: TrendMetricSnapshot[];
  secondaryMetrics: TrendMetricSnapshot[];
}

export interface DerivedRefreshState {
  status: DerivedRefreshStatus;
  pendingFromTime: string | null;
  pendingToTime: string | null;
  lastProcessedFromTime: string | null;
  lastProcessedToTime: string | null;
  lastError: string | null;
  isFirstSync: boolean;
}
