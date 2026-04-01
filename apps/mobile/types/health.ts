export type HistoryRange = '24h' | '7d' | '14d' | '30d';
export type AccentTone = 'green' | 'cyan' | 'alert' | 'heart' | 'violet';
export type SleepStage = 'awake' | 'rem' | 'deep' | 'light';

export interface TrendPoint {
  label: string;
  value: number;
}

export interface SleepStageSegment {
  stage: SleepStage;
  minutes: number;
}

export interface RecoverySnapshot {
  score: number;
  label: string;
  caption: string;
}

export interface SummaryStat {
  label: string;
  value: string;
  accent: AccentTone;
}

export interface HeartCardSnapshot {
  restingHr: number;
  averageHr: number;
  maxHr: number;
  series: TrendPoint[];
}

export interface SleepCardSnapshot {
  score: number;
  durationMinutes: number;
  stages: SleepStageSegment[];
  startLabel: string;
  middleLabel: string;
  endLabel: string;
}

export interface StrainCardSnapshot {
  score: number;
  label: string;
  series: TrendPoint[];
}

export interface DashboardSnapshot {
  greeting: string;
  dateLabel: string;
  recovery: RecoverySnapshot;
  summaryStats: SummaryStat[];
  heartCard: HeartCardSnapshot;
  sleepCard: SleepCardSnapshot;
  strainCard: StrainCardSnapshot;
}

export interface SleepSession {
  id: string;
  dateLabel: string;
  score: number;
  bedtime: string;
  wakeTime: string;
  durationMinutes: number;
  efficiency: number;
  remMinutes: number;
  deepMinutes: number;
  consistency: number;
  stages: SleepStageSegment[];
}

export interface SleepHistorySnapshot {
  headlineScore: number;
  headlineLabel: string;
  bedtime: string;
  wakeTime: string;
  durationMinutes: number;
  bedtimeConsistency: number;
  wakeConsistency: number;
  scoreTrend: TrendPoint[];
  durationTrend: TrendPoint[];
  sessions: SleepSession[];
}

export interface HeartHistorySnapshot {
  restingHr: number;
  averageHr: number;
  maxHr: number;
  intraday: TrendPoint[];
  weeklyResting: TrendPoint[];
  recoveryShift: number;
}

export interface MetricSeries {
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

export interface ActivitySummary {
  id: string;
  title: string;
  timeLabel: string;
  durationMinutes: number;
  strain: number;
  calories: number;
}

export interface WellnessSnapshot {
  stress: MetricSeries;
  spo2: MetricSeries;
  skinTemperature: MetricSeries;
  recoveryIndex: MetricSeries;
  activities: ActivitySummary[];
}
